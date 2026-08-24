/**
 * Resuming an interrupted authorization (FR-OIDC-9).
 *
 * **The mechanism, which is the provider's and not ours.** When
 * `/oauth2/authorize` needs the user to do something first, 1.7.1 redirects to
 * `loginPage` or `consentPage` with the whole authorization request in the
 * query string, signed with the server secret and stamped with an expiry. The
 * page hands that string back — as `oauth_query` in the body of
 * `POST /oauth2/continue` or `POST /oauth2/consent` — and the provider
 * verifies the signature and re-runs the request.
 *
 * So there is no pending-authorization store here, no opaque handle and no
 * cookie: the state travels with the user, tamper-evident and short-lived,
 * and the server keeps nothing that has to be swept. The
 * `pending_authorization` table this plugin contributes to the schema stays
 * unused; removing it would be a migration for no gain, and M12's cleanup job
 * purges it either way.
 *
 * **Why we drive the resume rather than letting it happen.** The provider also
 * resumes *automatically*, from an after-hook that fires whenever a request
 * carrying `oauth_query` sets a session cookie. That is one gate too few: a
 * user with a temporary password gets a session on sign-in, so the automatic
 * resume would hand out an authorization code before the forced change
 * (FR-AUTH-4). Calling `/oauth2/continue` ourselves, after the gate chain is
 * satisfied, is what keeps the order the spec describes.
 */

import type { Runtime } from "../runtime"
import { createBasePaths } from "./base-path"

/** The form field the interstitial pages carry the signed request in. */
export const OAUTH_QUERY_FIELD = "oauth_query"

export interface ResumeResult {
  /** Where to send the browser: the client's redirect URI, or the consent page. */
  destination?: string
  /** Set when the signed request has expired or been tampered with. */
  invalid?: boolean
}

/**
 * Asks the provider to continue an authorization, with the caller's session.
 *
 * Returns no destination when there is nothing to continue, which is the
 * ordinary case for a sign-in that did not come from an authorization
 * request.
 */
export async function resumeAuthorization(
  runtime: Runtime,
  request: Request,
  oauthQuery: string | undefined,
  cookies: readonly string[] = []
): Promise<ResumeResult> {
  if (!oauthQuery) return {}

  const paths = createBasePaths(runtime.config.base)
  const headers = new Headers()
  headers.set("content-type", "application/json")
  // JSON rather than a navigation, so the answer comes back as a URL this
  // handler can turn into its own 303 instead of a redirect we cannot see.
  headers.set("accept", "application/json")
  const origin = request.headers.get("origin")
  if (origin) headers.set("origin", origin)

  // The session that was *just* created arrives as `Set-Cookie` on the
  // sign-in response, before any browser has had a chance to send it back —
  // so it is replayed here rather than read from the request.
  const cookie = [request.headers.get("cookie"), ...cookies.map(firstPair)]
    .filter(Boolean)
    .join("; ")
  if (cookie) headers.set("cookie", cookie)

  const response = await runtime.auth.handler(
    new Request(`${paths.authBaseUrl}/oauth2/continue`, {
      method: "POST",
      headers,
      body: JSON.stringify({ selected: true, [OAUTH_QUERY_FIELD]: oauthQuery }),
    })
  )

  const body = (await response.json().catch(() => ({}))) as {
    redirect_uri?: unknown
    url?: unknown
  }
  // 1.7.1 answers `{ redirect: true, url }`; its own OpenAPI text says
  // `redirect_uri`. Reading both means a version that changes its mind does
  // not silently strand every sign-in that came from an authorization.
  const destination = firstString(body.url, body.redirect_uri)

  if (!response.ok || !destination) {
    // A tampered or expired request is not an error to show the user: the
    // authorization simply cannot be resumed, and the sign-in that just
    // succeeded should still land somewhere sensible.
    runtime.logger.warn("could not resume an authorization request", {
      status: response.status,
    })
    return { invalid: true }
  }

  return { destination }
}

function firstPair(setCookie: string): string {
  return setCookie.split(";")[0] ?? ""
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value !== "") return value
  }
  return undefined
}
