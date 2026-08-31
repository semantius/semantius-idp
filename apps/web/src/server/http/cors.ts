/**
 * Who may call which protocol endpoint from a browser (FR-OIDC-17).
 *
 * CORS on an identity provider is an authorization decision, not a
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

import { expandHostTemplate, hasHostTemplate } from "../../lib/client-rules"
import { currentRequestIssuer } from "./request-log"
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
 * Origins contributed by **enabled database clients** (D50).
 *
 * Registered through `/admin/clients`, so they are not in the configuration
 * file this module can see. Kept in the process rather than queried per
 * request: `clientOrigins` is called on every protocol request *and* on every
 * response, to build the CSP `form-action` list (D46), and a database round
 * trip in that path would be a query per asset.
 *
 * Refreshed at start-up and by every client mutation — see
 * `server/oidc/client-origins.ts`. OPS-11's single-instance topology is what
 * makes a process-local cache correct; a second replica would see its own
 * clients and not the other's until the next restart, which is the same
 * limitation every other cached decision in this codebase has.
 */
let databaseOrigins: ReadonlySet<string> = new Set()

/** Replaces the cached set. The only writer is `client-origins.ts`. */
export function setDatabaseClientOrigins(origins: Iterable<string>): void {
  databaseOrigins = new Set(origins)
}

/** For tests, and for a stack that wants to prove the cache starts empty. */
export function clearDatabaseClientOrigins(): void {
  databaseOrigins = new Set()
}

/**
 * Every origin that appears in a registered redirect or post-logout URI.
 *
 * Origins, not URIs: a browser sends `Origin: https://app.example.com` for a
 * page at any path, so matching on the full redirect URI would never allow
 * anything.
 *
 * File clients ∪ enabled database clients. Leaving the second half out is what
 * would make an admin-registered client's sign-in fail in Chrome and nowhere
 * else: the authorization completes and the browser refuses the `form-action`
 * redirect back to it.
 *
 * `{host}` templates expand HERE, at read time, from the current request's
 * issuer — never earlier. Both stores hold the template verbatim (the config
 * file by definition, the database rows by `reconcile.ts`'s contract, and the
 * refresher below runs at start-up and after admin mutations, OUTSIDE any
 * request, where there is no host to expand with). A template that cannot be
 * expanded — no request in scope — contributes nothing: an unexpanded
 * `https://{host}` can never equal a real `Origin` header, so dropping it is
 * the same refusal stated honestly.
 */
export function clientOrigins(config: IdpConfig): Set<string> {
  const origins = new Set<string>()
  const requestHost = currentIssuerHost()
  const add = (origin: string | undefined) => {
    if (!origin) return
    if (hasHostTemplate(origin)) {
      if (requestHost) origins.add(expandHostTemplate(origin, requestHost))
      return
    }
    origins.add(origin)
  }
  for (const client of config.clients) {
    for (const uri of [
      ...client.redirectUris,
      ...client.postLogoutRedirectUris,
    ]) {
      add(originOf(uri))
    }
  }
  for (const origin of databaseOrigins) add(origin)
  return origins
}

/** The `host[:port]` of the issuer the current request resolved to. */
function currentIssuerHost(): string | undefined {
  const issuer = currentRequestIssuer()
  if (!issuer) return undefined
  try {
    return new URL(issuer).host
  } catch {
    return undefined
  }
}

/**
 * The browser origins among a set of redirect URIs.
 *
 * Exported so the refresher can map database rows the same way this module
 * maps configured ones — a native client's `com.example.app:/cb` has no origin
 * and must not become one.
 */
export function browserOriginsOf(uris: readonly string[]): string[] {
  return uris
    .map((uri) => originOf(uri))
    .filter((origin): origin is string => origin !== undefined)
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
