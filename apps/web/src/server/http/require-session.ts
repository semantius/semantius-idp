/**
 * "Is there somebody signed in?", asked by a form POST handler.
 *
 * The route `loader`s answer that question for themselves through the server
 * functions in `server/functions/`; this is the other half, for the
 * `server.handlers` that write. A handler that skipped it would be a mutation
 * reachable with no session at all, which is the shape SEC-1 exists to
 * prevent.
 *
 * **The read is authoritative, and that is the point** (**D81**). The cookie
 * cache answers with the session as it was up to `session.cookieCacheMinutes`
 * ago — including the ban flag and the approval state — so a write authorised
 * from the cache is a write authorised by a copy of the world up to five
 * minutes old. A revocation, a suspension or a withdrawn approval must bite on
 * the *next write*, not five minutes after it. Page loads keep the cache;
 * these handlers are form posts and can afford the query.
 *
 * This file replaced the freshness gate (`fresh-session.ts`, removed in
 * **D81**). What it kept is the shape — `{ ok }` with a ready-made response —
 * so a caller reads the same as it always did.
 */

import { redirectWithCookies } from "./auth-proxy"
import type { RouteSession } from "./session"
import { readSession } from "./session"
import { APP_ROUTES } from "../oidc/base-path"
import type { Runtime } from "../runtime"

export type RequireSessionResult =
  | { ok: true; session: RouteSession }
  /** The caller should return this response unchanged. */
  | { ok: false; response: Response }

/**
 * Requires a session, and hands back the response for a caller without one.
 *
 * `returnTo` is where to come back to after signing in; it is a path this code
 * chose, never user input, so it does not go through `safeReturnTo`.
 */
export async function requireSession(
  runtime: Runtime,
  request: Request,
  returnTo: string
): Promise<RequireSessionResult> {
  const session = await readSession(runtime, request, { authoritative: true })

  if (!session) {
    return {
      ok: false,
      response: redirectWithCookies(
        signInTarget(runtime.config.base.basePath, returnTo)
      ),
    }
  }

  return { ok: true, session }
}

/**
 * Where a caller with no session is sent, as a string — so the shape can be
 * asserted without a runtime.
 */
export function signInTarget(
  base: string,
  returnTo: string,
  notice = "signin_required"
): string {
  const query = new URLSearchParams({ notice, returnTo })
  return `${base}${APP_ROUTES.login}?${query.toString()}`
}
