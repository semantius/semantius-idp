/**
 * What the session behind a request may do *right now*, as opposed to when it
 * was minted.
 *
 * Three gates in one place, all about state that changes *after* a session or
 * a token exists and that the ≤ 5 min cookie cache would not see:
 *
 * - **A forced password change is a wall, not a page**. `/login`
 *   sets the session cookie and *then* redirects to `/change-password`, so the
 *   cookie is a working credential from the first response — and nothing
 *   behind `/api/auth/*` ever read `mustChangePassword`. A user on an
 *   administrator's temporary password could `POST /api/auth/api-key/create`
 *   with it and hold a long-lived key that outlived the password they were
 *   told to replace. The page handlers are gated in `http/require-session.ts`
 *   and the two layout loaders; this is the third place, because a direct API
 *   call passes neither.
 * - **An impersonating administrator does not mint credentials as the user**
 *. The impersonation session ends within the hour; a key it
 *   created would not.
 * - **A refresh grant re-verifies the owner**. The provider looks
 *   the user up and reads nothing about their standing, so a status flipped to
 *   `pending` or a ban set after the token was issued did not stop the grant.
 *   Sessions get the same re-check in `http/session.ts`.
 *
 * **Why the row and not the cookie.** The cookie cache carries the user as they
 * were when it was minted, and the flag this gate reads is raised by an
 * administrator *while the user is signed in* — the whole point is that it
 * bites on the next request, not five minutes later. The read is skipped when
 * the request carries no cookie at all: an API-key caller has none, and
 * `getAuthoritativeSessionFromCtx` nulls the session the api-key plugin built
 * before re-reading (`admin/gate.ts` explains the same trap), so the preset is
 * put back when the re-read finds nothing. It is also skipped for a plain GET,
 * which reads and mints nothing — except `/token`, which is a GET that mints.
 *
 * **Why an exemption list rather than an allow-list.** The paths a user on a
 * temporary password *needs* are the ones that end the condition or the
 * session, plus the ones a stale cookie could otherwise poison: a second
 * sign-in, a password reset from a link, a two-factor challenge, and the OAuth
 * client endpoints, which authenticate a client rather than the cookie.
 * Everything else is something the spec says must wait ("before
 * anything else completes").
 */

import { createHash } from "node:crypto"

import { APIError, getAuthoritativeSessionFromCtx } from "better-auth/api"
import { eq } from "drizzle-orm"

import type { DbHandle } from "../../db/client"
import { assertUserMaySignIn } from "./database-hooks"
import type { GateUser } from "./database-hooks"

/** Codes `http/auth-proxy.ts` maps onto the page wording. */
export const STANDING_ERROR_CODES = {
  passwordChangeRequired: "PASSWORD_CHANGE_REQUIRED",
  impersonatedSession: "IMPERSONATED_SESSION",
} as const

/** Ends the condition, ends the session, or does not act on the session's behalf. */
const FORCED_CHANGE_EXEMPT_PATHS = new Set([
  "/change-password",
  "/reset-password",
  "/forget-password",
  "/request-password-reset",
  "/sign-out",
  "/get-session",
  "/verify-email",
  "/send-verification-email",
  "/oauth2/end-session",
])

/** Same, for the endpoint families that repeat the shape. */
const FORCED_CHANGE_EXEMPT_PREFIXES = [
  "/sign-in/",
  "/sign-up/",
  "/callback/",
  "/two-factor/verify-",
  "/two-factor/send-otp",
  // Client-authenticated: the cookie, if one is even sent, is not the caller.
  "/oauth2/token",
  "/oauth2/introspect",
  "/oauth2/revoke",
  "/oauth2/userinfo",
]

/** A GET that mints is gated like a write. */
const MINTING_GET_PATHS = new Set(["/token"])

/** What an impersonating administrator may not do as the user. */
const IMPERSONATION_REFUSED_PATHS = new Set(["/api-key/create"])

export function isExemptFromForcedChange(path: string): boolean {
  if (FORCED_CHANGE_EXEMPT_PATHS.has(path)) return true
  return FORCED_CHANGE_EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix))
}

export interface StandingSession {
  user?: (GateUser & { mustChangePassword?: boolean | null }) | null
  session?: { impersonatedBy?: string | null } | null
}

