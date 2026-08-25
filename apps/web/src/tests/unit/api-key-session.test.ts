/**
 * Telling a key-borne session from a browser one (FR-KEY-3).
 *
 * The integration suite proves the *outcome* — a JWT minted from an API key
 * carries `apiKeys.tokenClientId` and one minted from a session carries the
 * IdP's id. What is pinned here is the property that makes the marker safe to
 * trust at all: it cannot arrive from outside the process.
 *
 * That matters because `azp` is an authorization-relevant claim. If a caller
 * could make a session *look* key-borne by sending a field, they could choose
 * which client a resource server believes issued their token.
 */

import { describe, expect, it } from "vitest"

import {
  API_KEY_SESSION,
  isApiKeySession,
} from "@/server/auth/options/api-key-gate"

describe("the API-key session marker", () => {
  it("is set only by assigning the symbol", () => {
    const session: { session: Record<PropertyKey, unknown> } = { session: {} }
    expect(isApiKeySession(session)).toBe(false)

    session.session[API_KEY_SESSION] = true
    expect(isApiKeySession(session)).toBe(true)
  })

  it("cannot be forged by anything that arrives as JSON", () => {
    // Every route into this process — a request body, a database row, a cookie
    // — is parsed JSON, and parsed JSON has no symbol keys. These are the
    // shapes an attacker would reach for.
    const attempts = [
      { apiKeySession: true },
      { [API_KEY_SESSION.toString()]: true },
      { "Symbol(semantius-idp.apiKeySession)": true },
      JSON.parse('{"semantius-idp.apiKeySession": true}') as Record<
        string,
        unknown
      >,
    ]

    for (const session of attempts) {
      expect(isApiKeySession({ session })).toBe(false)
    }
  })

  it("does not leak into what /get-session returns", () => {
    // A symbol key is invisible to `JSON.stringify`, so marking a session does
    // not change any response body that carries one.
    const session = { id: "sess_1", token: "abc" } as Record<
      PropertyKey,
      unknown
    >
    const before = JSON.stringify(session)
    session[API_KEY_SESSION] = true

    expect(JSON.stringify(session)).toBe(before)
    expect(isApiKeySession({ session })).toBe(true)
  })

  it("treats the absent and null cases as a browser session", () => {
    expect(isApiKeySession({})).toBe(false)
    expect(isApiKeySession({ session: null })).toBe(false)
  })
})
