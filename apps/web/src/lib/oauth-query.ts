/**
 * Recognising an interrupted authorization on an interstitial page
 * (FR-OIDC-9).
 *
 * The provider does not hand the request over in a parameter called
 * `oauth_query`: when `/oauth2/authorize` sends someone to the login or
 * consent page, it puts **the whole authorization request** in that page's
 * query string, signed and stamped with an expiry. The page's job is to carry
 * that string back untouched, and it is `oauth_query` only in the *body* it
 * posts.
 *
 * So there are two shapes to read, and both really occur:
 *
 *  - the provider's own redirect, recognised by the signature it carries;
 *  - this app's hand-off between its own pages — login → two-factor →
 *    forced change — where the string travels as a single parameter because a
 *    nested query string cannot be spliced into another one.
 *
 * Nothing here verifies anything. The signature is the provider's to check,
 * and it checks it when the decision is posted back.
 */

/** The field the interstitial pages post the request back in. */
export const OAUTH_QUERY_PARAM = "oauth_query"

export interface OauthQuerySource {
  /** The parsed search parameters, as the router hands them over. */
  search: Record<string, unknown>
  /** The raw query string, with or without its leading `?`. */
  searchStr: string
}

/**
 * The signed authorization request this page was reached with, if any.
 *
 * `sig` **and** `client_id` together are the marker: either alone could be an
 * ordinary parameter, and a page that mistook a stray `sig` for an
 * authorization would post nonsense back and get a confusing failure.
 */
export function readOauthQuery({
  search,
  searchStr,
}: OauthQuerySource): string | undefined {
  const carried = search[OAUTH_QUERY_PARAM]
  if (typeof carried === "string" && carried !== "") return carried

  if (typeof search.sig !== "string" || typeof search.client_id !== "string") {
    return undefined
  }
  const raw = searchStr.startsWith("?") ? searchStr.slice(1) : searchStr
  return raw === "" ? undefined : raw
}
