import { describe, expect, it } from "vitest"

import { auditEventFor, isRedirect } from "@/server/auth/options/hooks"
import {
  plainAuditFor,
  rememberEndingImpersonation,
} from "@/server/admin/guard"

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

  it("records a token that was actually issued (FR-OIDC-5)", () => {
    expect(auditEventFor("/oauth2/token", true)?.action).toBe("token.issued")
    // A refused grant issued nothing, and the client already has the
    // protocol error; a `token.issued` row with outcome "failure" would read
    // as a token that exists.
    expect(auditEventFor("/oauth2/token", false)).toBeUndefined()
  })

  it("says nothing about endpoints that are not events", () => {
    // This runs on every request, so the unmatched case is the hot path.
    for (const path of [
      "/get-session",
      "/ok",
      "/jwks",
      "/list-sessions",
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

describe("a redirect is a success, not a failure (SEC-6)", () => {
  /** The shape better-calls own `ctx.redirect` throws. */
  function redirect(statusCode: number): Error {
    return Object.assign(new Error("redirect"), { statusCode })
  }

  it("tells a thrown redirect apart from a thrown failure", () => {
    // `ctx.redirect(url)` builds an APIError with a 302 and the endpoint
    // *throws* it, so "did it throw" is not "did it fail". Every confirmed
    // e-mail address was recorded as `email.verified failure` until these were
    // told apart: the endpoint answers a redirect to its `callbackURL` on the
    // success path, and only on the success path.
    expect(isRedirect(redirect(302))).toBe(true)
    expect(isRedirect(redirect(303))).toBe(true)
    expect(isRedirect(redirect(400))).toBe(false)
    expect(isRedirect(redirect(500))).toBe(false)
    expect(isRedirect(new Error("boom"))).toBe(false)
  })
})

/**
 * The `/admin/*` half of the trail (**D66**).
 *
 * `guard.ts` owns it. Three endpoints produced no row at all before — so a
 * `curl` to `/admin/create-user` created an account and left no trace, which
 * FR-ADMIN-6 does not allow of a supported interface — and a fourth,
 * `impersonation.stopped`, was declared and never written by anything.
 *
 * The two degradations are asserted rather than only commented: the target of
 * a creation comes out of the response, because the account did not exist when
 * the request was made, and there is no `temporary` flag on a password change,
 * because that is a property of the route rather than of the endpoint.
 */
describe("plainAuditFor", () => {
  const ctx = (over: Record<string, unknown> = {}) =>
    ({ context: { returned: undefined, session: undefined, ...over } }) as never

  it("takes a created user's id from what the endpoint returned", () => {
    expect(
      plainAuditFor("/admin/create-user", ctx({ returned: { user: { id: "u1" } } }), {
        role: ["admin", "user"],
      })
    ).toEqual({
      action: "user.created",
      targetId: "u1",
      metadata: { by: "admin", roles: ["admin", "user"] },
    })
  })

  it("says nothing when the creation returned no user", () => {
    expect(plainAuditFor("/admin/create-user", ctx(), {})).toBeUndefined()
  })

  it("records a password change with no `temporary` flag", () => {
    expect(
      plainAuditFor("/admin/set-user-password", ctx(), { userId: "u2" })
    ).toEqual({ action: "password.changed", targetId: "u2" })
  })

  it("records a session revocation as covering all of them, and ends access", () => {
    // `endsAccess` is the half that was missing (**D67**): the admin plugin
    // deletes `session` rows and knows nothing about OAuth, so without it a
    // direct API call signed the browser out and left the refresh token
    // minting access tokens. It used to be done by the route handler behind
    // the button, which no API caller goes through.
    expect(
      plainAuditFor("/admin/revoke-user-sessions", ctx(), { userId: "u3" })
    ).toEqual({
      action: "session.revoked",
      targetId: "u3",
      metadata: { scope: "all" },
      endsAccess: true,
    })
  })

  it("does not end access for the other two", () => {
    // Creating an account and setting a password are not "sign them out
    // everywhere"; revoking tokens there would be a surprise.
    expect(
      plainAuditFor("/admin/set-user-password", ctx(), { userId: "u2" })
        ?.endsAccess
    ).toBeUndefined()
    expect(
      plainAuditFor(
        "/admin/create-user",
        ctx({ returned: { user: { id: "u1" } } }),
        {}
      )?.endsAccess
    ).toBeUndefined()
  })

  it("aims a stopped impersonation at the right two people", () => {
    // The identity comes from the *before* hook, because by the time the
    // after hook runs the impersonated session row is gone and what the
    // endpoint returned is the administrator's restored session.
    const request = ctx() as { context: object }
    rememberEndingImpersonation(request.context, {
      impersonated: "victim",
      by: "admin-1",
    })
    expect(
      plainAuditFor("/admin/stop-impersonating", request as never, {})
    ).toEqual({
      action: "impersonation.stopped",
      targetId: "victim",
      actorId: "admin-1",
    })
  })

  it("says nothing when the before hook could not read the session", () => {
    // Better than a row naming nobody: `/admin/stop-impersonating` declares no
    // session middleware, so this is a real branch rather than a defensive one.
    expect(
      plainAuditFor("/admin/stop-impersonating", ctx(), {})
    ).toBeUndefined()
  })

  it("has no opinion about anything else", () => {
    expect(plainAuditFor("/admin/ban-user", ctx(), { userId: "u4" })).toBeUndefined()
    expect(plainAuditFor("/get-session", ctx(), {})).toBeUndefined()
  })
})
