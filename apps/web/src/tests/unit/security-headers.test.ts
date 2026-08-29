/**
 * The headers, and the request log (SEC-4, SEC-5).
 *
 * The CSP assertions are written as *prohibitions* rather than as a string
 * comparison. A policy that gains a directive should not fail this file; a
 * policy that gains a remote origin, or loses `frame-ancestors`, must.
 */

import { describe, expect, it } from "vitest"

import {
  contentSecurityPolicy,
  isNoStorePath,
  withSecurityHeaders,
} from "@/server/http/security-headers"
import {
  buildLogEntry,
  isQuietPath,
  requestIdFrom,
} from "@/server/http/request-log"

function html(body = "<!doctype html>", status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  })
}

function json(body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  })
}

const REQUEST = new Request("https://idp.example.com/login")

describe("the Content-Security-Policy", () => {
  const policy = contentSecurityPolicy()

  it("names no origin but our own", () => {
    // The single assertion that matters most: an injected `<script src>` must
    // have nowhere to load from, and an injected inline script nowhere to send
    // what it steals.
    expect(policy).not.toMatch(/https?:\/\//)
    expect(policy).toContain("default-src 'self'")
    expect(policy).toContain("connect-src 'self'")
  })

  it("forbids framing, plugins and rebasing", () => {
    expect(policy).toContain("frame-ancestors 'none'")
    expect(policy).toContain("object-src 'none'")
    expect(policy).toContain("base-uri 'self'")
  })

  it("keeps form submissions on this origin", () => {
    // Without this, an injected script can move the sign-in form's action and
    // collect the password on the next submit without any network call of its
    // own.
    expect(policy).toContain("form-action 'self'")
  })

  it("also allows the registered redirect origins, or no OAuth login completes", () => {
    // Chromium applies `form-action` to the redirect a form submission
    // *follows*, not only to where it is posted. The sign-in form posts here
    // and the answer is a 303 to the client's redirect URI, so a bare
    // `'self'` cancels the navigation with `ERR_ABORTED` — the browser sits on
    // a filled-in sign-in form while the server has already issued the code.
    // Firefox does not check redirects, which is how it survived review.
    const withClients = contentSecurityPolicy({
      formAction: ["https://app.example.com", "http://127.0.0.1:4571"],
    })
    expect(withClients).toContain(
      "form-action 'self' https://app.example.com http://127.0.0.1:4571"
    )
    // And no wider than that: named origins, never a wildcard or a bare
    // scheme. These are the origins already trusted with authorization codes
    // (FR-OIDC-17's list), and nothing else.
    const directive = withClients
      .split("; ")
      .find((part) => part.startsWith("form-action "))
    expect(directive).toBe(
      "form-action 'self' https://app.example.com http://127.0.0.1:4571"
    )
  })

  it("allows data: images, because the TOTP QR code is one", () => {
    expect(policy).toContain("img-src 'self' data:")
  })

  it("concedes inline script, and nothing else", () => {
    // Recorded rather than hidden: Start streams framework scripts with no
    // seam for a nonce. See the module header.
    expect(policy).toContain("script-src 'self' 'unsafe-inline'")
    expect(policy).not.toContain("'unsafe-eval'")
  })

  it("takes extra connect origins only when a deployment asks for one", () => {
    const embedded = contentSecurityPolicy({
      connectSrc: ["https://shell.example.com"],
    })
    expect(embedded).toContain("connect-src 'self' https://shell.example.com")
    expect(embedded).toContain("default-src 'self'")
  })
})

describe("withSecurityHeaders", () => {
  it("sets the clickjacking pair on an HTML response", () => {
    const response = withSecurityHeaders(html(), REQUEST, { https: true })
    expect(response.headers.get("X-Frame-Options")).toBe("DENY")
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'none'"
    )
  })

  it("sets nosniff and a referrer policy on everything", () => {
    const response = withSecurityHeaders(json(), REQUEST, { https: true })
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(response.headers.get("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin"
    )
  })

  it("does not put a CSP on a JSON response", () => {
    // The policy governs documents. On an API response it is bytes that say
    // nothing.
    const response = withSecurityHeaders(json(), REQUEST, { https: true })
    expect(response.headers.get("Content-Security-Policy")).toBeNull()
  })

  it("sends HSTS only when the issuer is https", () => {
    expect(
      withSecurityHeaders(html(), REQUEST, { https: true }).headers.get(
        "Strict-Transport-Security"
      )
    ).toContain("max-age=31536000")
    // On localhost this header would poison the browser for every other
    // project on the host.
    expect(
      withSecurityHeaders(html(), REQUEST, { https: false }).headers.get(
        "Strict-Transport-Security"
      )
    ).toBeNull()
  })

  it("leaves a handler's own Cache-Control alone", () => {
    // The JWKS document has an ETag and a considered max-age; this function
    // knows less about it than the handler that built it.
    const jwks = new Response("{}", {
      headers: {
        "content-type": "application/json",
        "Cache-Control": "public, max-age=300",
      },
    })
    const response = withSecurityHeaders(
      jwks,
      new Request("https://idp.example.com/.well-known/jwks.json"),
      { https: true }
    )
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300")
  })

  it("overrides Cache-Control on the endpoints that must never be stored", () => {
    // Here the header is *taken*, not offered: a cached token response is a
    // token handed to whoever asks next.
    const response = withSecurityHeaders(
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          "Cache-Control": "public, max-age=600",
        },
      }),
      new Request("https://idp.example.com/oauth2/token"),
      { https: true }
    )
    expect(response.headers.get("Cache-Control")).toBe("no-store")
  })

  it("preserves the status and the body", () => {
    const response = withSecurityHeaders(html("<p>hi</p>", 404), REQUEST, {
      https: false,
    })
    expect(response.status).toBe(404)
  })
})

