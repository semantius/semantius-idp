/**
 * "Is there somebody signed in?", asked by a form POST handler.
 *
 * The route `loader`s answer that question for themselves through the server
 * functions in `server/functions/`; this is the other half, for the
 * `server.handlers` that write. A handler that skipped it would be a mutation
 * reachable with no session at all, which is the shape the base-URL rule exists to
 * prevent.
 *
 * **The read is authoritative, and that is the point**. The cookie
 * cache answers with the session as it was up to `session.cookieCacheMinutes`
 * ago — including the ban flag and the approval state — so a write authorized
 * from the cache is a write authorized by a copy of the world up to five
 * minutes old. A revocation, a suspension or a withdrawn approval must bite on
 * the *next write*, not five minutes after it. Page loads keep the cache;
 * these handlers are form posts and can afford the query.
 *
 * This file replaced the freshness gate (`fresh-session.ts`, removed in
 * the freshness gate's removal). What it kept is the shape — `{ ok }` with a ready-made response —
 * so a caller reads the same as it always did.
 *
 * **Two more refusals live here since the security review**, for the same
 * reason the session check does: a handler that has to remember to call a
 * second helper is a handler that will not.
 *
 * - **The post has to come from this deployment's own pages**. `assertSameOrigin` guarded three account pages at first
 *   and nothing else, so `/account` and `/account/api-keys` — the profile and
 *   a credential mint — and every `/admin/*` form were covered only by Better
 *   Auth's own origin check inside `callAuth`, which accepts anything on
 *   `server.trustedOrigins` — including a sibling subdomain that
 *   `server.cookieDomain` lets carry the cookie. The posture is the one
 *   `request-origin.ts` documents: refuse a cross-site or same-site
 *   `Sec-Fetch-Site` and a foreign `Origin`; **allow a post that carries
 *   neither**, which is not a browser. It runs before the read, because it
 *   needs no query and a refused post deserves none.
 * - **A pending forced password change is a wall**.
 *   `/login` sets the cookie before it redirects to `/change-password`, so
 *   the session works everywhere the moment it exists, and no handler under
 *   `/account/*` or `/admin/*` read the flag. The read above is authoritative,
 *   so the flag is the row's, not the cookie's — an administrator raising it
 *   while the user is signed in is exactly the case.
 */

import { redirectWithCookies, withError } from "./auth-proxy"
import { assertSameOrigin } from "./request-origin"
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
  const base = runtime.config.base.basePath

  if (!assertSameOrigin(request)) {
    return {
      ok: false,
      response: redirectWithCookies(
        withError(browserPath(base, returnTo), "untrusted_origin")
      ),
    }
  }

  const session = await readSession(runtime, request, { authoritative: true })

  if (!session) {
    return {
      ok: false,
      response: redirectWithCookies(signInTarget(base, returnTo)),
    }
  }

  if (session.user.mustChangePassword) {
    return {
      ok: false,
      response: redirectWithCookies(forcedChangeTarget(base, returnTo)),
    }
  }

  return { ok: true, session }
}

/**
 * Where a caller mid forced change is sent: the same
 * page `/login` interposes, carrying the same `forced=1` and a way back.
 */
export function forcedChangeTarget(base: string, returnTo: string): string {
  const query = new URLSearchParams({ forced: "1", returnTo })
  return `${base}${APP_ROUTES.changePassword}?${query.toString()}`
}

/**
 * `returnTo` as a path the browser can be sent to.
 *
 * The callers spell it two ways: the account handlers pass the app-relative
 * `HERE` (`/account/api-keys`) and the admin handlers pass the page they
 * already built, mount path included (`/idp/admin/system`). `signInTarget`
 * never had to care — the value travels as a query parameter — but a redirect
 * *to* the page does, and prefixing the mount path twice is a 404.
 */
export function browserPath(base: string, returnTo: string): string {
  if (base !== "" && (returnTo === base || returnTo.startsWith(`${base}/`))) {
    return returnTo
  }
  return `${base}${returnTo}`
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
