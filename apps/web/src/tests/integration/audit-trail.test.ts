import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { desc, eq } from "drizzle-orm"

import { authRequest, createTestContext, sessionCookie } from "./harness"
import type { TestContext } from "./harness"

/**
 * SEC-6 — the trail exists in the database, not only in the mapping table.
 *
 * `audit-mapping.test.ts` asserts which endpoint produces which event; this
 * asserts the rows are actually written, with an actor where there is one and
 * without one where there must not be. The second half matters as much: a
 * failed sign-in must not record *who* failed, because that would turn the
 * audit log into the account-existence oracle SEC-7 keeps the response from
 * being.
 */
describe("audit trail (SEC-6)", () => {
  let ctx: TestContext
  const password = "correct horse battery staple"
  const email = "audited@example.com"

  beforeAll(async () => {
    ctx = await createTestContext("audit-trail", {
      config: { signUp: { enabled: true, requireApproval: false } },
    })
  }, 120_000)
  afterAll(async () => await ctx.teardown())

  async function rows(action: string) {
    return ctx.database.db
      .select()
      .from(ctx.database.schema.auditLog)
      .where(eq(ctx.database.schema.auditLog.action, action))
      .orderBy(desc(ctx.database.schema.auditLog.createdAt))
  }

  it("records a self-registration, which nothing did before", async () => {
    // Only the bootstrap step ever wrote `signup.created`; a user signing
    // themselves up left no row.
    const response = await ctx.auth.handler(
      authRequest("/sign-up/email", {
        json: { email, password, name: "Auto Audited" },
      })
    )
    expect(response.status).toBe(200)

    const created = await rows("signup.created")
    expect(created).toHaveLength(1)
    expect(created[0]!.outcome).toBe("success")
    expect(created[0]!.actorUserId).toBeTruthy()
  })

  it("records a successful sign-in against the user who signed in", async () => {
    const response = await ctx.auth.handler(
      authRequest("/sign-in/email", { json: { email, password } })
    )
    expect(response.status).toBe(200)

    const success = await rows("signin.success")
    expect(success).toHaveLength(1)
    expect(success[0]!.outcome).toBe("success")
    expect(success[0]!.actorType).toBe("session")

    const [user] = await ctx.database.db
      .select()
      .from(ctx.database.schema.user)
      .where(eq(ctx.database.schema.user.email, email))
    expect(success[0]!.actorUserId).toBe(user!.id)
  })

  it("records a failed sign-in without naming anyone (SEC-7)", async () => {
    for (const attempt of [
      { email, password: "not the right password at all" },
      { email: "nobody-here@example.com", password },
    ]) {
      const response = await ctx.auth.handler(
        authRequest("/sign-in/email", { json: attempt })
      )
      expect(response.ok).toBe(false)
    }

    const failures = await rows("signin.failure")
    expect(failures).toHaveLength(2)
    for (const row of failures) {
      expect(row.outcome).toBe("failure")
      // The whole point: a wrong password and an unknown address leave
      // indistinguishable rows, so the log cannot answer "does this account
      // exist" any more than the response can.
      expect(row.actorUserId).toBeNull()
      expect(row.actorType).toBe("anonymous")
    }
  })

  it("records a password change and the sign-out that follows", async () => {
    const signIn = await ctx.auth.handler(
      authRequest("/sign-in/email", { json: { email, password } })
    )
    const cookie = sessionCookie(signIn)!

    await ctx.auth.handler(
      authRequest("/change-password", {
        headers: { cookie },
        json: { currentPassword: password, newPassword: "a different one entirely" },
      })
    )
    await ctx.auth.handler(
      authRequest("/sign-out", { headers: { cookie }, json: {} })
    )

    expect(await rows("password.changed")).toHaveLength(1)
    expect(await rows("session.revoked")).toHaveLength(1)
  })

  it("writes nothing for the endpoints that are not events", async () => {
    const before = await ctx.database.db
      .select()
      .from(ctx.database.schema.auditLog)

    await ctx.auth.handler(
      new Request("http://localhost:3000/api/auth/get-session", {
        headers: { origin: "http://localhost:3000" },
      })
    )

    const after = await ctx.database.db
      .select()
      .from(ctx.database.schema.auditLog)
    expect(after).toHaveLength(before.length)
  })
})
