/**
 * `{host}` expansion at read time (`server.dynamicIssuer`).
 *
 * The rows store the template verbatim, so this function is the only thing
 * standing between a registered `https://{host}/oauth2_callback` and an exact
 * `includes` match at authorize and logout time. Both halves are load-bearing
 * and neither is observable from the integration suite, which only ever runs
 * inside a request that resolved a host:
 *
 * - **outside a request**, or when the request resolved no usable host, a
 *   template entry is DROPPED rather than passed through — an exact match can
 *   never hit a literal `{host}`;
 * - a **non-template** entry is passed through untouched on both paths, which
 *   is every client in a deployment that never turned the flag on.
 */

import { describe, expect, it } from "vitest"

import { withRequestContext } from "@/server/http/request-log"
import { expandTemplateClient } from "@/server/oidc/host-template-clients"

/** The request scope the runtime path reads its host out of. */
function withIssuer<T>(issuer: string | undefined, fn: () => T): T {
  return withRequestContext({ requestId: "test", ...(issuer ? { issuer } : {}) }, fn)
}

describe("expandTemplateClient with a host", () => {
  it("substitutes the host in both URI lists", () => {
    const client = expandTemplateClient(
      {
        redirectUris: ["https://{host}/oauth2_callback"],
        postLogoutRedirectUris: ["https://{host}/signed-out"],
      },
      "b.example.com"
    )
    expect(client.redirectUris).toEqual(["https://b.example.com/oauth2_callback"])
    expect(client.postLogoutRedirectUris).toEqual([
      "https://b.example.com/signed-out",
    ])
  })

  it("leaves a literal URI alone and keeps it beside an expanded one", () => {
    const client = expandTemplateClient(
      {
        redirectUris: [
          "https://app.example.com/callback",
          "https://{host}/oauth2_callback",
        ],
      },
      "b.example.com:8443"
    )
    expect(client.redirectUris).toEqual([
      "https://app.example.com/callback",
      "https://b.example.com:8443/oauth2_callback",
    ])
  })

  it("carries every other field of the row across untouched", () => {
    const client = expandTemplateClient(
      { clientId: "app", skipConsent: true, redirectUris: [] },
      "b.example.com"
    )
    expect(client.clientId).toBe("app")
    expect(client.skipConsent).toBe(true)
  })

  it("normalizes an absent postLogoutRedirectUris to an empty list", () => {
    // `getRegisteredLogoutRedirect` does an `includes` on the result, so the
    // one shape it must never see is `null`.
    expect(
      expandTemplateClient(
        { redirectUris: [], postLogoutRedirectUris: null },
        "b.example.com"
      ).postLogoutRedirectUris
    ).toEqual([])
  })
})

describe("expandTemplateClient with no host", () => {
  it("drops template entries and keeps literal ones", () => {
    const client = expandTemplateClient(
      {
        redirectUris: [
          "https://{host}/oauth2_callback",
          "https://app.example.com/callback",
        ],
        postLogoutRedirectUris: ["https://{host}/signed-out"],
      },
      undefined
    )
    // Handing the provider a URI carrying a literal `{host}` would advertise
    // a redirect no browser can be sent to; an empty list fails closed.
    expect(client.redirectUris).toEqual(["https://app.example.com/callback"])
    expect(client.postLogoutRedirectUris).toEqual([])
  })
})

describe("the default host — the runtime path", () => {
  it("takes the host of the issuer the current request resolved to", () => {
    const client = withIssuer("https://b.example.com/idp", () =>
      expandTemplateClient({ redirectUris: ["https://{host}/oauth2_callback"] })
    )
    // The MOUNT PATH is not part of a host: `/idp` must not travel into the
    // redirect URI.
    expect(client.redirectUris).toEqual([
      "https://b.example.com/oauth2_callback",
    ])
  })

  it("drops the template outside a request scope", () => {
    // Start-up, the CLI, a background job: `currentRequestIssuer()` is
    // `undefined` and there is nothing to expand with.
    expect(
      expandTemplateClient({ redirectUris: ["https://{host}/oauth2_callback"] })
        .redirectUris
    ).toEqual([])
  })

  it("drops the template when the request resolved no issuer", () => {
    expect(
      withIssuer(undefined, () =>
        expandTemplateClient({
          redirectUris: ["https://{host}/oauth2_callback"],
        })
      ).redirectUris
    ).toEqual([])
  })

  it("drops the template when the stashed issuer is not a URL", () => {
    // Defense in depth: `resolveRequestIssuer` cannot produce this, and the
    // answer if anything ever does is the fail-closed one, not a throw out of
    // `getClient()`.
    expect(
      withIssuer("not a url", () =>
        expandTemplateClient({
          redirectUris: ["https://{host}/oauth2_callback"],
        })
      ).redirectUris
    ).toEqual([])
  })
})
