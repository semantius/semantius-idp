/**
 * Recognizing an interrupted authorization on an interstitial page
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
 *  - the provider's own redirect, recognized by the signature it carries;
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
}

/**
 * The query string the request arrived with, rebuilt from the parsed search.
 *
 * **Not `location.searchStr`**, which is where this used to come from and is
 * the reason no authorization ever resumed through an interstitial. Start
 * re-serializes the search object rather than keeping the bytes it received,
 * and its serializer writes a repeated key as **one JSON array**:
 *
 *     sent   ba_param=ba_iat&ba_param=client_id&ba_param=exp
 *     got    ba_param=%5B%22ba_iat%22%2C%22client_id%22%2C%22exp%22%5D
 *
 * The provider signs the authorization request and lists the signed parameter
 * names in exactly that repeated `ba_param`, so the string the page posted
 * back never matched its own signature: `/oauth2/continue` answered 400, the
 * resume was abandoned, and the user landed on `auth.defaultRedirect` looking
 * like a client that had asked for nothing. Every integration test passed
 * throughout, because none of them goes through a router.
 *
 * Rebuilding from the parsed object restores the *values*, which is all the
 * verifier reads — it parses the string with `URLSearchParams` and
 * canonicalises before hashing, so neither parameter order nor the choice
 * between `+` and `%20` matters.
 *
 * Numbers and booleans are stringified back: Start's parser is JSON-based, so
 * `exp=1787657695` arrives as a number and `String()` returns the same digits.
 * A value that was JSON to begin with (`state=[1,2]`) would not survive the
 * round trip — no client sends one, and the signature would fail loudly rather
 * than quietly if one did.
 */
export function rawSearch(search: Record<string, unknown>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(search)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item))
    } else {
      params.append(key, String(value))
    }
  }
  return params.toString()
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
}: OauthQuerySource): string | undefined {
  const carried = search[OAUTH_QUERY_PARAM]
  if (typeof carried === "string" && carried !== "") return carried

  if (typeof search.sig !== "string" || typeof search.client_id !== "string") {
    return undefined
  }
  return rawSearch(search) || undefined
}
