import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

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

  // Each test counts only the rows it caused. Counting the whole table made
  // these assertions depend on every earlier test in the file, so one slow
  // run that retried a case turned three passing tests into three failures
  // with nothing wrong in the code.
  beforeEach(async () => {
    await ctx.database.db.delete(ctx.database.schema.auditLog)
  })

  async function rows(action: string) {
    return ctx.database.db
      .select()
      .from(ctx.database.schema.auditLog)
      .where(eq(ctx.database.schema.auditLog.action, action))
      .orderBy(desc(ctx.database.schema.auditLog.createdAt))
  }

  it("records a self-registration, which nothing did before", async () => {
    // Only the bootstrap step ever wrote `signup.created`; a user signing
    // themselves up left no row. Since D66 the name is the user's own:
    // `signup.created` means self-service and nothing else, and an account
    // made *for* somebody — by an administrator or by the first-run wizard —
    // is `user.created`.
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
        json: {
          currentPassword: password,
          newPassword: "a different one entirely",
        },
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

/**
 * `session.revoked` says *which* sign-out, and names a session only when one
 * really was ended.
 *
 * Four endpoints share the action, so a row without a scope leaves "did they
 * end one session or all of them?" unanswerable. The id is the delicate half:
 * Better Auth's `/revoke-session` compares the presented token's owner to the
 * caller and, when they differ, **skips the delete and answers success
 * anyway** — so an unconditional id would mint success rows naming a
 * victim's session for a revocation that never happened.
 */
describe("what a session.revoked row says (SEC-6)", () => {
  let ctx: TestContext
  const password = "correct horse battery staple"

  beforeAll(async () => {
    ctx = await createTestContext("audit-session-scope", {
      config: {
        signUp: { enabled: true, requireApproval: false },
        auth: { requireEmailVerification: false },
      },
    })
  }, 120_000)
  afterAll(async () => await ctx.teardown())

  beforeEach(async () => {
    await ctx.database.db.delete(ctx.database.schema.auditLog)
  })

  async function revocations() {
    return ctx.database.db
      .select()
      .from(ctx.database.schema.auditLog)
      .where(eq(ctx.database.schema.auditLog.action, "session.revoked"))
  }

  async function signedIn(email: string): Promise<string> {
    await ctx.auth.handler(
      authRequest("/sign-up/email", {
        json: { email, password, name: "Scoped" },
      })
    )
    const response = await ctx.auth.handler(
      authRequest("/sign-in/email", { json: { email, password } })
    )
    const cookie = sessionCookie(response)
    expect(cookie).toBeTruthy()
    return cookie!
  }

  async function tokenOf(cookie: string): Promise<string> {
    const result = await ctx.auth.api.getSession({
      headers: new Headers({ cookie }),
    })
    const token = (result?.session as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    return token!
  }

  async function sessionIdOf(cookie: string): Promise<string> {
    const result = await ctx.auth.api.getSession({
      headers: new Headers({ cookie }),
    })
    const id = (result?.session as { id?: string } | undefined)?.id
    expect(id).toBeTruthy()
    return id!
  }

  it("names the session a sign-out ended", async () => {
    const cookie = await signedIn("scope-signout@example.com")
    const id = await sessionIdOf(cookie)

    await ctx.auth.handler(
      authRequest("/sign-out", { headers: { cookie }, json: {} })
    )

    const [row] = await revocations()
    // `/sign-out` carries no session middleware, so the id can only come from
    // the before hook resolving the caller's own signed cookie while the row
    // still exists.
    expect(row?.metadata).toMatchObject({ scope: "current", sessionId: id })
  })

  it("names the session a revoke ended, and scopes the rest", async () => {
    const keep = await signedIn("scope-revoke@example.com")
    const other = await ctx.auth.handler(
      authRequest("/sign-in/email", {
        json: { email: "scope-revoke@example.com", password },
      })
    )
    const target = sessionCookie(other)!
    const targetId = await sessionIdOf(target)

    await ctx.auth.handler(
      authRequest("/revoke-session", {
        headers: { cookie: keep },
        json: { token: await tokenOf(target) },
      })
    )

    const [row] = await revocations()
    expect(row?.metadata).toMatchObject({ scope: "one", sessionId: targetId })
  })

  it("omits the id when the token was somebody else's", async () => {
    const mine = await signedIn("scope-mine@example.com")
    const theirs = await signedIn("scope-theirs@example.com")
    const theirToken = await tokenOf(theirs)

    const response = await ctx.auth.handler(
      authRequest("/revoke-session", {
        headers: { cookie: mine },
        json: { token: theirToken },
      })
    )
    // Better Auth's own answer, and the reason this case exists at all.
    expect(response.status).toBe(200)

    // The victim is still signed in: nothing was revoked.
    const still = await ctx.auth.api.getSession({
      headers: new Headers({ cookie: theirs }),
    })
    expect(still?.user).toBeTruthy()

    const [row] = await revocations()
    expect(row?.metadata).toMatchObject({ scope: "one" })
    expect((row?.metadata as { sessionId?: string }).sessionId).toBeUndefined()
  })

  it("scopes a bulk revocation and names no single session", async () => {
    const cookie = await signedIn("scope-others@example.com")
    await ctx.auth.handler(
      authRequest("/sign-in/email", {
        json: { email: "scope-others@example.com", password },
      })
    )

    await ctx.auth.handler(
      authRequest("/revoke-other-sessions", {
        headers: { cookie },
        json: {},
      })
    )

    const [row] = await revocations()
    expect(row?.metadata).toMatchObject({ scope: "others" })
    expect((row?.metadata as { sessionId?: string }).sessionId).toBeUndefined()
  })
})
