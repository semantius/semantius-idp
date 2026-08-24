import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { and, eq } from "drizzle-orm"

import { createUserWithoutRequest } from "@/server/auth/provisioning"
import { authRequest, createTestContext, sessionCookie } from "./harness"
import type {TestContext} from "./harness";

/**
 * FR-SIGNUP-2's approve/reject endpoints and FR-ROLE-3's admin gate.
 *
 * These are endpoints rather than page-only logic because FR-ADMIN-6 makes the
 * admin API the documented management interface — so the gate has to hold for
 * an API caller, not only for someone who reached a page.
 */
describe("approval endpoints (FR-SIGNUP-2, FR-ROLE-3)", () => {
  const password = "correct horse battery staple"
  let ctx: TestContext
  let adminCookie: string
  let userCookie: string

  beforeAll(async () => {
    ctx = await createTestContext("approval-endpoints", {
      config: {
        signUp: { enabled: true, requireApproval: true },
        email: { resend: { apiKey: "re_test" }, from: "IdP <idp@example.com>" },
        auth: { requireEmailVerification: false },
      },
    })

    const context = await ctx.auth.$context

    // An admin and an ordinary active user, both created administratively so
    // they are active without going through approval themselves.
    for (const [email, role] of [
      ["admin@example.com", "admin"],
      ["member@example.com", "user"],
    ] as const) {
      const user = await createUserWithoutRequest(
      context,
        { email, name: role, emailVerified: true, role, status: "active" },
        { method: "admin" }
      )
      await context.internalAdapter.createAccount({
        userId: user.id,
        providerId: "credential",
        issuer: "local:credential",
        accountId: user.id,
        password: await context.password.hash(password),
      })
    }

    adminCookie = await signIn("admin@example.com")
    userCookie = await signIn("member@example.com")
  }, 180_000)

  afterAll(async () => await ctx.teardown())
  beforeEach(() => ctx.mailer.captured.clear())

  async function signIn(email: string): Promise<string> {
    const response = await ctx.auth.handler(
      authRequest("/sign-in/email", { json: { email, password } })
    )
    const cookie = sessionCookie(response)
    if (!cookie)
      throw new Error(`no session cookie for ${email}: ${response.status}`)
    return cookie
  }

  /** Signs a new applicant up; they land as `pending`. */
  async function createApplicant(): Promise<{ id: string; email: string }> {
    const email = `applicant-${Date.now()}-${Math.round(performance.now())}@example.com`
    const response = await ctx.auth.handler(
      authRequest("/sign-up/email", {
        json: { email, password, name: "App Licant" },
      })
    )
    if (response.status !== 200)
      throw new Error(`sign-up failed: ${response.status}`)
    const [row] = await ctx.database.db
      .select()
      .from(ctx.database.schema.user)
      .where(eq(ctx.database.schema.user.email, email))
    return { id: row!.id, email }
  }

  function call(
    path: string,
    body: unknown,
    cookie?: string
  ): Promise<Response> {
    return ctx.auth.handler(
      authRequest(path, { json: body, headers: cookie ? { cookie } : {} })
    )
  }

  describe("the admin gate (FR-ROLE-3)", () => {
    it("refuses an anonymous caller", async () => {
      const applicant = await createApplicant()
      const response = await call("/idp/approve-user", { userId: applicant.id })
      expect(response.status).toBe(401)
    })

    it("refuses a signed-in non-admin", async () => {
      const applicant = await createApplicant()
      const response = await call(
        "/idp/approve-user",
        { userId: applicant.id },
        userCookie
      )
      expect(response.status).toBe(403)

      const [row] = await ctx.database.db
        .select()
        .from(ctx.database.schema.user)
        .where(eq(ctx.database.schema.user.id, applicant.id))
      expect(row!.status).toBe("pending")
    })

    it("gives both the same wording, so who is an admin is not confirmed", async () => {
      const applicant = await createApplicant()
      const anonymous = await call("/idp/approve-user", {
        userId: applicant.id,
      })
      const member = await call(
        "/idp/approve-user",
        { userId: applicant.id },
        userCookie
      )
      expect((await anonymous.json()).message).toBe(
        (await member.json()).message
      )
    })
  })

  describe("approve", () => {
    it("activates the account, records who did it, and lets them sign in", async () => {
      const applicant = await createApplicant()

      const before = await ctx.auth.handler(
        authRequest("/sign-in/email", {
          json: { email: applicant.email, password },
        })
      )
      expect(before.status).toBeGreaterThanOrEqual(400)

      const response = await call(
        "/idp/approve-user",
        { userId: applicant.id },
        adminCookie
      )
      expect(response.status).toBe(200)

      const [row] = await ctx.database.db
        .select()
        .from(ctx.database.schema.user)
        .where(eq(ctx.database.schema.user.id, applicant.id))
      expect(row!.status).toBe("active")
      expect(row!.approvedAt).toBeInstanceOf(Date)
      expect(row!.approvedBy).toBeTruthy()

      const after = await ctx.auth.handler(
        authRequest("/sign-in/email", {
          json: { email: applicant.email, password },
        })
      )
      expect(after.status).toBe(200)
    })

    it("tells the applicant (FR-MAIL-1)", async () => {
      const applicant = await createApplicant()
      await call("/idp/approve-user", { userId: applicant.id }, adminCookie)

      const message = ctx.mailer.captured.last("account-approved")
      expect(message).toBeDefined()
      expect(message!.to).toBe(applicant.email)
      // FR-SIGNUP-2: the link goes to /login; approval never resumes a flow.
      expect(message!.html).toContain("http://localhost:3000/login")
    })

    it("writes an audit row naming the actor and the target (SEC-6)", async () => {
      const applicant = await createApplicant()
      await call("/idp/approve-user", { userId: applicant.id }, adminCookie)

      // Filtered by action: the applicant also has a `signup.created` row
      // from registering, now that the SEC-6 after-hook records one.
      const rows = await auditRows(applicant.id, "signup.approved")
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        action: "signup.approved",
        outcome: "success",
        actorType: "session",
        targetType: "user",
      })
      expect(rows[0]!.actorUserId).toBeTruthy()
      expect(rows[0]!.metadata).toMatchObject({ previousStatus: "pending" })
    })

    it("is idempotent for an already-active account", async () => {
      const applicant = await createApplicant()
      await call("/idp/approve-user", { userId: applicant.id }, adminCookie)
      ctx.mailer.captured.clear()

      const again = await call(
        "/idp/approve-user",
        { userId: applicant.id },
        adminCookie
      )
      expect(again.status).toBe(200)
      // No second e-mail and no second approval row.
      expect(ctx.mailer.captured.messages).toHaveLength(0)
      expect(await auditRows(applicant.id, "signup.approved")).toHaveLength(1)
    })

    it("404s for an unknown user", async () => {
      const response = await call(
        "/idp/approve-user",
        { userId: "no-such-user" },
        adminCookie
      )
      expect(response.status).toBe(404)
    })
  })

  describe("reject", () => {
    it("marks the account rejected and keeps the row so the address stays reserved", async () => {
      const applicant = await createApplicant()
      const response = await call(
        "/idp/reject-user",
        { userId: applicant.id },
        adminCookie
      )
      expect(response.status).toBe(200)

      const [row] = await ctx.database.db
        .select()
        .from(ctx.database.schema.user)
        .where(eq(ctx.database.schema.user.id, applicant.id))
      expect(row).toBeDefined()
      expect(row!.status).toBe("rejected")
      expect(row!.approvedAt).toBeNull()

      const refused = await ctx.auth.handler(
        authRequest("/sign-in/email", {
          json: { email: applicant.email, password },
        })
      )
      expect(refused.status).toBeGreaterThanOrEqual(400)
    })

    it("stays silent unless notification is asked for (FR-MAIL-1)", async () => {
      const quiet = await createApplicant()
      await call("/idp/reject-user", { userId: quiet.id }, adminCookie)
      expect(ctx.mailer.captured.last("account-rejected")).toBeUndefined()

      const told = await createApplicant()
      await call(
        "/idp/reject-user",
        { userId: told.id, notify: true },
        adminCookie
      )
      expect(ctx.mailer.captured.last("account-rejected")?.to).toBe(told.email)
    })

    it("revokes any session the applicant somehow holds", async () => {
      const applicant = await createApplicant()
      // Approve, sign in, then reject: the live session must not survive.
      await call("/idp/approve-user", { userId: applicant.id }, adminCookie)
      const applicantSession = await ctx.auth.handler(
        authRequest("/sign-in/email", {
          json: { email: applicant.email, password },
        })
      )
      expect(applicantSession.status).toBe(200)

      await call("/idp/reject-user", { userId: applicant.id }, adminCookie)

      const sessions = await ctx.database.db
        .select()
        .from(ctx.database.schema.session)
        .where(eq(ctx.database.schema.session.userId, applicant.id))
      expect(sessions).toHaveLength(0)
    })

    it("audits the rejection (SEC-6)", async () => {
      const applicant = await createApplicant()
      await call(
        "/idp/reject-user",
        { userId: applicant.id, notify: true },
        adminCookie
      )

      const rows = await auditRows(applicant.id, "signup.rejected")
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        action: "signup.rejected",
        outcome: "success",
      })
      expect(rows[0]!.metadata).toMatchObject({ notified: true })
    })
  })

  /** Audit rows for one user, narrowed to a single action. */
  async function auditRows(targetId: string, action: string) {
    return ctx.database.db
      .select()
      .from(ctx.database.schema.auditLog)
      .where(
        and(
          eq(ctx.database.schema.auditLog.targetId, targetId),
          eq(ctx.database.schema.auditLog.action, action)
        )
      )
  }
})
