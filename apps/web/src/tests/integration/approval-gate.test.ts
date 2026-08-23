import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { eq } from "drizzle-orm"

import { authRequest, createTestContext } from "./harness"
import type { TestContext } from "./harness"

/**
 * FR-SIGNUP-2: a non-`active` user obtains **no session on any path**, and the
 * rule is enforced in one place (the session-creation hook) rather than per
 * route. This suite covers the password path; the social, refresh-grant and
 * API-key paths get the same treatment in their own milestones and re-check
 * state on every use.
 *
 * FR-SIGNUP-3's domain restriction is here too, because it is the other half of
 * the same hook.
 */
describe("approval gate (FR-SIGNUP-2/3)", () => {
  const password = "correct horse battery staple"

  describe("with approval required", () => {
    let ctx: TestContext

    beforeAll(async () => {
      ctx = await createTestContext("approval-on", {
        config: { signUp: { enabled: true, requireApproval: true } },
      })
    }, 120_000)
    afterAll(async () => await ctx.teardown())

    it("lands a self-registration as pending and refuses the sign-in", async () => {
      const email = `pending-${Date.now()}@example.com`

      const signUp = await ctx.auth.handler(
        authRequest("/sign-up/email", {
          json: { email, password, name: "Pat Pending" },
        })
      )
      expect(signUp.status).toBe(200)

      const [row] = await ctx.database.db
        .select()
        .from(ctx.database.schema.user)
        .where(eq(ctx.database.schema.user.email, email))
      expect(row!.status).toBe("pending")
      expect(row!.approvedAt).toBeNull()

      const signIn = await ctx.auth.handler(
        authRequest("/sign-in/email", { json: { email, password } })
      )
      expect(signIn.status).toBeGreaterThanOrEqual(400)
      expect(await signIn.text()).toContain("ACCOUNT_PENDING_APPROVAL")

      // And no session row was created for them.
      const sessions = await ctx.database.db
        .select()
        .from(ctx.database.schema.session)
        .where(eq(ctx.database.schema.session.userId, row!.id))
      expect(sessions).toHaveLength(0)
    })

    it("lets the same credentials through once the user is active", async () => {
      const email = `approved-${Date.now()}@example.com`
      await ctx.auth.handler(
        authRequest("/sign-up/email", {
          json: { email, password, name: "Ada Approved" },
        })
      )

      // Stand in for the admin approval endpoint (M5): the gate reads `status`.
      await ctx.database.db
        .update(ctx.database.schema.user)
        .set({
          status: "active",
          approvedAt: new Date(),
          approvedBy: "admin-1",
        })
        .where(eq(ctx.database.schema.user.email, email))

      const signIn = await ctx.auth.handler(
        authRequest("/sign-in/email", { json: { email, password } })
      )
      expect(signIn.status).toBe(200)
    })

    it("refuses a rejected user with a neutral message (FR-SIGNUP-2)", async () => {
      const email = `rejected-${Date.now()}@example.com`
      await ctx.auth.handler(
        authRequest("/sign-up/email", {
          json: { email, password, name: "Rey Rejected" },
        })
      )
      // The row stays, so the address remains reserved.
      await ctx.database.db
        .update(ctx.database.schema.user)
        .set({ status: "rejected" })
        .where(eq(ctx.database.schema.user.email, email))

      const rejected = await ctx.auth.handler(
        authRequest("/sign-in/email", { json: { email, password } })
      )
      expect(rejected.status).toBeGreaterThanOrEqual(400)
      const body = (await rejected.json()) as {
        message?: string
        code?: string
      }
      expect(body.code).toBe("ACCOUNT_REJECTED")
      // Neutral: it does not say the account was rejected, only that it is
      // unavailable, and it reads the same as any other unavailable account.
      expect(body.message).toBe("This account is not available.")
    })

    it("refuses a banned user, and says so (FR-ADMIN-4)", async () => {
      const email = `banned-${Date.now()}@example.com`
      await ctx.auth.handler(
        authRequest("/sign-up/email", {
          json: { email, password, name: "Bo Banned" },
        })
      )
      await ctx.database.db
        .update(ctx.database.schema.user)
        .set({ status: "active", banned: true, banReason: "spam" })
        .where(eq(ctx.database.schema.user.email, email))

      const banned = await ctx.auth.handler(
        authRequest("/sign-in/email", { json: { email, password } })
      )
      expect(banned.status).toBeGreaterThanOrEqual(400)
      // A ban is deliberately *not* neutral: FR-ADMIN-4 says the user is shown
      // the reason and expiry, so they know to appeal rather than retry.
      expect((await banned.json()).message).toMatch(/banned/i)
    })

    it("gives the same answer for a wrong password and an unknown address (SEC-7)", async () => {
      const email = `known-${Date.now()}@example.com`
      await ctx.auth.handler(
        authRequest("/sign-up/email", {
          json: { email, password, name: "Nora Known" },
        })
      )
      await ctx.database.db
        .update(ctx.database.schema.user)
        .set({ status: "active" })
        .where(eq(ctx.database.schema.user.email, email))

      const wrongPassword = await ctx.auth.handler(
        authRequest("/sign-in/email", {
          json: { email, password: "not the password" },
        })
      )
      const unknownEmail = await ctx.auth.handler(
        authRequest("/sign-in/email", {
          json: { email: `nobody-${Date.now()}@example.com`, password },
        })
      )

      expect(wrongPassword.status).toBe(unknownEmail.status)
      expect(await wrongPassword.json()).toEqual(await unknownEmail.json())
    })

    it("lets an expired ban through again (FR-ADMIN-4)", async () => {
      const email = `unbanned-${Date.now()}@example.com`
      await ctx.auth.handler(
        authRequest("/sign-up/email", {
          json: { email, password, name: "Tem Porary" },
        })
      )
      await ctx.database.db
        .update(ctx.database.schema.user)
        .set({
          status: "active",
          banned: true,
          banExpires: new Date(Date.now() - 60_000),
        })
        .where(eq(ctx.database.schema.user.email, email))

      const signIn = await ctx.auth.handler(
        authRequest("/sign-in/email", { json: { email, password } })
      )
      expect(signIn.status).toBe(200)
    })
  })

  describe("with approval switched off", () => {
    let ctx: TestContext

    beforeAll(async () => {
      ctx = await createTestContext("approval-off", {
        config: { signUp: { enabled: true, requireApproval: false } },
      })
    }, 120_000)
    afterAll(async () => await ctx.teardown())

    it("activates a self-registration immediately", async () => {
      const email = `instant-${Date.now()}@example.com`
      await ctx.auth.handler(
        authRequest("/sign-up/email", {
          json: { email, password, name: "Immy Diate" },
        })
      )

      const [row] = await ctx.database.db
        .select()
        .from(ctx.database.schema.user)
        .where(eq(ctx.database.schema.user.email, email))
      expect(row!.status).toBe("active")
      // Not admin-approved, so no approval trail is invented.
      expect(row!.approvedBy).toBeNull()

      const signIn = await ctx.auth.handler(
        authRequest("/sign-in/email", { json: { email, password } })
      )
      expect(signIn.status).toBe(200)
    })
  })

  describe("with a domain restriction (FR-SIGNUP-3)", () => {
    let ctx: TestContext

    beforeAll(async () => {
      ctx = await createTestContext("domain-restriction", {
        config: {
          signUp: {
            enabled: true,
            requireApproval: false,
            allowedEmailDomains: ["example.com"],
          },
        },
      })
    }, 120_000)
    afterAll(async () => await ctx.teardown())

    it("accepts a listed domain", async () => {
      const response = await ctx.auth.handler(
        authRequest("/sign-up/email", {
          json: {
            email: `allowed-${Date.now()}@example.com`,
            password,
            name: "In Scope",
          },
        })
      )
      expect(response.status).toBe(200)
    })

    it("refuses an unlisted domain", async () => {
      const email = `blocked-${Date.now()}@gmail.com`
      const response = await ctx.auth.handler(
        authRequest("/sign-up/email", {
          json: { email, password, name: "Out Of Scope" },
        })
      )
      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(await response.text()).toContain("EMAIL_DOMAIN_NOT_ALLOWED")

      const rows = await ctx.database.db
        .select()
        .from(ctx.database.schema.user)
        .where(eq(ctx.database.schema.user.email, email))
      expect(rows).toHaveLength(0)
    })

    it("matches the domain case-insensitively", async () => {
      const response = await ctx.auth.handler(
        authRequest("/sign-up/email", {
          json: {
            email: `Mixed-${Date.now()}@EXAMPLE.com`,
            password,
            name: "Case Fold",
          },
        })
      )
      expect(response.status).toBe(200)
    })
  })
})
