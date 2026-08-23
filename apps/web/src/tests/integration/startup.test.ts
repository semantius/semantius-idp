import { afterEach, describe, expect, it } from "vitest"

import { eq } from "drizzle-orm"

import { runStartup, splitRoles } from "@/server/startup"
import { createAudit } from "@/server/audit"
import { createLogger } from "@/server/logger"
import type { LogFields } from "@/server/logger"
import { createTestContext } from "./harness"
import type { TestContext } from "./harness"

/**
 * OPS-2 and FR-ADMIN-1.
 *
 * The harness already migrates, so these tests exercise the steps that run
 * after the auth instance exists: the signing key, the role check and the
 * bootstrap admin. The migration step itself is covered by the S4 spike and by
 * every other integration file implicitly.
 */
describe("startup sequence (OPS-2)", () => {
  const contexts: TestContext[] = []

  afterEach(async () => {
    while (contexts.length > 0) await contexts.pop()!.teardown()
  })

  /** Runs the post-migration part of startup, collecting the log. */
  async function start(ctx: TestContext) {
    const lines: { level: string; msg: string; fields: LogFields }[] = []
    const logger = createLogger({
      level: "trace",
      write: (line) => {
        const record = JSON.parse(line) as {
          level: string
          msg: string
        } & LogFields
        const { level, msg, time: _t, ...fields } = record
        lines.push({ level, msg, fields })
      },
    })
    const result = await runStartup({
      config: ctx.config,
      database: ctx.database,
      locking: ctx.database,
      auth: ctx.auth,
      logger,
    })
    return { result, lines }
  }

  it("runs the steps in the documented order", async () => {
    const ctx = await createTestContext("startup-order")
    contexts.push(ctx)

    const { result } = await start(ctx)
    expect(result.steps.map((step) => step.name)).toEqual([
      "signing key",
      "reconcile clients",
      "validate roles",
      "bootstrap admin",
    ])
  })

  it("generates exactly one signing key and reuses it on the next boot (FR-OIDC-16)", async () => {
    const ctx = await createTestContext("startup-signing-key")
    contexts.push(ctx)

    await start(ctx)
    const first = await ctx.database.db.select().from(ctx.database.schema.jwks)
    expect(first).toHaveLength(1)
    expect(first[0]!.alg).toBe("ES256")
    // SEC-10: the private half is encrypted at rest, so it must not be a bare JWK.
    expect(first[0]!.privateKey).not.toContain('"d"')

    await start(ctx)
    const second = await ctx.database.db.select().from(ctx.database.schema.jwks)
    expect(second).toHaveLength(1)
    expect(second[0]!.id).toBe(first[0]!.id)
  })

  describe("bootstrap admin (FR-ADMIN-1)", () => {
    const bootstrap = {
      email: "Bootstrap.Admin@Example.COM",
      password: "correct horse battery staple",
      name: "Bootstrap Admin",
    }

    it("creates exactly one admin across two boots", async () => {
      const ctx = await createTestContext("startup-bootstrap", {
        config: { admin: { bootstrap } },
      })
      contexts.push(ctx)

      await start(ctx)
      await start(ctx)

      const users = await ctx.database.db
        .select()
        .from(ctx.database.schema.user)
      expect(users).toHaveLength(1)

      const admin = users[0]!
      // FR-AUTH-1: normalised on the way in.
      expect(admin.email).toBe("bootstrap.admin@example.com")
      expect(splitRoles(admin.role)).toContain("admin")
      expect(admin.status).toBe("active")
      expect(admin.emailVerified).toBe(true)
      expect(admin.mustChangePassword).toBe(true)
      expect(admin.approvedBy).toBe("system")
    })

    it("never logs the password", async () => {
      const ctx = await createTestContext("startup-bootstrap-secrecy", {
        config: { admin: { bootstrap } },
      })
      contexts.push(ctx)

      const { lines } = await start(ctx)
      const everything = JSON.stringify(lines)
      expect(everything).not.toContain(bootstrap.password)
      expect(everything).toContain("bootstrap admin created")
    })

    it("writes an audit row for the creation (SEC-6)", async () => {
      const ctx = await createTestContext("startup-bootstrap-audit", {
        config: { admin: { bootstrap } },
      })
      contexts.push(ctx)

      await start(ctx)
      const rows = await ctx.database.db
        .select()
        .from(ctx.database.schema.auditLog)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        action: "signup.created",
        outcome: "success",
        actorType: "system",
        targetType: "user",
      })
      expect(rows[0]!.metadata).toMatchObject({
        bootstrap: true,
        role: "admin",
      })
    })

    it("skips with a loud warning when no bootstrap admin is configured", async () => {
      const ctx = await createTestContext("startup-bootstrap-absent")
      contexts.push(ctx)

      await start(ctx)
      const users = await ctx.database.db
        .select()
        .from(ctx.database.schema.user)
      expect(users).toHaveLength(0)
      // The warning itself comes from the config loader, which the harness
      // bypasses; what matters here is that nothing was created.
      expect(ctx.config.file.admin.bootstrap).toBeUndefined()
    })

    it("does not create a second admin once one exists by another route", async () => {
      const ctx = await createTestContext("startup-bootstrap-existing-admin", {
        config: { admin: { bootstrap } },
      })
      contexts.push(ctx)

      const context = await ctx.auth.$context
      await context.internalAdapter.createUser(
        {
          email: "someone.else@example.com",
          name: "Existing Admin",
          emailVerified: true,
          role: "admin",
          status: "active",
        },
        { method: "admin" }
      )

      await start(ctx)
      const users = await ctx.database.db
        .select()
        .from(ctx.database.schema.user)
      expect(users).toHaveLength(1)
      expect(users[0]!.email).toBe("someone.else@example.com")
    })

    it("refuses rather than silently promoting an existing non-admin", async () => {
      const ctx = await createTestContext("startup-bootstrap-collision", {
        config: { admin: { bootstrap } },
      })
      contexts.push(ctx)

      const context = await ctx.auth.$context
      await context.internalAdapter.createUser(
        {
          email: "bootstrap.admin@example.com",
          name: "Ordinary User",
          emailVerified: true,
          role: "user",
          status: "active",
        },
        { method: "admin" }
      )

      await expect(start(ctx)).rejects.toThrow(
        /already exists but holds no admin role/
      )

      const [row] = await ctx.database.db
        .select()
        .from(ctx.database.schema.user)
        .where(
          eq(ctx.database.schema.user.email, "bootstrap.admin@example.com")
        )
      expect(row!.role).toBe("user")
    })
  })

  describe("role catalog validation (FR-ROLE-2)", () => {
    it("warns about a stored role that is no longer in the catalog", async () => {
      const ctx = await createTestContext("startup-unknown-role")
      contexts.push(ctx)

      const context = await ctx.auth.$context
      await context.internalAdapter.createUser(
        {
          email: "legacy@example.com",
          name: "Legacy",
          emailVerified: true,
          role: "user,billing",
          status: "active",
        },
        { method: "admin" }
      )

      const { lines } = await start(ctx)
      const warning = lines.find((line) =>
        line.msg.includes("not in the catalog")
      )
      expect(warning).toBeDefined()
      expect(warning!.fields).toMatchObject({ role: "billing", users: 1 })
    })

    it("says nothing when every stored role is known", async () => {
      const ctx = await createTestContext("startup-known-roles")
      contexts.push(ctx)

      const context = await ctx.auth.$context
      await context.internalAdapter.createUser(
        {
          email: "regular@example.com",
          name: "Regular",
          emailVerified: true,
          role: "user",
          status: "active",
        },
        { method: "admin" }
      )

      const { lines } = await start(ctx)
      expect(
        lines.find((line) => line.msg.includes("not in the catalog"))
      ).toBeUndefined()
    })
  })

  it("keeps writing audit rows without failing the action when the table is gone", async () => {
    const ctx = await createTestContext("audit-resilience")
    contexts.push(ctx)

    const lines: string[] = []
    const audit = createAudit(
      ctx.database,
      createLogger({ level: "trace", write: (line) => lines.push(line) })
    )
    await ctx.database.sql.unsafe(`drop table "${ctx.schemaName}"."audit_log"`)

    // SEC-6: an audit outage must not become an authentication outage.
    await expect(
      audit.record({
        action: "signin.success",
        outcome: "success",
        actorUserId: "u1",
      })
    ).resolves.toBeUndefined()
    expect(lines.join("\n")).toContain("audit write failed")
  })
})

describe("splitRoles (FR-ROLE-2)", () => {
  it("splits the comma-separated column and trims", () => {
    expect(splitRoles("admin, billing ,user")).toEqual([
      "admin",
      "billing",
      "user",
    ])
    expect(splitRoles("")).toEqual([])
    expect(splitRoles(null)).toEqual([])
  })
})
