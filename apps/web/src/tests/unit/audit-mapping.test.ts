import { describe, expect, it } from "vitest"

import { auditEventFor } from "@/server/auth/options/hooks"

/**
 * SEC-6 — which endpoint produces which audit event.
 *
 * Three of the twenty-nine actions were being written before this hook
 * existed: the two the approval endpoints emit, and `signup.created` from the
 * bootstrap step. A sign-in left no row at all, which makes "who got in"
 * unanswerable — the first question anyone asks of an audit log.
 *
 * The mapping is asserted here rather than through the database because the
 * hook runs on *every* endpoint, `/get-session` included, so "returns nothing
 * for an unmatched path" is as much a requirement as the matches are.
 */
describe("auditEventFor", () => {
  it("records a sign-in either way", () => {
    expect(auditEventFor("/sign-in/email", true)).toEqual({
      action: "signin.success",
      outcome: "success",
    })
    expect(auditEventFor("/sign-in/email", false)).toEqual({
      action: "signin.failure",
      outcome: "failure",
    })
  })

  it("treats the social callback as the sign-in, not the redirect out", () => {
    // `/sign-in/social` only sends the browser to the provider; nothing is
    // settled until it comes back.
    expect(auditEventFor("/callback/google", true)?.action).toBe(
      "signin.success"
    )
    expect(auditEventFor("/callback/entra-id", false)?.action).toBe(
      "signin.failure"
    )
    expect(auditEventFor("/sign-in/social", true)).toBeUndefined()
  })

  it("records a registration only when one happened", () => {
    expect(auditEventFor("/sign-up/email", true)).toEqual({
      action: "signup.created",
      outcome: "success",
    })
    // No `signup.failed` exists in the SEC-6 action list, and a refused
    // registration created nothing to point an event at.
    expect(auditEventFor("/sign-up/email", false)).toBeUndefined()
  })

  it("records a reset request whether or not the address exists", () => {
    // SEC-7 makes the *response* uniform. The attempt still belongs on record.
    for (const path of ["/forget-password", "/request-password-reset"]) {
      expect(auditEventFor(path, true)?.action).toBe("password.reset_requested")
      expect(auditEventFor(path, false)?.action).toBe(
        "password.reset_requested"
      )
    }
  })

  it("distinguishes completing a reset from changing a password", () => {
    expect(auditEventFor("/reset-password", true)?.action).toBe(
      "password.reset_completed"
    )
    expect(auditEventFor("/change-password", true)?.action).toBe(
      "password.changed"
    )
    expect(auditEventFor("/verify-email", true)?.action).toBe("email.verified")
  })

  it("records every way a session ends", () => {
    for (const path of [
      "/sign-out",
      "/revoke-session",
      "/revoke-sessions",
      "/revoke-other-sessions",
    ]) {
      expect(auditEventFor(path, true)?.action).toBe("session.revoked")
    }
  })

  it("does not call a 2FA challenge a sign-in (FR-2FA-1)", () => {
    // The password was right, but Better Auth answered with a challenge and
    // no session. Recording success here would put "signed in" in the trail
    // for someone who may still fail the second factor.
    expect(
      auditEventFor("/sign-in/email", true, { twoFactorPending: true })
    ).toBeUndefined()
    expect(
      auditEventFor("/callback/google", true, { twoFactorPending: true })
    ).toBeUndefined()

    // A *failed* sign-in is still a failed sign-in, challenge or not.
    expect(
      auditEventFor("/sign-in/email", false, { twoFactorPending: true })?.action
    ).toBe("signin.failure")
  })

  it("records the sign-in at the far end of the challenge", () => {
    for (const path of [
      "/two-factor/verify-totp",
      "/two-factor/verify-backup-code",
      "/two-factor/verify-otp",
    ]) {
      expect(auditEventFor(path, true)?.action).toBe("signin.success")
      expect(auditEventFor(path, false)?.action).toBe("signin.failure")
    }
  })

  it("records enrolment only when it succeeded (FR-2FA-1)", () => {
    expect(auditEventFor("/two-factor/enable", true)?.action).toBe(
      "twofactor.enabled"
    )
    expect(auditEventFor("/two-factor/disable", true)?.action).toBe(
      "twofactor.disabled"
    )
    // A refused enrolment changed nothing; there is no honest action for it.
    expect(auditEventFor("/two-factor/enable", false)).toBeUndefined()
    expect(auditEventFor("/two-factor/disable", false)).toBeUndefined()
  })

  it("says nothing about endpoints that are not events", () => {
    // This runs on every request, so the unmatched case is the hot path.
    for (const path of [
      "/get-session",
      "/ok",
      "/jwks",
      "/list-sessions",
      "/oauth2/token",
      "",
      "/callback",
      "/two-factor/get-totp-uri",
      "/two-factor/generate-backup-codes",
    ]) {
      expect(auditEventFor(path, true)).toBeUndefined()
      expect(auditEventFor(path, false)).toBeUndefined()
    }
  })
})
