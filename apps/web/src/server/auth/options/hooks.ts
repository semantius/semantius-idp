/**
 * Request hooks that run before Better Auth's own endpoint handlers.
 *
 * Two things live here, both of which have to happen *before* validation or the
 * endpoint's own logic:
 *
 * - **E-mail normalisation (FR-AUTH-1).** "E-mails are trimmed and lower-cased
 *   everywhere." Doing it in a database hook is too late: the endpoint's schema
 *   rejects `" User@Example.com "` as malformed before any row is written, so a
 *   user who copied their address with a trailing space gets an unhelpful
 *   error instead of being signed in.
 *
 * - **Default audience injection (FR-OIDC-6, risk R1)** — added in M8. The
 *   OAuth provider only issues a JWT access token when a `resource` resolves,
 *   so a client that sends none must have `jwt.audience` supplied for it.
 *
 * The **after** hook is the SEC-6 trail for everything Better Auth owns. Three
 * of the twenty-nine audit actions were being written before this: the two the
 * approval endpoints emit, and `signup.created` from the bootstrap step. A
 * sign-in — success or failure — left no row at all, which makes "who got in"
 * unanswerable, and that is the first question anyone asks of an audit log.
 *
 * One hook keyed on the endpoint path rather than a `record()` call per route.
 * A new route cannot forget to audit, and the mapping is one table to read.
 */

import { createAuthMiddleware } from "better-auth/api"

import type { BetterAuthOptions } from "better-auth"

import type { Audit, AuditOutcome } from "../../audit"
import type { IdpConfig } from "../../config/derive"
import type { AuditAction } from "../plugins/idp-plugin"
import { normalizeEmail } from "./social"

/**
 * Endpoints whose body carries an address the user typed. Matching on an exact
 * list rather than "any body with an `email` key" keeps the rewrite away from
 * bodies where the value is a filter or a label rather than an identity.
 */
const EMAIL_BODY_PATHS = new Set([
  "/sign-up/email",
  "/sign-in/email",
  "/forget-password",
  "/request-password-reset",
  "/send-verification-email",
  "/change-email",
  "/admin/create-user",
  "/admin/update-user",
])

/** Body keys that hold an address on those endpoints. */
const EMAIL_BODY_KEYS = ["email", "newEmail"] as const

export function buildBeforeHook(
  _config: IdpConfig
): NonNullable<BetterAuthOptions["hooks"]>["before"] {
  return createAuthMiddleware(async (ctx) => {
    normalizeEmailFields(
      ctx.path,
      ctx.body as Record<string, unknown> | undefined
    )
  })
}

/** Exported for the unit test; mutates in place, which is what the middleware needs. */
export function normalizeEmailFields(
  path: string,
  body: Record<string, unknown> | undefined
): void {
  if (!body || !EMAIL_BODY_PATHS.has(path)) return
  for (const key of EMAIL_BODY_KEYS) {
    const value = body[key]
    if (typeof value === "string") body[key] = normalizeEmail(value)
  }
}


/** What the response told us that the path alone cannot. */
export interface AuditHints {
  /**
   * The endpoint answered with `twoFactorRedirect` — a challenge, not a
   * session (FR-2FA-1).
   */
  twoFactorPending?: boolean
}

/**
 * Which SEC-6 event an endpoint produces, if any.
 *
 * Pure and exported so the mapping is testable without a database or a
 * request. Returning `undefined` is the common case — this runs on every
 * endpoint, `/get-session` included, so an unmatched path must be cheap.
 */
