/**
 * Request hooks that run before Better Auth's own endpoint handlers.
 *
 * Two things live here, both of which have to happen *before* validation or the
 * endpoint's own logic:
 *
 * - **E-mail normalization (FR-AUTH-1).** "E-mails are trimmed and lower-cased
 *   everywhere." Doing it in a database hook is too late: the endpoint's schema
 *   rejects `" User@Example.com "` as malformed before any row is written, so a
 *   user who copied their address with a trailing space gets an unhelpful
 *   error instead of being signed in.
 *
 * - **Default audience injection (FR-OIDC-6, risk R1).** The OAuth provider
 *   only issues a JWT access token when a `resource` resolves — no `resource`
 *   means no `aud`, which means an *opaque* token, which is precisely the
 *   failure FR-OIDC-5/6 exists to prevent. So a request that names none has
 *   one supplied: the client's own `audience` if it declares one, otherwise
 *   `jwt.audience`.
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

import { APIError, createAuthMiddleware } from "better-auth/api"
import { eq } from "drizzle-orm"

import type { BetterAuthOptions } from "better-auth"

import type { Audit, AuditOutcome } from "../../audit"
import type { IdpConfig } from "../../config/derive"
import type { DbHandle } from "../../db/client"
import type { Logger } from "../../logger"
import { revokeExpiredRefreshFamilies } from "../../oidc/refresh-lifetime"
import type { AuditAction } from "../plugins/idp-plugin"
import { checkPasswordBreach } from "../password-breach"
import { clearTrustedDevices } from "../trusted-devices"
import type { BreachCheckDeps } from "../password-breach"
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

export interface BeforeHookDeps {
  config: IdpConfig
  /** Absent during schema generation. */
  database?: DbHandle
  logger?: Logger
  /** Injected by tests so the breach check never leaves the process. */
  breachFetch?: BreachCheckDeps["fetchImpl"]
}

/**
 * Endpoints where the caller is *choosing* a password (FR-AUTH-1).
 *
 * Sign-in is deliberately absent: refusing an existing password at sign-in
 * would lock a user out of their own account over a corpus they cannot do
 * anything about from a login form. The check belongs where a new value is
 * being set, which is also the only place the user can act on the answer.
 */
const PASSWORD_CHOICE_PATHS: Record<string, string> = {
  "/sign-up/email": "password",
  "/reset-password": "newPassword",
  "/change-password": "newPassword",
  "/admin/set-user-password": "newPassword",
}

export function buildBeforeHook(
  deps: BeforeHookDeps
): NonNullable<BetterAuthOptions["hooks"]>["before"] {
  const { config } = deps
  return createAuthMiddleware(async (ctx) => {
    normalizeEmailFields(
      ctx.path,
      ctx.body as Record<string, unknown> | undefined
    )
    injectDefaultResource(ctx, config)

    // FR-OIDC-13's absolute ceiling, enforced immediately before the grant
    // that would otherwise extend it. Revoking first means the presented
    // token is already dead when the provider looks at it, so an over-age
    // family gets the ordinary `invalid_grant` instead of a special case.
    const body = ctx.body as Record<string, unknown> | undefined

    await assertPasswordNotBreached(ctx.path, body, deps)
    await rememberRevokedSession(ctx, deps)

    if (ctx.path === "/oauth2/token" && body?.grant_type === "refresh_token") {
      await revokeExpiredRefreshFamilies(deps)
    }
  })
}

/**
 * Which session a `session.revoked` row is about, resolved while the row
 * still exists.
 *
 * The after hook cannot answer this. `/sign-out` and `/revoke-session` have
 * both deleted the row by the time it runs, and neither returns anything that
 * names it — `/sign-out` answers `{ success: true }` and does not even carry
 * a `sessionMiddleware`, so `ctx.context.session` is unset. So the before hook
 * looks it up and leaves it here, the way `admin/guard.ts` carries an ending
 * impersonation across the same gap.
 *
 * Keyed on `ctx.context`, which is per-request — Better Auth puts `returned`
 * and `responseHeaders` on it — in a `WeakMap`, so a request that never
 * reaches the after hook leaves nothing behind.
 */
