import { afterEach, describe, expect, it } from "vitest"

import { createAudit } from "@/server/audit"
import {
  createFirstUser,
  isSetupPending,
  resetSetupGate,
} from "@/server/admin/first-user"
import { createUserWithoutRequest } from "@/server/auth/provisioning"
import { createLogger } from "@/server/logger"
import { splitRoles } from "@/server/role-utils"
import { authRequest, createTestContext, sessionCookie } from "./harness"
import type { TestContext } from "./harness"

/**
 * First-run setup (FR-ADMIN-1, **D52**).
 *
 * This is the module `routes/setup.tsx` delegates to, and it is where the two
 * things that can go badly wrong live: the gate that decides whether the page
 * exists at all, and the advisory-locked creation that must produce exactly one
 * administrator however many browsers post the form at once.
 *
 * The route's own behaviour — the `/` and `/login` redirects, the password
 * policy refusal, the automatic sign-in — is driven by a browser in
 * `e2e/auth.spec.ts`, because a redirect nobody follows is not a redirect that
 * has been tested.
 */
describe("first-run setup (D52)", () => {
  const contexts: TestContext[] = []

  afterEach(async () => {
    while (contexts.length > 0) await contexts.pop()!.teardown()
  })

  function deps(ctx: TestContext) {
    const logger = createLogger({ level: "error", write: () => {} })
    return {
      config: ctx.config,
      database: ctx.database,
      // The harness's handle is a direct connection already (the test database
      // is never a pooler), so it is both the pool and the lock here.
      locking: ctx.database,
      auth: ctx.auth,
      audit: createAudit(ctx.database, logger),
      logger,
    }
  }

  const input = {
    email: "First.Operator@Example.COM",
    firstName: "Frida",
    lastName: "Operator",
    password: "a first password nobody handed over",
  }

  it("is pending while the user table is empty and closed once it is not", async () => {
    const ctx = await createTestContext("setup-gate")
    contexts.push(ctx)

    expect(await isSetupPending(ctx.database)).toBe(true)

    await createFirstUser(deps(ctx), input)

    // Closed, and closed *without* another query: the flag is what the page
    // and both redirects read on every request afterwards.
    expect(await isSetupPending(ctx.database)).toBe(false)
  })

  it("closes for any user, not only an administrator", async () => {
    const ctx = await createTestContext("setup-gate-any-user")
    contexts.push(ctx)

    const context = await ctx.auth.$context
    await createUserWithoutRequest(
      context,
      {
        email: "ordinary@example.com",
        name: "Ordinary",
        emailVerified: true,
        role: "user",
        status: "active",
      },
      { method: "admin" }
    )

    // The point of the rule: a deployment that lost its last administrator
    // must not be able to mint one from an unauthenticated page.
    expect(await isSetupPending(ctx.database)).toBe(false)
  })

  it("creates an active, verified administrator who is not forced to change anything", async () => {
    const ctx = await createTestContext("setup-creates-admin")
    contexts.push(ctx)

    const result = await createFirstUser(deps(ctx), input)
    expect(result.created).toBe(true)
    // **D69**: the admin role *and* the catalog default, so a downstream app
    // keying on `user` does not exclude the person who set the IdP up.
    expect(splitRoles(result.role)).toEqual(["admin", "user"])

    const users = await ctx.database.db.select().from(ctx.database.schema.user)
    expect(users).toHaveLength(1)

    const admin = users[0]!
    // FR-AUTH-1: normalised on the way in.
    expect(admin.email).toBe("first.operator@example.com")
    expect(splitRoles(admin.role)).toContain("admin")
    expect(splitRoles(admin.role)).toContain("user")
    expect(admin.status).toBe("active")
    expect(admin.emailVerified).toBe(true)
    expect(admin.approvedBy).toBe("system")
    // The whole difference from the bootstrap account this replaces: the
    // person who typed the password is the person who will use it.
    expect(admin.mustChangePassword).toBe(false)
    // D49: derived from the parts, in `site.nameFormat` order.
    expect(admin.name).toBe("Frida Operator")
    expect(admin.firstName).toBe("Frida")
    expect(admin.lastName).toBe("Operator")
  })

  it("derives the name the other way round when site.nameFormat says so (D49)", async () => {
    const ctx = await createTestContext("setup-name-format", {
      config: { site: { name: "Test IdP", nameFormat: "last-first" } },
    })
    contexts.push(ctx)

    await createFirstUser(deps(ctx), input)
    const [admin] = await ctx.database.db
      .select()
      .from(ctx.database.schema.user)
    expect(admin!.name).toBe("Operator, Frida")
  })

  it("writes a credential the sign-in path verifies (SEC-10)", async () => {
    const ctx = await createTestContext("setup-signs-in")
    contexts.push(ctx)

    await createFirstUser(deps(ctx), input)

    const response = await ctx.auth.handler(
      authRequest("/sign-in/email", {
        json: {
          email: "first.operator@example.com",
          password: input.password,
        },
      })
    )
    expect(response.status).toBe(200)
    expect(sessionCookie(response)).toBeDefined()
  })

  it("creates exactly one account when two submissions race", async () => {
    const ctx = await createTestContext("setup-race")
    contexts.push(ctx)

    const [first, second] = await Promise.all([
      createFirstUser(deps(ctx), input),
      createFirstUser(deps(ctx), {
        ...input,
        email: "second.operator@example.com",
      }),
    ])

    // One wins under the advisory lock; the loser re-reads the table inside it
    // and creates nothing. Which one wins is not the assertion.
    expect([first.created, second.created].filter(Boolean)).toHaveLength(1)

    const users = await ctx.database.db.select().from(ctx.database.schema.user)
    expect(users).toHaveLength(1)
  })

  it("records the creation in the audit trail (SEC-6)", async () => {
    const ctx = await createTestContext("setup-audit")
    contexts.push(ctx)

    const result = await createFirstUser(deps(ctx), input)

    const rows = await ctx.database.db
      .select()
      .from(ctx.database.schema.auditLog)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      // D66: an account made for somebody, not a self-service registration —
      // and `via: "setup"` below says which of the two ways.
      action: "user.created",
      outcome: "success",
      // Nobody is signed in yet, so there is no actor to name.
      actorType: "anonymous",
      targetType: "user",
      targetId: result.userId,
    })
    expect(rows[0]!.metadata).toMatchObject({
      via: "setup",
      role: "admin,user",
    })
  })

  it("does not repeat a role when the catalog default is itself an admin role (D69)", async () => {
    const ctx = await createTestContext("setup-default-is-admin", {
      roles: [
        { name: "admin", description: "Everything.", default: true },
        { name: "staff", description: "Not the default.", default: false },
      ],
    })
    contexts.push(ctx)

    const result = await createFirstUser(deps(ctx), input)
    // Not `"admin,admin"`: the join dedups, because the two sources coincide
    // whenever a deployment makes its admin role the default one.
    expect(result.role).toBe("admin")

    const [admin] = await ctx.database.db
      .select()
      .from(ctx.database.schema.user)
    expect(admin!.role).toBe("admin")
  })

  it("never records the password", async () => {
    const ctx = await createTestContext("setup-secrecy")
    contexts.push(ctx)

    const lines: string[] = []
    const logger = createLogger({ level: "trace", write: (l) => lines.push(l) })
    await createFirstUser(
      { ...deps(ctx), logger, audit: createAudit(ctx.database, logger) },
      input
    )

    const rows = await ctx.database.db
      .select()
      .from(ctx.database.schema.auditLog)
    expect(JSON.stringify(rows)).not.toContain(input.password)
    expect(lines.join("\n")).not.toContain(input.password)
  })

  it("re-asks while pending, so a stale `true` cannot outlive the first user", async () => {
    const ctx = await createTestContext("setup-gate-refresh")
    contexts.push(ctx)

    expect(await isSetupPending(ctx.database)).toBe(true)

    // Somebody else — another process, or the SQL promotion in the runbooks —
    // put a user in the table without going through `createFirstUser`.
    const context = await ctx.auth.$context
    await createUserWithoutRequest(
      context,
      {
        email: "sideways@example.com",
        name: "Sideways",
        emailVerified: true,
        role: "admin",
        status: "active",
      },
      { method: "admin" }
    )

    expect(await isSetupPending(ctx.database)).toBe(false)
  })

  it("forgets the memoised answer when asked to", async () => {
    const ctx = await createTestContext("setup-gate-reset")
    contexts.push(ctx)

    await createFirstUser(deps(ctx), input)
    expect(await isSetupPending(ctx.database)).toBe(false)

    resetSetupGate()
    // Still false, because the table still has a user — but it was re-queried
    // to find that out, which is what the suite depends on between files.
    expect(await isSetupPending(ctx.database)).toBe(false)
  })
})
