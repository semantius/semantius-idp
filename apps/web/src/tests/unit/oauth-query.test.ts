import { describe, expect, it } from "vitest"

import {
  rawSearch,
  readOauthQuery,
  signedRequestExpired,
} from "@/lib/oauth-query"

/**
 * Carrying a signed authorization request across an interstitial.
 *
 * The string the page posts back has to reproduce the **values** the provider
 * signed. It does not have to reproduce the bytes: `verifyOAuthQueryParams`
 * parses with `URLSearchParams` and canonicalises before hashing, so order and
 * the choice between `+` and `%20` are free. What is not free is a repeated
 * key, and that is exactly what went wrong — Start's search serializer writes
 * one as a JSON array, so `ba_param=a&ba_param=b` came back as
 * `ba_param=["a","b"]`, the signature never matched, `/oauth2/continue`
 * answered 400, and every OIDC login that passed through the sign-in page
 * landed on `auth.defaultRedirect` instead of the application.
 *
 * These are the assertions that would have caught it without a browser.
 */

/** A signed authorization request, as `/oauth2/authorize` redirects with it. */
function authorizationSearch(): Record<string, unknown> {
  return {
    response_type: "code",
    redirect_uri: "http://127.0.0.1:4571/callback",
    scope: "openid profile email",
    state: "abc",
    client_id: "e2e-app",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    // Start's parser is JSON-based, so these two arrive as numbers.
    exp: 1787657695,
    ba_iat: 1787657635505,
    // The signed parameter list. Repeated in the URL, an array once parsed.
    ba_param: ["ba_iat", "ba_param", "client_id", "exp", "scope"],
    sig: "KQSvuIWUymUZ+bA1aB3BajHUm/juB8zT1ChlQ6YPqi8=",
  }
}

describe("rawSearch", () => {
  it("writes a repeated key as repeated keys, not as an array", () => {
    const params = new URLSearchParams(rawSearch(authorizationSearch()))
    expect(params.getAll("ba_param")).toEqual([
      "ba_iat",
      "ba_param",
      "client_id",
      "exp",
      "scope",
    ])
  })

  it("returns every value the provider signed, unchanged", () => {
    const search = authorizationSearch()
    const params = new URLSearchParams(rawSearch(search))

    expect(params.get("scope")).toBe("openid profile email")
    expect(params.get("redirect_uri")).toBe("http://127.0.0.1:4571/callback")
    // The signature is base64 and survives a decode/encode round trip.
    expect(params.get("sig")).toBe("KQSvuIWUymUZ+bA1aB3BajHUm/juB8zT1ChlQ6YPqi8=")
    // Numbers come back as the same digits they arrived as.
    expect(params.get("exp")).toBe("1787657695")
    expect(params.get("ba_iat")).toBe("1787657635505")
  })

  it("drops a key that is not there rather than writing `undefined`", () => {
    expect(rawSearch({ a: "1", b: undefined })).toBe("a=1")
  })
})

describe("readOauthQuery", () => {
  it("recognizes the provider's redirect and rebuilds it", () => {
    const carried = readOauthQuery({ search: authorizationSearch() })
    expect(carried).toBeDefined()
    expect(new URLSearchParams(carried).getAll("ba_param")).toHaveLength(5)
  })

  it("prefers the field this app's own pages carry it in", () => {
    // login → two-factor → forced change: a nested query string cannot be
    // spliced into another one, so it travels as a single parameter.
    const carried = readOauthQuery({
      search: { oauth_query: "client_id=x&sig=y", other: "ignored" },
    })
    expect(carried).toBe("client_id=x&sig=y")
  })

  it("ignores a page that is not an authorization at all", () => {
    // `sig` and `client_id` together are the marker. Either alone could be an
    // ordinary parameter, and posting nonsense back is worse than doing
    // nothing.
    expect(readOauthQuery({ search: {} })).toBeUndefined()
    expect(readOauthQuery({ search: { sig: "y" } })).toBeUndefined()
    expect(readOauthQuery({ search: { client_id: "x" } })).toBeUndefined()
    expect(
      readOauthQuery({ search: { error: "invalid_credentials" } })
    ).toBeUndefined()
  })
})

describe("signedRequestExpired", () => {
  const now = 1_789_374_500_000 // ms

  it("is true once the request's own exp has passed", () => {
    expect(signedRequestExpired("client_id=x&exp=1789374482&sig=s", now)).toBe(
      true
    )
  })

  it("is false while exp is still ahead", () => {
    expect(signedRequestExpired("client_id=x&exp=1789374782&sig=s", now)).toBe(
      false
    )
  })

  it("is false — not expired — for a request that carries no usable exp", () => {
    // A tampered or hand-built string is refused by the provider either way;
    // it just must not be described as "took too long".
    expect(signedRequestExpired("client_id=x&sig=s", now)).toBe(false)
    expect(signedRequestExpired("client_id=x&exp=&sig=s", now)).toBe(false)
    expect(signedRequestExpired("client_id=x&exp=soon&sig=s", now)).toBe(false)
  })
})
