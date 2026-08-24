/**
 * The re-authentication gate for sensitive actions (FR-AUTH-5).
 *
 * "Sensitive actions require a session fresher than `session.freshAgeMinutes`,
 * or a re-authentication." The actions in question are the ones that change
 * *who can get back in* — password, e-mail address, second factor, API keys,
 * revoking other sessions, and every admin write (M10). A stolen laptop with
 * an unlocked browser is the threat: the session is valid, so nothing else
 * stops it, and the window this closes is the difference between reading
 * someone's account and taking it over.
 *
 * Freshness is measured from `session.createdAt`, not `updatedAt`: the point
 * is "how long since a password was typed", and `updatedAt` moves on every
 * request, which would make every session permanently fresh.
 *
 * A stale session is not an error — the user is who they say they are, they
 * just have not proved it recently. So the answer is a 303 back to `/login`
 * with `notice=reauth` and a `returnTo`, and after signing in they land back
 * where they were.
 */

import { redirectWithCookies } from "./auth-proxy"
import type { RouteSession } from "./session"
import { readSession } from "./session"
import { APP_ROUTES } from "../oidc/base-path"
import type { Runtime } from "../runtime"

export type FreshSessionResult =
  | { ok: true; session: RouteSession }
  /** The caller should return this response unchanged. */
  | { ok: false; response: Response }

/**
 * Requires a session that is both present and fresh.
 *
 * `returnTo` is where to come back to after re-authenticating; it is a path
 * this code chose, never user input, so it does not go through `safeReturnTo`.
 */
export async function requireFreshSession(
  runtime: Runtime,
  request: Request,
  returnTo: string
): Promise<FreshSessionResult> {
  const base = runtime.config.base.basePath
  // Authoritative on purpose: the cookie cache would answer with the session
  // as it was up to five minutes ago, which is the one thing a freshness
  // check must not accept.
  const session = await readSession(runtime, request, { authoritative: true })

  if (!session) {
    return { ok: false, response: bounce(base, returnTo, "signin_required") }
  }

  if (!isFresh(session, runtime.config.file.session.freshAgeMinutes)) {
    return { ok: false, response: bounce(base, returnTo, "reauth") }
  }

  return { ok: true, session }
}

/** The decision on its own, so the arithmetic is testable without a request. */
export function isFresh(
  session: RouteSession,
  freshAgeMinutes: number,
  now: number = Date.now()
): boolean {
  const createdAt = session.session.createdAt.getTime()
  if (!Number.isFinite(createdAt)) return false
  return now - createdAt <= freshAgeMinutes * 60_000
}

function bounce(base: string, returnTo: string, notice: string): Response {
  const query = new URLSearchParams({ notice, returnTo })
  return redirectWithCookies(`${base}${APP_ROUTES.login}?${query.toString()}`)
}
