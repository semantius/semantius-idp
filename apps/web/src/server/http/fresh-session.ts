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
 *
 * **And with what they had typed** (**D63**). The gate used to run before the
 * body was read, so a form filled in over a coffee break was discarded on its
 * way past: the administrator signed in again, landed on an empty dialog, and
 * retyped twelve fields. The window is unchanged — FR-AUTH-5 still means what
 * it said — and the fix is that nothing is lost crossing it. A caller that has
 * a body worth keeping passes it as `draft`, and the bounce carries a handle
 * to it (`server/http/draft.ts`).
 */

import { redirectWithCookies } from "./auth-proxy"
import { stashDraft, withDraft } from "./draft"
import type { RouteSession } from "./session"
import { readSession } from "./session"
import { APP_ROUTES } from "../oidc/base-path"
import type { Runtime } from "../runtime"

export type FreshSessionResult =
  | { ok: true; session: RouteSession }
  /** The caller should return this response unchanged. */
  | { ok: false; response: Response }

export interface RequireFreshSessionOptions {
  /**
   * The submitted form, kept across the re-authentication.
   *
   * **Only used for the stale-session case.** An anonymous POST must not be
   * able to write attacker-controlled JSON into `verification`: these route
   * handlers sit in front of no rate limiter, and `signin_required` is exactly
   * the branch a caller with no session reaches. Someone who is signed in but
   * stale has already been through the sign-in limiter to get a session at
   * all.
   */
  draft?: Record<string, string | string[] | undefined>
  /**
   * How long the draft stays claimable. Longer than the store's own default,
   * because this detour is a full sign-in and may go through a second factor.
   */
  draftTtlSeconds?: number
}

/**
 * Requires a session that is both present and fresh.
 *
 * `returnTo` is where to come back to after re-authenticating; it is a path
 * this code chose, never user input, so it does not go through `safeReturnTo`.
 */
export async function requireFreshSession(
  runtime: Runtime,
  request: Request,
  returnTo: string,
  { draft, draftTtlSeconds = 1800 }: RequireFreshSessionOptions = {}
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
    const handle = draft
      ? await stashDraft(runtime, draft, { ttlSeconds: draftTtlSeconds })
      : undefined
    return {
      ok: false,
      response: bounce(
        base,
        withDraft(returnTo, handle),
        handle ? "reauth_draft" : "reauth"
      ),
    }
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
  return redirectWithCookies(reauthTarget(base, returnTo, notice))
}

/**
 * Where a refused caller is sent, as a string — so the shape can be asserted
 * without a runtime.
 *
 * `returnTo` may itself carry a query (`/admin/clients?draft=…`), and
 * `URLSearchParams` encodes it, so the handle survives the round trip and
 * `safeReturnTo` on the way back sees one same-origin relative path.
 */
export function reauthTarget(
  base: string,
  returnTo: string,
  notice: string
): string {
  const query = new URLSearchParams({ notice, returnTo })
  return `${base}${APP_ROUTES.login}?${query.toString()}`
}