export function auditEventFor(
  path: string,
  ok: boolean,
  hints: AuditHints = {}
): { action: AuditAction; outcome: AuditOutcome } | undefined {
  const outcome: AuditOutcome = ok ? "success" : "failure"

  // Social sign-in arrives as `/callback/:providerId` on the way back, and as
  // `/sign-in/social` on the way out; only the callback settles anything.
  if (path === "/sign-in/email" || path.startsWith("/callback/")) {
    // A 2FA challenge is not a sign-in yet (FR-2FA-1). The endpoint answered
    // 200 with `twoFactorRedirect`, no session exists, and the user may still
    // fail the second factor — recording success here would put "signed in"
    // in the trail for someone who never was.
    if (ok && hints.twoFactorPending) return undefined
    return { action: ok ? "signin.success" : "signin.failure", outcome }
  }

  // The other end of that challenge: this is where the sign-in settles.
  if (
    path === "/two-factor/verify-totp" ||
    path === "/two-factor/verify-backup-code" ||
    path === "/two-factor/verify-otp"
  ) {
    return { action: ok ? "signin.success" : "signin.failure", outcome }
  }

  switch (path) {
    case "/sign-up/email":
      // Only on success: a rejected registration created nothing, and there
      // is no `signup.failed` in the SEC-6 action list to describe it
      // honestly. The domain and approval refusals are logged by the hook
      // that raises them.
      return ok ? { action: "signup.created", outcome } : undefined
    case "/verify-email":
      return { action: "email.verified", outcome }
    case "/forget-password":
    case "/request-password-reset":
      // Recorded whether or not the address exists — the response is uniform
      // by SEC-7, and the attempt is the thing worth having on record.
      return { action: "password.reset_requested", outcome }
    case "/reset-password":
      return { action: "password.reset_completed", outcome }
    case "/change-password":
      return { action: "password.changed", outcome }
    case "/two-factor/enable":
      // Only on success — a refused enrolment changed nothing (FR-2FA-1).
      return ok ? { action: "twofactor.enabled", outcome } : undefined
    case "/two-factor/disable":
      return ok ? { action: "twofactor.disabled", outcome } : undefined
    case "/sign-out":
    case "/revoke-session":
    case "/revoke-sessions":
    case "/revoke-other-sessions":
      return { action: "session.revoked", outcome }
    default:
      return undefined
  }
}

export interface AfterHookDeps {
  config: IdpConfig
  /** Absent during schema generation and before the database is up. */
  audit?: Audit
}

/**
 * Whether the endpoint answered with a 2FA challenge rather than a session.
 *
 * Better Auth returns `{ twoFactorRedirect: true }` from `/sign-in/*` with a
 * 200, so the status code cannot tell the two apart.
 */
function isTwoFactorChallenge(returned: unknown): boolean {
  return (
    (returned as { twoFactorRedirect?: unknown } | undefined)
      ?.twoFactorRedirect === true
  )
}

/** The user this request settled on, when the endpoint returned one. */
function subjectOf(returned: unknown, session: unknown): string | undefined {
  const fromResult = (returned as { user?: { id?: unknown } } | undefined)?.user
    ?.id
  if (typeof fromResult === "string") return fromResult
  const fromSession = (session as { user?: { id?: unknown } } | undefined)?.user
    ?.id
  return typeof fromSession === "string" ? fromSession : undefined
}

export function buildAfterHook(
  deps: AfterHookDeps
): NonNullable<BetterAuthOptions["hooks"]>["after"] {
  return createAuthMiddleware(async (ctx) => {
    const audit = deps.audit
    if (!audit) return

    const context = ctx.context as {
      returned?: unknown
      session?: unknown
    }
    // Better Auth hands the endpoint's return value here, or an `APIError`
    // when it threw. That is the whole success signal — verified against the
    // live hook rather than assumed.
    const returned = context.returned
    const ok = !(returned instanceof Error)

    const event = auditEventFor(ctx.path, ok, {
      twoFactorPending: isTwoFactorChallenge(returned),
    })
    if (!event) return

    const userId = subjectOf(returned, context.session)

    await audit.record({
      ...event,
      actorType: userId ? "session" : "anonymous",
      actorUserId: userId,
      ...(userId ? { target: { type: "user", id: userId } } : {}),
      userAgent: ctx.headers?.get("user-agent") ?? null,
      // `ipAddress` waits for M11's `clientIpFrom`, which needs `trustProxy`
      // to decide which forwarded hop to believe (SEC-2).
    })
  })
}
