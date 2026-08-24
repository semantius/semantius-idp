/**
 * Who may call which protocol endpoint from a browser (FR-OIDC-17).
 *
 * CORS on an identity provider is an authorisation decision, not a
 * convenience. Three different answers, for three different reasons:
 *
 * - **Discovery and JWKS: `*`.** Both are public, unauthenticated documents
 *   that every client has to read before it can do anything. Restricting them
 *   protects nothing and breaks every browser-based client.
 *
 * - **Token, revoke, userinfo: the registered redirect origins.** A public
 *   client running in a browser has to reach these, and the set of origins
 *   that legitimately do is exactly the set of origins the deployment already
 *   registered redirect URIs for. Allowing `*` here would let any page make
 *   credentialed calls on a user's behalf.
 *
 * - **Introspection: none.** It is a *resource server* endpoint, called
 *   server-to-server with the caller's own client credentials. A browser has
 *   no business there, and a CORS header would only help an attacker who has
 *   already got a secret into a page.
 *
 * Session endpoints and `GET /api/auth/token` get no CORS headers either:
 * they authenticate with the session cookie, so a permissive header would be
 * the difference between "cookies are same-origin" and "any page can read
 * this user's token" (SEC-3).
 */

import type { IdpConfig } from "../config/derive"

export type CorsPolicy = "public" | "clients" | "none"

/** Headers a protocol endpoint accepts. Kept minimal on purpose. */
const ALLOWED_HEADERS = "authorization, content-type, dpop"

export interface CorsDecision {
  headers: Record<string, string>
  /** True when the request was a preflight and needs a 204, not a body. */
  preflight: boolean
}

/**
 * Every origin that appears in a registered redirect or post-logout URI.
 *
 * Origins, not URIs: a browser sends `Origin: https://app.example.com` for a
 * page at any path, so matching on the full redirect URI would never allow
 * anything.
 */
export function clientOrigins(config: IdpConfig): Set<string> {
  const origins = new Set<string>()
  for (const client of config.clients) {
    for (const uri of [
      ...client.redirectUris,
      ...client.postLogoutRedirectUris,
    ]) {
      const origin = originOf(uri)
      if (origin) origins.add(origin)
    }
  }
  return origins
}

function originOf(uri: string): string | undefined {
  try {
    const url = new URL(uri)
    // A private-use scheme (`com.example.app:/cb`) is a native redirect and
    // has no browser origin to allow.
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined
    return url.origin
  } catch {
    return undefined
  }
}

/**
 * The CORS headers for one request, or none.
 *
 * `Vary: Origin` is set whenever the answer depends on the origin, so a shared
 * cache cannot serve one client's allowance to another.
 */
export function corsFor(
  request: Request,
  config: IdpConfig,
  policy: CorsPolicy
): CorsDecision {
  const preflight = request.method === "OPTIONS"
  if (policy === "none") return { headers: {}, preflight }

  if (policy === "public") {
    return {
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": ALLOWED_HEADERS,
        "access-control-max-age": "600",
      },
      preflight,
    }
  }

  const origin = request.headers.get("origin")
  if (!origin || !clientOrigins(config).has(origin)) {
    // No headers at all rather than a refusal: the browser turns a missing
    // `Access-Control-Allow-Origin` into the same error, and saying nothing
    // avoids confirming which origins are registered.
    return { headers: { vary: "Origin" }, preflight }
  }

  return {
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": ALLOWED_HEADERS,
      "access-control-allow-credentials": "true",
      "access-control-max-age": "600",
      vary: "Origin",
    },
    preflight,
  }
}

/** Copies the decision onto a response. */
export function withCors(response: Response, decision: CorsDecision): Response {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(decision.headers)) {
    headers.set(name, value)
  }
  return new Response(response.body, { status: response.status, headers })
}

/** The 204 a preflight expects. */
export function preflightResponse(decision: CorsDecision): Response {
  return new Response(null, { status: 204, headers: decision.headers })
}
