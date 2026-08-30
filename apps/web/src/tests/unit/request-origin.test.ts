/**
 * The address a request arrived on (SEC-3, **D68**).
 *
 * This is one half of a CSRF check, so the questions are the adversarial ones:
 * *can a value that is not a host get out of here, and can a header choose an
 * origin it should not?* A junk value that escaped would land in Better Auth's
 * pattern matcher, where `*` and `?` are wildcards — an allow-list entry of
 * `*.example` would trust the internet.
 */

import { describe, expect, it } from "vitest"

import { assertSameOrigin, requestOrigins } from "@/server/http/request-origin"

function request(headers: Record<string, string>): Request {
  return new Request("http://internal.svc:3000/api/auth/sign-in/email", {
    method: "POST",
    headers,
  })
}

describe("requestOrigins", () => {
  it("trusts the host the browser addressed, not the one we listen on", () => {
    // The whole point: the request came in on `internal.svc:3000` and the
    // browser is on `idp.example.com`, which is the pair a reverse proxy
    // produces and the pair the old default refused.
    expect(requestOrigins(request({ host: "idp.example.com" }))).toEqual([
      "https://idp.example.com",
      "http://idp.example.com",
    ])
  })

  it("prefers X-Forwarded-Host, and keeps Host as well", () => {
    // A proxy that rewrites `Host` to its upstream sends the browser-facing
    // name in `X-Forwarded-Host`. Both are legitimate ways to reach us.
    expect(
      requestOrigins(
        request({
          host: "internal.svc:3000",
          "x-forwarded-host": "idp.example.com",
        })
      )
    ).toEqual([
      "https://idp.example.com",
      "http://idp.example.com",
      "https://internal.svc:3000",
      "http://internal.svc:3000",
    ])
  })

  it("takes the leftmost hop of a rewritten chain", () => {
    // Proxies append, so the left is the name the browser used. The opposite
    // end from `X-Forwarded-For`, where the left is the forgeable one.
    expect(
      requestOrigins(
        request({
          host: "idp.example.com",
          "x-forwarded-host": "idp.example.com, inner.example",
        })
      )
    ).toEqual(["https://idp.example.com", "http://idp.example.com"])
  })

  it("keeps the port, because an origin with one is a different origin", () => {
    expect(requestOrigins(request({ host: "localhost:3000" }))).toEqual([
      "https://localhost:3000",
      "http://localhost:3000",
    ])
  })

  it("keeps an IPv6 literal in the form an Origin header uses", () => {
    expect(requestOrigins(request({ host: "[::1]:3000" }))).toEqual([
      "https://[::1]:3000",
      "http://[::1]:3000",
    ])
  })

  it("says nothing when there is no request at all", () => {
    // `auth.api.*` calls have none, and inventing an origin for them would
    // trust a request nobody made.
    expect(requestOrigins()).toEqual([])
  })

  it("falls back to the URL of a request that was not read off a socket", () => {
    // `http/auth-proxy.ts` builds one of these. A real request always carries
    // `Host`; a constructed one carries whatever its caller copied across.
    expect(requestOrigins(new Request("http://x.example/"))).toEqual([
      "https://x.example",
      "http://x.example",
    ])
  })

  it("refuses anything that is not a bare host", () => {
    // Each of these would become an origin *pattern* downstream, and the first
    // two are the reason: Better Auth reads `*` and `?` as wildcards, so a
    // forwarded `*` would switch the check off for its own request.
    for (const value of [
      "*",
      "*.example.com",
      "idp.example.?om",
      "evil.example/path",
      "https://evil.example",
      "idp example.com",
      "",
      "   ",
    ]) {
      // Only what `Host` said survives — the header contributed nothing.
      expect(
        requestOrigins(
          request({ host: "idp.example.com", "x-forwarded-host": value })
        )
      ).toEqual(["https://idp.example.com", "http://idp.example.com"])
    }
  })

  it("lower-cases the host, because origin comparison is exact", () => {
    expect(requestOrigins(request({ host: "IDP.Example.COM" }))).toEqual([
      "https://idp.example.com",
      "http://idp.example.com",
    ])
  })
})

/**
 * The gate in front of the two destructive account posts (**D101**).
 *
 * Its whole job is to be un-choosable by the page making the request:
 * `Sec-Fetch-Site` is set by the browser, and `Origin` is set by the browser
 * from the page's own address. So the table below is read as "what a browser
 * would send", and every row that a hostile page could produce has to refuse.
 */
describe("assertSameOrigin", () => {
  const OWN = "http://idp.example.com"

  function post(headers: Record<string, string>): Request {
    return new Request("http://internal.svc:3000/account/sessions", {
      method: "POST",
      headers: { "x-forwarded-host": "idp.example.com", ...headers },
    })
  }

  it("allows the page posting to itself", () => {
    expect(
      assertSameOrigin(post({ origin: OWN, "sec-fetch-site": "same-origin" }))
    ).toBe(true)
  })

  it("allows a typed address or a bookmark, which is `none`", () => {
    expect(assertSameOrigin(post({ "sec-fetch-site": "none" }))).toBe(true)
  })

  it("allows a caller that sends no Fetch-Metadata and no Origin", () => {
    // Not a browser. Whatever attached the cookie already holds it, and CSRF
    // is not something that can be done to it.
    expect(assertSameOrigin(post({}))).toBe(true)
  })

  it("refuses a cross-site post", () => {
    expect(
      assertSameOrigin(
        post({ origin: "https://evil.example", "sec-fetch-site": "cross-site" })
      )
    ).toBe(false)
  })

  it("refuses a same-site sibling subdomain", () => {
    // The case `SameSite=Lax` does not cover: `apps.example.com` is same-site
    // with `idp.example.com`, and `server.cookieDomain` (**D97**) is what
    // makes such a page carry the session cookie.
    expect(
      assertSameOrigin(
        post({
          origin: "http://apps.example.com",
          "sec-fetch-site": "same-site",
        })
      )
    ).toBe(false)
  })

  it("refuses an Origin that does not name the address the request arrived on", () => {
    // No Fetch-Metadata at all, which is what an older browser sends.
    expect(assertSameOrigin(post({ origin: "https://evil.example" }))).toBe(
      false
    )
  })

  it("refuses the opaque `null` origin", () => {
    // A sandboxed iframe or a cross-origin redirect. It names no address, so
    // it cannot name this one.
    expect(assertSameOrigin(post({ origin: "null" }))).toBe(false)
  })

  it("accepts either scheme on the request's own host", () => {
    // The scheme is deliberately not pinned: a TLS-terminating proxy that
    // forwards over plain http and forgets `X-Forwarded-Proto` is common, and
    // pinning it would refuse exactly the deployments this exists for.
    expect(assertSameOrigin(post({ origin: "https://idp.example.com" }))).toBe(
      true
    )
    expect(assertSameOrigin(post({ origin: "http://idp.example.com" }))).toBe(
      true
    )
  })
})
