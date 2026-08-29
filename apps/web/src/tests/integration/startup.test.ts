import { afterEach, describe, expect, it } from "vitest"

import { runStartup } from "@/server/startup"
import { splitRoles } from "@/server/role-utils"
import { createAudit } from "@/server/audit"
import { createUserWithoutRequest } from "@/server/auth/provisioning"
import { createLogger } from "@/server/logger"
import type { LogFields } from "@/server/logger"
import { createTestContext } from "./harness"
import type { TestContext } from "./harness"

/**
 * OPS-2 and FR-ADMIN-1.
 *
 * The harness already migrates, so these tests exercise the steps that run
 * after the auth instance exists: the signing key, the role check and the
 * first-run check. The migration step itself is covered by the S4 spike and by
 * every other integration file implicitly.
 *
 * Nothing here creates an administrator any more. D52 replaced the bootstrap
 * step with a page (`integration/setup.test.ts`), and what start-up does now is
 * say that the deployment has no users yet.
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
      // FR-GW-2: beside the client reconcile, under a lock of its own.
      "reconcile gateways",
      // D50: after the reconcile, because it reads the rows it just wrote.
      "client origins",
      "validate roles",
      "first-run check",
    ])
  })

  it("skips the gateway sweep only when there is nothing to sweep (FR-GW-2)", async () => {
    // The skip is a real decision rather than an optimization: an empty
    // `gateways` block with rows still in the table is exactly the case the
    // sweep exists for, so it must not be skipped then.
    const ctx = await createTestContext("startup-gateways")
    contexts.push(ctx)

    const skipped = await start(ctx)
    expect(
      skipped.result.steps.find((step) => step.name === "reconcile gateways")
        ?.skipped
    ).toBe("no gateways configured")

    await ctx.database.db.insert(ctx.database.schema.gateway).values({
      id: crypto.randomUUID(),
      name: "left-behind",
      url: "https://gone.example",
      requireAuth: false,
      trustProxy: false,
      source: "config",
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const swept = await start(ctx)
    expect(
      swept.result.steps.find((step) => step.name === "reconcile gateways")
        ?.skipped
    ).toBeUndefined()
    expect(swept.result.gateways?.disabled).toEqual(["left-behind"])
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

  describe("first-run check (FR-ADMIN-1, D52)", () => {
    it("says where to finish setup while the user table is empty", async () => {
      const ctx = await createTestContext("startup-first-run")
      contexts.push(ctx)

      const { lines } = await start(ctx)
      const notice = lines.find((line) => line.msg === "no users yet")
      expect(notice).toBeDefined()
      expect(notice!.level).toBe("warn")
      expect(String(notice!.fields.hint)).toContain(
        "http://localhost:3000/setup"
      )
    })

    it("creates nobody — the page is the only way in", async () => {
      const ctx = await createTestContext("startup-creates-nobody")
      contexts.push(ctx)

      await start(ctx)
      await start(ctx)

      const users = await ctx.database.db
        .select()
        .from(ctx.database.schema.user)
      expect(users).toHaveLength(0)

      // And no audit row either: nothing happened, so nothing is recorded.
      const rows = await ctx.database.db
        .select()
        .from(ctx.database.schema.auditLog)
      expect(rows).toHaveLength(0)
    })

    it("stays quiet once any user exists", async () => {
      const ctx = await createTestContext("startup-has-users")
      contexts.push(ctx)

      const context = await ctx.auth.$context
      await createUserWithoutRequest(
        context,
        {
          email: "someone@example.com",
          name: "Someone",
          emailVerified: true,
          role: "user",
          status: "active",
        },
        { method: "admin" }
      )

      const { lines } = await start(ctx)
      expect(lines.find((line) => line.msg === "no users yet")).toBeUndefined()
    })
  })

  describe("role catalog validation (FR-ROLE-2)", () => {
    it("warns about a stored role that is no longer in the catalog", async () => {
      const ctx = await createTestContext("startup-unknown-role")
      contexts.push(ctx)

      const context = await ctx.auth.$context
      await createUserWithoutRequest(
      context,
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
      await createUserWithoutRequest(
      context,
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
