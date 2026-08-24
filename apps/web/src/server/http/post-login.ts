/**
 * Where a completed sign-in goes (FR-AUTH-1, D28).
 *
 * Four sources, in the order the spec fixes:
 *
 * 1. a pending OAuth authorization continuation (FR-OIDC-9) — always wins,
 *    because the user did not come here to look at their profile;
 * 2. a `returnTo` that survives `safeReturnTo`, i.e. a same-origin relative
 *    path (SEC-3 — this is the only one of the four that is user input, and it
 *    is validated exactly as before);
 * 3. `auth.defaultRedirect`, which the operator may point anywhere;
 * 4. `/account`.
 *
 * Keeping this in one function is the point. The destination is decided at
 * three different moments — plain sign-in, the 2FA challenge (M6) and the end
 * of a forced password change (FR-AUTH-4) — and an absolute
 * `auth.defaultRedirect` cannot be carried between them through a `returnTo`
 * query parameter, since `safeReturnTo` would rightly throw it away. So each
 * of those moments re-resolves here instead of passing a value along.
 */

import type { IdpConfig } from "../config/derive"
import { APP_ROUTES } from "../oidc/base-path"
import { safeReturnTo } from "./auth-proxy"

/** The last resort, exported so tests and callers name the same constant. */
export const FALLBACK_SIGN_IN_DESTINATION: string = APP_ROUTES.account

export interface SignInDestinationInput {
  config: IdpConfig
  /** The raw `returnTo` from the form or query. Validated here, not by the caller. */
  returnTo?: string | null
  /**
   * Where to resume a pending `/oauth2/authorize` (FR-OIDC-9).
   *
   * Either the client's own redirect URI carrying an authorization code, or
   * the consent page — both decided by the provider, never by the browser, so
   * unlike `returnTo` this is not user input and an absolute URL here is not
   * an open redirect.
   */
  pendingContinuation?: string | null
}

/**
 * Resolves the post-sign-in destination to something the browser can be sent
 * to — already carrying `server.baseUrl`'s path prefix where one applies.
 */
export function resolveSignInDestination({
  config,
  returnTo,
  pendingContinuation,
}: SignInDestinationInput): string {
  const basePath = config.base.basePath

  if (pendingContinuation) {
    // Absolute when the provider resolved the request to a client's redirect
    // URI; relative when it resolved to a page of ours.
    return pendingContinuation.startsWith("/")
      ? withBasePath(basePath, pendingContinuation)
      : pendingContinuation
  }

  const validated = safeReturnTo(returnTo, "")
  if (validated !== "") return withBasePath(basePath, validated)

  // Validated at config load: relative, or absolute http(s), and nothing else.
  // The falsy branch is unreachable through the schema — it is here so a
  // hand-built config in a test cannot turn a missing key into a crash.
  const configured = config.file.auth.defaultRedirect as string | undefined
  if (configured) {
    return configured.startsWith("/")
      ? withBasePath(basePath, configured)
      : configured
  }

  return withBasePath(basePath, FALLBACK_SIGN_IN_DESTINATION)
}

function withBasePath(basePath: string, relative: string): string {
  if (basePath === "") return relative
  // `/idp` + `/account`. `relative` always starts with `/` by the time it gets
  // here — `safeReturnTo` guarantees it, and so does the config refinement.
  return `${basePath}${relative}`
}