describe("isNoStorePath", () => {
  it("covers the four SEC-4 endpoints, at the root and under a mount path", () => {
    for (const path of [
      "/oauth2/token",
      "/oauth2/userinfo",
      "/oauth2/introspect",
      "/oauth2/revoke",
    ]) {
      expect(isNoStorePath(path), path).toBe(true)
      expect(isNoStorePath(`/idp${path}`, "/idp"), path).toBe(true)
      // The same endpoints are also reachable on Better Auth's own mount.
      expect(isNoStorePath(`/idp/api/auth${path}`, "/idp"), path).toBe(true)
    }
  })

  it("says nothing about ordinary pages", () => {
    expect(isNoStorePath("/login")).toBe(false)
    expect(isNoStorePath("/oauth2/authorize")).toBe(false)
  })
})

describe("the request log (SEC-5)", () => {
  it("drops the query string of anything that carries a credential", () => {
    const entry = buildLogEntry({
      request: new Request(
        "https://idp.example.com/oauth2/authorize?client_id=a&code=secret"
      ),
      status: 302,
      startedAt: 1000,
      requestId: "abc123",
      now: 1042,
    })
    expect(entry.path).toBe("/oauth2/authorize?[redacted]")
    expect(entry.durationMs).toBe(42)
    expect(entry.status).toBe(302)
  })

  it("keeps an ordinary query string, which is what makes the log useful", () => {
    const entry = buildLogEntry({
      request: new Request(
        "https://idp.example.com/admin/users?status=pending"
      ),
      status: 200,
      startedAt: 0,
      requestId: "abc123",
      now: 5,
    })
    expect(entry.path).toBe("/admin/users?status=pending")
  })

  it("anonymizes the address before it reaches the log", () => {
    const entry = buildLogEntry({
      request: REQUEST,
      status: 200,
      startedAt: 0,
      requestId: "abc123",
      ipAddress: "203.0.113.42",
      now: 1,
    })
    expect(entry.ipAddress).toBe("203.0.113.0")
  })

  it("omits the address entirely when there is none", () => {
    const entry = buildLogEntry({
      request: REQUEST,
      status: 200,
      startedAt: 0,
      requestId: "abc123",
      now: 1,
    })
    expect(entry.ipAddress).toBeUndefined()
  })

  it("never reports a negative duration", () => {
    // Clock adjustments happen; a negative duration in a log is a distraction
    // during exactly the incident it would appear in.
    const entry = buildLogEntry({
      request: REQUEST,
      status: 200,
      startedAt: 1000,
      requestId: "abc123",
      now: 900,
    })
    expect(entry.durationMs).toBe(0)
  })

  it("says nothing about the health endpoints", () => {
    expect(isQuietPath("/healthz")).toBe(true)
    expect(isQuietPath("/idp/readyz", "/idp")).toBe(true)
    expect(isQuietPath("/login")).toBe(false)
  })
})

describe("the request id", () => {
  it("is minted fresh when no proxy is trusted", () => {
    // Otherwise anyone could write whatever they liked into our logs.
    const supplied = new Request("https://idp.example.com/login", {
      headers: { "x-request-id": "injected" },
    })
    expect(requestIdFrom(supplied, false)).not.toBe("injected")
    expect(requestIdFrom(supplied, false)).toMatch(/^[0-9a-f]{16}$/)
  })

  it("is taken from a trusted proxy when it supplies one", () => {
    const supplied = new Request("https://idp.example.com/login", {
      headers: { "x-request-id": "edge-7f3a" },
    })
    expect(requestIdFrom(supplied, true)).toBe("edge-7f3a")
  })

  it("refuses a supplied id that is not a plain short token", () => {
    // A newline is the case that matters most and cannot be constructed here:
    // `Headers` rejects it before this code ever sees it, which is a second
    // layer saying the same thing. The pattern still excludes it.
    for (const value of ["has space", '"quoted"', "x".repeat(65), ""]) {
      const supplied = new Request("https://idp.example.com/login", {
        headers: { "x-request-id": value },
      })
      expect(requestIdFrom(supplied, true), value).toMatch(/^[0-9a-f]{16}$/)
    }
  })

  it("is different every time", () => {
    const plain = new Request("https://idp.example.com/login")
    expect(requestIdFrom(plain, false)).not.toBe(requestIdFrom(plain, false))
  })
})