/** The slice of a Better Auth middleware context this gate reads. */
export interface StandingContext {
  path: string
  method?: unknown
  headers?: Headers | null
  request?: { method: string } | null
  context: { session?: unknown }
}

export interface StandingDeps {
  /** Injected by the unit test; the real one re-reads the row past the cache. */
  resolveSession?: (ctx: StandingContext) => Promise<StandingSession | null>
}

const authoritative: NonNullable<StandingDeps["resolveSession"]> = (ctx) =>
  getAuthoritativeSessionFromCtx(ctx as never) as Promise<StandingSession | null>

/** Throws when the session behind the request may not do what it asks. */
export async function assertSessionStanding(
  ctx: StandingContext,
  deps: StandingDeps = {}
): Promise<void> {
  if (!carriesCookie(ctx)) return
  if (isPlainRead(ctx)) return

  const forcedChangeApplies = !isExemptFromForcedChange(ctx.path)
  const impersonationApplies = IMPERSONATION_REFUSED_PATHS.has(ctx.path)
  if (!forcedChangeApplies && !impersonationApplies) return

  const preset = ctx.context.session
  const resolved = await (deps.resolveSession ?? authoritative)(ctx)
  if (!resolved?.user) {
    // Nothing behind the cookie: put back whatever an earlier hook resolved
    // and let the endpoint's own session check answer.
    ctx.context.session = preset
    return
  }

  if (forcedChangeApplies && resolved.user.mustChangePassword === true) {
    throw new APIError("FORBIDDEN", {
      code: STANDING_ERROR_CODES.passwordChangeRequired,
      message: "Choose a new password before doing anything else.",
    })
  }

  const by = resolved.session?.impersonatedBy
  if (impersonationApplies && typeof by === "string" && by !== "") {
    throw new APIError("FORBIDDEN", {
      code: STANDING_ERROR_CODES.impersonatedSession,
      message: "An administrator signed in as this user cannot do that.",
    })
  }
}

function carriesCookie(ctx: StandingContext): boolean {
  const cookie = ctx.headers?.get("cookie")
  return typeof cookie === "string" && cookie !== ""
}

function isPlainRead(ctx: StandingContext): boolean {
  if (MINTING_GET_PATHS.has(ctx.path)) return false
  const method =
    ctx.request?.method ?? (typeof ctx.method === "string" ? ctx.method : "")
  return method.toUpperCase() === "GET"
}

export interface RefreshOwnerDeps {
  /** Absent during schema generation, which serves no grant. */
  database?: DbHandle
}

/**
 * Refuses a refresh grant whose owner may no longer sign in.
 *
 * Runs before the provider looks at the token, so the refusal is the ordinary
 * `invalid_grant` a client already handles, and the token is **not** consumed
 * by the attempt: the requirement is that the *state* is re-verified, and an
 * account that is later approved or unbanned keeps its grant.
 *
 * An unknown token is left to the provider — its own answer is the right one,
 * and guessing at it here would be a second place to keep the error shape.
 */
export async function assertRefreshOwnerMaySignIn(
  body: Record<string, unknown> | undefined,
  deps: RefreshOwnerDeps
): Promise<void> {
  if (body?.grant_type !== "refresh_token") return
  const presented = body.refresh_token
  if (typeof presented !== "string" || presented === "" || !deps.database) {
    return
  }

  const { oauthRefreshToken, user } = deps.database.schema
  const [owner] = await deps.database.db
    .select({
      status: user.status,
      banned: user.banned,
      banExpires: user.banExpires,
    })
    .from(oauthRefreshToken)
    .innerJoin(user, eq(user.id, oauthRefreshToken.userId))
    .where(eq(oauthRefreshToken.token, hashStoredToken(presented)))
    .limit(1)
  if (!owner) return

  try {
    assertUserMaySignIn(owner)
  } catch (error) {
    if (!(error instanceof APIError)) throw error
    throw new APIError("BAD_REQUEST", {
      error: "invalid_grant",
      error_description: "The account this token belongs to is not available.",
    })
  }
}

/**
 * The provider's own storage hash for a token (`storeTokens: "hashed"`,
 * `oauth-provider`'s `defaultHasher`): SHA-256, base64url, no padding.
 *
 * Restated here rather than imported because the package does not export it.
 * The unit test pins it to a known vector so a change in the provider's
 * choice would show up as a failing test rather than as a gate that silently
 * matches nothing.
 */
export function hashStoredToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url")
}
