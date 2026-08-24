import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { eq } from "drizzle-orm"

import { authRequest, createTestContext } from "./harness"
import type { TestContext } from "./harness"

/**
 * FR-MAIL-1/2 and the verification and reset flows that depend on them
 * (FR-AUTH-2, FR-AUTH-3).
 *
 * The capture transport is what makes these assertable without a mailbox: the
 * test reads the link straight out of the message, exactly as the Playwright
 * run will against the built image.
 */
describe("e-mail flows", () => {
  const password = "correct horse battery staple"

  describe("with a transport configured", () => {
    let ctx: TestContext

    beforeAll(async () => {
      ctx = await createTestContext("email-on", {
        config: {
          signUp: { enabled: true, requireApproval: false },
          email: {
            resend: { apiKey: "re_test" },
            from: "IdP <idp@example.com>",
          },
          site: { name: "Test IdP", supportEmail: "help@example.com" },
        },
      })
    }, 120_000)
    afterAll(async () => await ctx.teardown())
    beforeEach(() => ctx.mailer.captured.clear())

    it("keeps e-mail verification on (FR-MAIL-2 does not apply)", () => {
      expect(ctx.config.emailEnabled).toBe(true)
      expect(ctx.config.requireEmailVerification).toBe(true)
    })

    it("sends a verification link on sign-up and honours it (FR-AUTH-2)", async () => {
      const email = `verify-${Date.now()}@example.com`

      const signUp = await ctx.auth.handler(
        authRequest("/sign-up/email", {
          json: { email, password, name: "Vera Verify" },
        })
      )
      expect(signUp.status).toBe(200)

      const message = ctx.mailer.captured.last("verify-email")
      expect(message).toBeDefined()
      expect(message!.to).toBe(email)
      // SEC-1: the link is built from server.baseUrl, never from a header.
      expect(message!.html).toContain(
        "http://localhost:3000/verify-email?token="
      )

      // Unverified: password sign-in is refused (FR-AUTH-2).
      const beforeVerify = await ctx.auth.handler(
        authRequest("/sign-in/email", { json: { email, password } })
      )
      expect(beforeVerify.status).toBeGreaterThanOrEqual(400)

      const token = extractToken(message!.text)
      const verify = await ctx.auth.handler(
        authRequest(`/verify-email?token=${encodeURIComponent(token)}`, {
          method: "GET",
        })
      )
      expect(verify.status).toBeLessThan(400)

      const [row] = await ctx.database.db
        .select()
        .from(ctx.database.schema.user)
        .where(eq(ctx.database.schema.user.email, email))
      expect(row!.emailVerified).toBe(true)

      const afterVerify = await ctx.auth.handler(
        authRequest("/sign-in/email", { json: { email, password } })
      )
      expect(afterVerify.status).toBe(200)
    })

    it("sends a reset link and answers identically for an unknown address (FR-AUTH-3, SEC-7)", async () => {
      const email = `reset-${Date.now()}@example.com`
      await signUpAndVerify(ctx, email)
      ctx.mailer.captured.clear()

      const known = await ctx.auth.handler(
        authRequest("/request-password-reset", {
          json: { email, redirectTo: "/reset-password" },
        })
      )
      const unknown = await ctx.auth.handler(
        authRequest("/request-password-reset", {
          json: {
            email: `nobody-${Date.now()}@example.com`,
            redirectTo: "/reset-password",
          },
        })
      )

      // SEC-7: the response must not distinguish the two.
      expect(known.status).toBe(unknown.status)
      expect(await known.json()).toEqual(await unknown.json())

      // But only the real account gets a message.
      expect(ctx.mailer.captured.for(email)).toHaveLength(1)
      const message = ctx.mailer.captured.last("reset-password")!
      expect(message.html).toContain(
        "http://localhost:3000/reset-password?token="
      )

      const token = extractToken(message.text)
      const reset = await ctx.auth.handler(
        authRequest("/reset-password", {
          json: { token, newPassword: "a brand new passphrase" },
        })
      )
      expect(reset.status).toBe(200)

      // The new password works and the old one does not.
      expect(
        (
          await ctx.auth.handler(
            authRequest("/sign-in/email", { json: { email, password } })
          )
        ).status
      ).toBeGreaterThanOrEqual(400)
      expect(
        (
          await ctx.auth.handler(
            authRequest("/sign-in/email", {
              json: { email, password: "a brand new passphrase" },
            })
          )
        ).status
      ).toBe(200)
    })

    it("refuses a reset token the second time (FR-AUTH-3)", async () => {
      const email = `reuse-${Date.now()}@example.com`
      await signUpAndVerify(ctx, email)
      ctx.mailer.captured.clear()
      await ctx.auth.handler(
        authRequest("/request-password-reset", {
          json: { email, redirectTo: "/reset-password" },
        })
      )
      const token = extractToken(
        ctx.mailer.captured.last("reset-password")!.text
      )

      const first = await ctx.auth.handler(
        authRequest("/reset-password", {
          json: { token, newPassword: "first new passphrase" },
        })
      )
      expect(first.status).toBe(200)

      const second = await ctx.auth.handler(
        authRequest("/reset-password", {
          json: { token, newPassword: "second new passphrase" },
        })
      )
      expect(second.status).toBeGreaterThanOrEqual(400)
    })

    it("tells the owner when their password changed (FR-AUTH-3)", async () => {
      const email = `notify-${Date.now()}@example.com`
      await signUpAndVerify(ctx, email)
      ctx.mailer.captured.clear()
      await ctx.auth.handler(
        authRequest("/request-password-reset", {
          json: { email, redirectTo: "/reset-password" },
        })
      )
      const token = extractToken(
        ctx.mailer.captured.last("reset-password")!.text
      )
      await ctx.auth.handler(
        authRequest("/reset-password", {
          json: { token, newPassword: "yet another passphrase" },
        })
      )

      const notice = ctx.mailer.captured.last("password-changed")
      expect(notice).toBeDefined()
      expect(notice!.to).toBe(email)
    })
  })

  describe("the pending-sign-up notification (FR-SIGNUP-2)", () => {
    let ctx: TestContext
    const admin = "queue-watcher@example.com"
    const otherAdmin = "second-watcher@example.com"

    beforeAll(async () => {
      ctx = await createTestContext("pending-notify", {
        config: {
          signUp: { enabled: true, requireApproval: true },
          email: {
            resend: { apiKey: "re_test" },
            from: "IdP <idp@example.com>",
          },
          admin: { adminRoles: ["admin"] },
        },
      })

      // Two admins who can act on the queue, and three users who cannot:
      // a plain member, a pending admin, and a banned one.
      const context = await ctx.auth.$context
      for (const [email, role, status, banned] of [
        [admin, "admin", "active", false],
        [otherAdmin, "admin,user", "active", false],
        ["member@example.com", "user", "active", false],
        ["not-yet@example.com", "admin", "pending", false],
        ["turned-down@example.com", "admin", "rejected", false],
        ["suspended@example.com", "admin", "active", true],
      ] as const) {
        await context.internalAdapter.createUser(
          { email, name: email, emailVerified: true, role, banned },
          { method: "admin" }
        )
        // `user.create.before` forces an administratively-created user to
        // `active`, so the pending case has to be set afterwards.
        if (status !== "active") {
          await ctx.database.db
            .update(ctx.database.schema.user)
            .set({ status })
            .where(eq(ctx.database.schema.user.email, email))
        }
      }
    }, 120_000)
    afterAll(async () => await ctx.teardown())
    beforeEach(() => ctx.mailer.captured.clear())

    it("tells every active admin, and nobody else", async () => {
      const applicant = `applicant-${Date.now()}@example.com`
      const response = await ctx.auth.handler(
        authRequest("/sign-up/email", {
          json: { email: applicant, password, name: "Ada Applicant" },
        })
      )
      expect(response.status).toBe(200)

      const notices = ctx.mailer.captured.messages.filter(
        (message) => message.template === "pending-signup"
      )
      expect(notices.map((message) => message.to).sort()).toEqual(
        [admin, otherAdmin].sort()
      )
      // The address that applied belongs in the body, not the recipient list.
      expect(notices[0]!.text).toContain(applicant)
    })

    it("says nothing when an administrator creates the account", async () => {
      // Already active: there is no queue and nobody is waiting.
      const context = await ctx.auth.$context
      await context.internalAdapter.createUser(
        {
          email: `made-by-admin-${Date.now()}@example.com`,
          name: "Made By Admin",
          emailVerified: true,
        },
        { method: "admin" }
      )

      expect(
        ctx.mailer.captured.messages.filter(
          (message) => message.template === "pending-signup"
        )
      ).toHaveLength(0)
    })
  })

  describe("in degraded mode (FR-MAIL-2)", () => {
    let ctx: TestContext

    beforeAll(async () => {
      ctx = await createTestContext("email-off", {
        config: {
          signUp: { enabled: true, requireApproval: true },
          auth: { requireEmailVerification: true },
        },
      })
    }, 120_000)
    afterAll(async () => await ctx.teardown())

    it("forces e-mail verification off", () => {
      expect(ctx.config.emailEnabled).toBe(false)
      expect(ctx.config.requireEmailVerification).toBe(false)
      expect(ctx.mailer.enabled).toBe(false)
    })

    it("sends nothing at all", async () => {
      const email = `degraded-${Date.now()}@example.com`
      const signUp = await ctx.auth.handler(
        authRequest("/sign-up/email", {
          json: { email, password, name: "Dee Graded" },
        })
      )
      expect(signUp.status).toBe(200)
      expect(ctx.mailer.captured.messages).toHaveLength(0)
    })

    it("still runs sign-up through to approval end to end", async () => {
      const email = `degraded-flow-${Date.now()}@example.com`
      await ctx.auth.handler(
        authRequest("/sign-up/email", {
          json: { email, password, name: "Dee Graded" },
        })
      )

      const pending = await ctx.auth.handler(
        authRequest("/sign-in/email", { json: { email, password } })
      )
      expect(pending.status).toBeGreaterThanOrEqual(400)

      await ctx.database.db
        .update(ctx.database.schema.user)
        .set({ status: "active", approvedAt: new Date(), approvedBy: "admin" })
        .where(eq(ctx.database.schema.user.email, email))

      const approved = await ctx.auth.handler(
        authRequest("/sign-in/email", { json: { email, password } })
      )
      expect(approved.status).toBe(200)
      expect(ctx.mailer.captured.messages).toHaveLength(0)
    })
  })
})

/**
 * Signs a user up and clicks the verification link, so a later assertion is
 * about the thing it names rather than about FR-AUTH-2 still gating sign-in.
 */
async function signUpAndVerify(ctx: TestContext, email: string): Promise<void> {
  const password = "correct horse battery staple"
  const signUp = await ctx.auth.handler(
    authRequest("/sign-up/email", {
      json: { email, password, name: "Test User" },
    })
  )
  if (signUp.status !== 200) throw new Error(`sign-up failed: ${signUp.status}`)

  const token = extractToken(ctx.mailer.captured.last("verify-email")!.text)
  const verify = await ctx.auth.handler(
    authRequest(`/verify-email?token=${encodeURIComponent(token)}`, {
      method: "GET",
    })
  )
  if (verify.status >= 400)
    throw new Error(`verification failed: ${verify.status}`)
}

/** Pulls the `token` query parameter out of a message's plain-text body. */
function extractToken(text: string): string {
  const match = /[?&]token=([^\s&]+)/.exec(text)
  if (!match) throw new Error(`No token in message:\n${text}`)
  return decodeURIComponent(match[1]!)
}