const REVOKED_SESSION = new WeakMap<
  object,
  { sessionId: string; userId: string }
>()

async function rememberRevokedSession(
  ctx: {
    path: string
    context: object & { authCookies?: unknown; secret?: unknown }
    body?: unknown
    getSignedCookie?: (
      name: string,
      secret: string
    ) => Promise<string | false | null | undefined>
  },
  deps: BeforeHookDeps
): Promise<void> {
  const database = deps.database
  if (!database) return

  const token = await revokedSessionToken(ctx)
  if (!token) return

  try {
    const { session } = database.schema
    const [row] = await database.db
      .select({ id: session.id, userId: session.userId })
      .from(session)
      .where(eq(session.token, token))
      .limit(1)
    if (row)
      REVOKED_SESSION.set(ctx.context, {
        sessionId: row.id,
        userId: row.userId,
      })
  } catch (error) {
    // A trail that names the session is better than one that does not, and
    // neither is worth failing a sign-out over. The metadata is simply
    // omitted.
    deps.logger?.error("could not resolve the session being revoked", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/** The session token the request is about to end, if the path names one. */
async function revokedSessionToken(ctx: {
  path: string
  context: object & { authCookies?: unknown; secret?: unknown }
  body?: unknown
  getSignedCookie?: (
    name: string,
    secret: string
  ) => Promise<string | false | null | undefined>
}): Promise<string | undefined> {
  if (ctx.path === "/revoke-session") {
    const token = (ctx.body as { token?: unknown } | undefined)?.token
    return typeof token === "string" && token !== "" ? token : undefined
  }
  if (ctx.path !== "/sign-out") return undefined

  // The caller's own cookie. Signed, so this cannot be read off the header:
  // Better Auth's own accessor is what verifies the HMAC.
  const cookies = ctx.context.authCookies as
    | { sessionToken?: { name?: unknown } }
    | undefined
  const name = cookies?.sessionToken?.name
  const secret = ctx.context.secret
  if (typeof name !== "string" || typeof secret !== "string") return undefined
  const value = await ctx.getSignedCookie?.(name, secret)
  return typeof value === "string" && value !== "" ? value : undefined
}

/**
 * Which kind of "sign out" a `session.revoked` row describes.
 *
 * Pure and exported for the same reason `auditEventFor` is: the vocabulary
 * (`all`) is the admin guard's, so the two halves of the trail can be read
 * together, and a table of four paths deserves a table of four assertions
 * rather than a database.
 */
export function sessionRevocationScope(
  path: string
): "current" | "one" | "all" | "others" | undefined {
  switch (path) {
    case "/sign-out":
      return "current"
    case "/revoke-session":
      return "one"
    case "/revoke-sessions":
      return "all"
    case "/revoke-other-sessions":
      return "others"
    default:
      return undefined
  }
}

/**
 * FR-AUTH-1: refuses a password that is already in a breach corpus.
 *
 * Only when `auth.password.breachCheck` is on, and only where a password is
 * being *chosen*. A service failure allows the password — see
 * `password-breach.ts` for why — so this can only ever add a refusal, never
 * take a working sign-up away because a third party is down.
 */
async function assertPasswordNotBreached(
  path: string,
  body: Record<string, unknown> | undefined,
  deps: BeforeHookDeps
): Promise<void> {
  if (!deps.config.file.auth.password.breachCheck) return
  const field = PASSWORD_CHOICE_PATHS[path]
  if (!field) return
  const password = body?.[field]
  if (typeof password !== "string" || password === "") return

  const result = await checkPasswordBreach(password, {
    logger: deps.logger,
    fetchImpl: deps.breachFetch,
  })
  if (!result.breached) return

  // The count is never shown. "Seen 3,730,471 times" tells the user nothing
  // they can act on and tells anyone watching the response exactly which
  // password was tried.
  throw new APIError("BAD_REQUEST", {
    code: "PASSWORD_BREACHED",
    message:
      "That password has appeared in a public data breach. Choose a different one.",
  })
}

/**
 * The two entry points a `resource` can arrive through, and why both matter
 * (S1):
 *
 * - **authorize** — the value is stored in the authorization-code record and
 *   travels to the code grant, and from there into the refresh token's
 *   `resources`, so every later refresh inherits it;
 * - **token** — covers a refresh token minted before this hook existed, and a
 *   client that posts to the token endpoint without ever having been through
 *   `/oauth2/authorize`.
 */
const RESOURCE_QUERY_PATHS = new Set(["/oauth2/authorize"])
const RESOURCE_BODY_PATHS = new Set(["/oauth2/token"])

interface ResourceContext {
  path: string
  query?: Record<string, unknown> | undefined
  body?: Record<string, unknown> | undefined
}

/** Mutates in place, which is what the middleware needs. Exported for tests. */
export function injectDefaultResource(
  ctx: ResourceContext,
  config: IdpConfig
): void {
  const target = RESOURCE_QUERY_PATHS.has(ctx.path)
    ? ctx.query
    : RESOURCE_BODY_PATHS.has(ctx.path)
      ? ctx.body
      : undefined
  if (!target) return

  // A client that named its own resources is not second-guessed: FR-OIDC-6
  // is about supplying a default, not about overriding a choice.
  if (hasResource(target.resource)) return

  const resource = defaultResourceFor(
    typeof target.client_id === "string" ? target.client_id : undefined,
    config
  )
  if (resource.length === 0) return

  target.resource = resource.length === 1 ? resource[0] : resource
}

function hasResource(value: unknown): boolean {
  if (typeof value === "string") return value !== ""
  if (Array.isArray(value)) return value.length > 0
  return false
}

/**
 * The client's own `audience` when it declares one, else `jwt.audience`.
 *
 * A per-client audience is what makes "this app's tokens are for that API"
 * expressible without every client having to send `resource` itself
 * (FR-OIDC-6).
 */
export function defaultResourceFor(
  clientId: string | undefined,
  config: IdpConfig
): string[] {
  const client = clientId
    ? config.clients.find((entry) => entry.clientId === clientId)
    : undefined

  if (client?.audience) {
    return Array.isArray(client.audience)
      ? [...client.audience]
      : [client.audience]
  }
  return [...config.defaultAudience]
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
    case "/oauth2/token":
      // Only on success: a refused grant issued nothing, and the failure is
      // already carried by the protocol error the client receives.
      return ok ? { action: "token.issued", outcome } : undefined
    case "/two-factor/enable":
      // Only on success — a refused enrollment changed nothing (FR-2FA-1).
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
  /** Both absent during schema generation, which has no database. */
  database?: DbHandle
  logger?: Logger
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

/**
 * Whether a thrown value is a redirect rather than a failure.
 *
 * `ctx.redirect(url)` builds an `APIError` with a 302 and the endpoint
 * **throws** it, so "did it throw" is not the same question as "did it fail".
 * Every successful e-mail verification was recorded as `email.verified
 * failure` because of this — the endpoint answers a redirect to its
 * `callbackURL` on success, and the only path that does not redirect is the
 * one nothing uses. An audit trail that reports every success as a failure is
 * worse than none: SEC-6 exists so somebody can tell the two apart afterwards.
 */
export function isRedirect(value: Error): boolean {
  const status = (value as { statusCode?: unknown }).statusCode
  return typeof status === "number" && status >= 300 && status < 400
}

export function buildAfterHook(
  deps: AfterHookDeps
): NonNullable<BetterAuthOptions["hooks"]>["after"] {
  return createAuthMiddleware(async (ctx) => {
    const context = ctx.context as {
      returned?: unknown
      session?: unknown
    }
    // Better Auth hands the endpoint's return value here, or an `APIError`
    // when it threw. That is the whole success signal — verified against the
    // live hook rather than assumed.
    const returned = context.returned
    const ok = !(returned instanceof Error) || isRedirect(returned)
    const userId = subjectOf(returned, context.session)

    // Before the audit gate below, because this is not auditing: an instance
    // built without an `audit` still has to do it.
    if (ok && ctx.path === "/two-factor/disable") {
      await forgetTrustedDevices(deps, userId)
    }

    const audit = deps.audit
    if (!audit) return

    const event = auditEventFor(ctx.path, ok, {
      twoFactorPending: isTwoFactorChallenge(returned),
    })
    if (!event) return

    await audit.record({
      ...event,
      actorType: userId ? "session" : "anonymous",
      actorUserId: userId,
      ...(userId ? { target: { type: "user", id: userId } } : {}),
      userAgent: ctx.headers?.get("user-agent") ?? null,
      // `ipAddress` waits for M11's `clientIpFrom`, which needs `trustProxy`
      // to decide which forwarded hop to believe (SEC-2).
      ...revocationMetadata(ctx.path, ctx.context, userId),
    })
  })
}

/**
 * `scope`, and `sessionId` where the request can honestly name one.
 *
 * **The id is ownership-scoped, and that is the whole subtlety.** Better
 * Auth's `/revoke-session` looks the presented token up, compares its owner to
 * the caller, and — when they differ — silently skips the delete and
 * answers `{ status: true }` anyway. Attaching the stashed id unconditionally
 * would therefore mint success rows naming a *victim's* session for a
 * revocation that never happened, which is worse than no id at all: an audit
 * trail is read as a record of what occurred.
 *
 * `/sign-out` needs no such comparison and could not make one — it carries
 * no session middleware, so there is no resolved caller to compare against.
 * The token came from the caller's own signed cookie, which is what ownership
 * means there.
 *
 * The bulk scopes (`all`, `others`) name no single session and get none.
 */
function revocationMetadata(
  path: string,
  context: object,
  userId: string | undefined
): { metadata: { scope: string; sessionId?: string } } | Record<string, never> {
  const scope = sessionRevocationScope(path)
  if (!scope) return {}

  const stashed = REVOKED_SESSION.get(context)
  const owned =
    stashed !== undefined && (path === "/sign-out" || stashed.userId === userId)

  return {
    metadata: {
      scope,
      ...(owned ? { sessionId: stashed.sessionId } : {}),
    },
  }
}

/**
 * Turning your own second factor off forgets every browser you trusted with
 * it (**D104**, FR-2FA-2).
 *
 * Better Auth's `/two-factor/disable` deletes the trust row named by the
 * *presenting* browser's cookie and no other, so a disable followed by a
 * re-enable left every other browser still able to skip the freshly enrolled
 * factor — for up to `twoFactor.trustDeviceDays`, and the row is rotated to a
 * fresh expiry on every use, so one in daily use never lapses.
 *
 * There is no plugin seam for this and no `after` hook of the plugin's own to
 * extend, so it hangs off the endpoint path here — the same place the SEC-6
 * mapping already keys on it.
 *
 * **A failure must not fail the disable.** The second factor is off by the
 * time this runs; throwing would answer 500 to a request that succeeded, and
 * the natural retry would then be a disable of something already disabled.
 * Same trade as `revokeTokensAfterPasswordWrite`: log it, leave the trust rows
 * for the hourly sweep, and let the user see the change they made.
 *
 * Two flows were considered and deliberately left out, both recorded in D104:
 * a **password change or reset** (a trust row is not a credential — the
 * sign-in still needs the new password, the enrollment did not change, and
 * clearing would tax routine rotation for nothing) and a **ban or admin
 * revoke-all** (the status gate refuses a banned user's sign-in anyway, and
 * revoke-all is about live grants rather than enrollment; "this account is
 * compromised" means a password reset and a 2FA reset, and both of those now
 * clear trust).
 */
async function forgetTrustedDevices(
  deps: AfterHookDeps,
  userId: string | undefined
): Promise<void> {
  if (!deps.database || !userId) return
  try {
    await clearTrustedDevices(deps.database, userId)
  } catch (error) {
    deps.logger?.error("could not clear trusted devices", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
