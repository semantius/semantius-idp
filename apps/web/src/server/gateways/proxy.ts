/**
 * `/gateway/<name>` — an authenticating reverse proxy (FR-GW-3..6, **D91**).
 *
 * **What it is for.** A backend resource server — PostgREST, Neon's Data API —
 * validates this IdP's JWTs against the JWKS and knows nothing about its
 * per-user API keys. A client holding only an `idp_…` key therefore cannot
 * call one at all. This endpoint closes that gap: it streams the request
 * through to a configured upstream and, when the caller presented an API key
 * and no `Authorization` of their own, exchanges the key for a session JWT and
 * injects it as `Authorization: Bearer`.
 *
 * **The exchange rides Better Auth's own token endpoint, and must.**
 * `GET {authBaseUrl}/token` with `x-api-key` already does the whole job:
 * it resolves the key, runs `gateApiKeyPlugin`'s ban/approval re-check
 * (FR-KEY-2), updates `lastRequest` / `requestCount` and the per-key limiter,
 * and mints a JWT whose `azp` is `apiKeys.tokenClientId` (FR-KEY-3). Every one
 * of those lives *only* there. Re-implementing the mint here would be a second
 * copy of the gate, and the second copy is the one that forgets the ban check.
 * It is called in-process through `auth.handler`, which is the pattern
 * `oidc/protocol-proxy.ts` established.
 *
 * **The ten-minute token cache is a security trade-off, recorded as one.** A
 * mint is several database round trips — ~100 ms each against a hosted
 * Postgres — so doing it per request would put that on every call through the
 * gateway. Caching it means a cache hit skips the ban re-check, which relaxes
 * FR-KEY-2's "asked on every use" for up to the TTL. Two things blunt that,
 * and both are deliberate: the TTL is `min(600 s, jwt.sessionToken.ttl − 60 s)`
 * so a cached token is never served near its own expiry, and the admin
 * ban/revoke paths call {@link resetGatewayTokenCache} (`admin/guard.ts`), so
 * a revocation made through this process punches straight through the window.
 * What is left is a revocation made *elsewhere* — `psql`, a second replica —
 * taking up to ten minutes. D91 records that as the accepted cost.
 *
 * **Cookies never cross in either direction.** Outbound, because a browser
 * hitting `/gateway/x` sends this IdP's session cookie and an upstream must
 * never receive it. Inbound, because the gateway is *same-origin with the
 * issuer*: an upstream `Set-Cookie` would land on the IdP's own origin and
 * path. For the same same-origin reason every gateway response carries a
 * forced `Content-Security-Policy: sandbox; default-src 'none'` — the IdP's
 * own policy concedes `'unsafe-inline'` for the framework's streamed scripts
 * (`http/security-headers.ts`), and that concession must not extend to
 * untrusted upstream HTML served on the issuer's hostname.
 */

import { createHash } from "node:crypto"

import type { IdpConfig } from "../config/derive"
import type { DbHandle } from "../db/client"
import { SOCKET_ADDRESS_HEADER, clientIpFrom } from "../http/client-ip"
import type { Logger } from "../logger"
import { createBasePaths } from "../oidc/base-path"
import { API_KEY_HEADER } from "../auth/options/api-key-gate"
import { lookupGateway, resetGatewayRegistry } from "./registry"
import type { GatewayRow } from "./registry"

export { resetGatewayRegistry }

/** Better Auth's own handler, narrowed to what this module uses. */
type AuthHandler = (request: Request) => Promise<Response>

/** The fetch shape used for the upstream call; injectable for tests. */
type FetchImpl = (input: string, init: RequestInit) => Promise<Response>

export interface GatewayProxyDeps {
  config: IdpConfig
  /** `handler()`, for the key → JWT exchange. */
  auth: { handler: AuthHandler }
  /** Registry lookups (cached; see `registry.ts`). */
  database: DbHandle
  logger?: Logger
  /** `password-breach.ts`'s precedent: the network is a dependency. */
  fetchImpl?: FetchImpl
  now?: () => number
  /**
   * The socket address, when something upstream of the router knows it.
   * `server-entry.ts` stamps it into {@link SOCKET_ADDRESS_HEADER}, which is
   * where this reads it from by default.
   */
  socketAddress?: string | null
}

/** The cap on the token cache's TTL, whatever the session token's lifetime is. */
export const TOKEN_CACHE_MAX_SECONDS = 600

/**
 * How long an invalid key is remembered as invalid.
 *
 * Short on purpose: a key created a moment ago must start working promptly,
 * and ten seconds is the documented worst case (**D91**). Its job is to blunt
 * a repeat — the same wrong key sent a thousand times a second is otherwise a
 * thousand database lookups.
 */
export const NEGATIVE_CACHE_MS = 10_000

/** Entries kept before the oldest are evicted. Expired ones go first. */
export const TOKEN_CACHE_MAX_ENTRIES = 5_000

/**
 * The mint-miss limiter (**D91**, review finding S3).
 *
 * Better Auth's per-key limit of 120/min only throttles keys that *resolve to
 * a row*; an invalid-key flood never reaches it and is a database
 * amplification straight through this endpoint. Worse, the synthetic mint
 * request is built here, so without an address on it every mint in the
 * deployment would share Better Auth's single `no-trusted-ip` bucket and a
 * spray would starve the legitimate ones.
 *
 * So: a fixed window per caller address, counted only on a cache *miss*, and
 * refused before anything touches the database.
 */
export const MINT_MISS_WINDOW_MS = 60_000
export const MINT_MISS_MAX = 30

/**
 * How long the upstream has to produce response *headers*.
 *
 * Time-to-first-byte only, cleared the moment they arrive — there is no total
 * duration limit, because a gateway in front of a streaming endpoint (SSE, a
 * large download) must not cut a healthy response off mid-flight. What this
 * kills is a connection that never answers at all.
 */
export const UPSTREAM_TTFB_TIMEOUT_MS = 30_000

interface CachedToken {
  token: string
  expiresAt: number
}

const tokenCache = new Map<string, CachedToken>()
/** Key hash → when the "currently invalid" verdict stops applying. */
const negativeCache = new Map<string, number>()
const mintMisses = new Map<string, { count: number; resetAt: number }>()

/**
 * Empties the key → JWT caches.
 *
 * Called by `admin/guard.ts` after a ban, a removal or an API-key revocation,
 * which is what makes the D91 window closable from inside this process. Also
 * the reset every test needs, because these maps are module-level by design.
 */
export function resetGatewayTokenCache(): void {
  tokenCache.clear()
  negativeCache.clear()
  mintMisses.clear()
}

/**
 * Headers that belong to one hop and are meaningless — or harmful — on the
 * next (RFC 9110 §7.6.1). `connection` also *names* further headers to drop,
 * which is handled beside this list.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

/**
 * Inbound headers that never reach the upstream, beyond the hop-by-hop set.
 *
 * `forwarded` and `x-real-ip` are here for the same reason `x-forwarded-*` is:
 * this hop is the one that gets to say where the request came from, and a
 * value the caller supplied would otherwise be forwarded as though a trusted
 * proxy had written it (review finding S5).
 */
const NEVER_FORWARDED = new Set([
  "host",
  "content-length",
  "cookie",
  "forwarded",
  "x-real-ip",
  API_KEY_HEADER,
  SOCKET_ADDRESS_HEADER,
])

const NO_STORE = { "cache-control": "no-store" } as const

/**
 * The policy every gateway response carries, set **explicitly** so that
 * `withSecurityHeaders`'s `setUnlessPresent` leaves it alone.
 */
const GATEWAY_CSP = "sandbox; default-src 'none'"

function refuse(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      "content-type": "application/json",
      ...NO_STORE,
      "content-security-policy": GATEWAY_CSP,
    },
  })
}

export async function proxyGatewayRequest(
  deps: GatewayProxyDeps,
  request: Request,
  name: string,
  subPath: string
): Promise<Response> {
  const row = await lookupGateway(
    { database: deps.database, ...(deps.logger ? { logger: deps.logger } : {}) },
    name
  )
  // FR-GW-6: unknown and disabled are the *same* answer. A 403 for a disabled
  // one would confirm that a gateway by that name exists, which is a fact an
  // anonymous caller has no business learning.
  if (!row || !row.enabled) return refuse(404, "unknown_gateway")

  // WebSockets need a hijacked socket that this handler never has. 501 rather
  // than a silent downgrade, so a client that asked for one is told.
  if (wantsUpgrade(request)) return refuse(501, "upgrade_not_supported")

  const outbound = new Headers()
  const dropped = connectionTokens(request)
  for (const [key, value] of request.headers) {
    const lower = key.toLowerCase()
    if (HOP_BY_HOP.has(lower) || NEVER_FORWARDED.has(lower)) continue
    if (dropped.has(lower)) continue
    // This hop decides what `X-Forwarded-*` says; see `NEVER_FORWARDED`.
    if (lower.startsWith("x-forwarded-")) continue
    outbound.append(key, value)
  }

  const clientIp = clientIpFrom(request, deps.config.file.server.trustProxy, {
    socketAddress:
      deps.socketAddress ?? request.headers.get(SOCKET_ADDRESS_HEADER),
  })

  const translated = await translateAuth(deps, request, row, clientIp)
  if (translated.refusal) return translated.refusal
  if (translated.authorization) {
    outbound.set("authorization", translated.authorization)
  }

  applyForwardedHeaders(deps, request, outbound, clientIp)

  const incoming = new URL(request.url)
  const target = `${row.url}${subPath === "" ? "" : `/${subPath}`}${incoming.search}`

  const bodiless = request.method === "GET" || request.method === "HEAD"
  const controller = new AbortController()
  // TTFB only. `request.signal` propagates a client disconnect so the upstream
  // connection does not outlive the caller.
  const onAbort = () => {
    controller.abort()
  }
  request.signal.addEventListener("abort", onAbort, { once: true })
  const timer = setTimeout(() => {
    controller.abort()
  }, UPSTREAM_TTFB_TIMEOUT_MS)

  let upstream: Response
  try {
    upstream = await (deps.fetchImpl ?? globalThis.fetch)(target, {
      method: request.method,
      headers: outbound,
      ...(bodiless ? {} : { body: request.body }),
      // Required by the platform for a streamed request body.
      duplex: "half",
      // A 3xx is the upstream's answer to the caller, not an instruction to
      // this proxy (FR-GW-3).
      redirect: "manual",
      // The bytes are shovelled untouched: `accept-encoding` passed through,
      // `content-encoding` forwarded verbatim. Decompressing here would burn
      // CPU on every response and throw away the compression the client asked
      // for (review finding P1).
      decompress: false,
      signal: controller.signal,
    } as RequestInit)
  } catch (error) {
    return badGateway(deps, name, error)
  } finally {
    clearTimeout(timer)
    request.signal.removeEventListener("abort", onAbort)
  }

  return buildResponse(request, upstream, row)
}

/** `Connection: x, y` names further headers that must not be forwarded. */
function connectionTokens(message: { headers: Headers }): Set<string> {
  const value = message.headers.get("connection")
  if (!value) return new Set()
  return new Set(
    value
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token !== "")
  )
}

function wantsUpgrade(request: Request): boolean {
  if (request.headers.has("upgrade")) return true
  return connectionTokens(request).has("upgrade")
}

interface Translation {
  authorization?: string
  refusal?: Response
}

/**
 * FR-GW-4, the whole of it.
 *
 * `Authorization` present wins outright — even alongside `x-api-key`. A caller
 * who sent a bearer token of their own has said what they want presented, and
 * silently replacing it would make the gateway lie about who is calling.
 */
async function translateAuth(
  deps: GatewayProxyDeps,
  request: Request,
  row: GatewayRow,
  clientIp: string | undefined
): Promise<Translation> {
  const existing = request.headers.get("authorization")
  if (existing) return { authorization: existing }

  const key = request.headers.get(API_KEY_HEADER)
  if (!key) {
    // PostgREST and the Data API both have an anonymous role, so anonymous
    // reach is a legitimate configuration — and `requireAuth` is the knob for
    // the upstream where it is not.
    return row.requireAuth ? { refusal: refuse(401, "auth_required") } : {}
  }

  const now = deps.now ?? Date.now
  const hash = hashKey(key)

  const cached = tokenCache.get(hash)
  if (cached && cached.expiresAt > now()) {
    return { authorization: `Bearer ${cached.token}` }
  }
  if (cached) tokenCache.delete(hash)

  const negativeUntil = negativeCache.get(hash)
  if (negativeUntil !== undefined && negativeUntil > now()) {
    return { refusal: refuse(401, "invalid_api_key") }
  }
  if (negativeUntil !== undefined) negativeCache.delete(hash)

  // Before the database, not after: the point of the limiter is that an
  // invalid-key flood costs nothing to refuse.
  if (!allowMintAttempt(clientIp, now())) {
    return { refusal: refuse(429, "too_many_mint_attempts") }
  }

  const minted = await mint(deps, key, clientIp)
  if (minted.status === 429) {
    // Better Auth's own per-key limit. Passed through rather than translated:
    // the caller is being told to slow down and that is exactly true.
    return { refusal: refuse(429, "rate_limited") }
  }
  if (!minted.token) {
    negativeCache.set(hash, now() + NEGATIVE_CACHE_MS)
    return { refusal: refuse(401, "invalid_api_key") }
  }

  storeToken(deps, hash, minted.token, now())
  return { authorization: `Bearer ${minted.token}` }
}

/**
 * SHA-256, never the key itself.
 *
 * Unsalted is right here: an `idp_` key is a high-entropy random secret, so
 * there is no dictionary to precompute, and a per-process salt would only stop
 * this map from being useful across a restart, which it is not anyway.
 */
function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("base64url")
}

function allowMintAttempt(
  clientIp: string | undefined,
  now: number
): boolean {
  // A runtime that cannot report an address genuinely does not know who is
  // calling (`clientIpFrom` says so); one shared bucket is the honest answer
  // and it is still narrower than no limit at all.
  const bucket = clientIp ?? "unknown"
  const current = mintMisses.get(bucket)
  if (!current || current.resetAt <= now) {
    mintMisses.set(bucket, { count: 1, resetAt: now + MINT_MISS_WINDOW_MS })
    return true
  }
  current.count += 1
  return current.count <= MINT_MISS_MAX
}

interface MintResult {
  status: number
  token?: string
}

async function mint(
  deps: GatewayProxyDeps,
  key: string,
  clientIp: string | undefined
): Promise<MintResult> {
  const paths = createBasePaths(deps.config.base)
  const headers = new Headers({ [API_KEY_HEADER]: key })
  // The address the auth instance's own resolver trusts, so Better Auth
  // buckets this mint per caller instead of collapsing every one of them into
  // the shared `no-trusted-ip|/token` bucket (`auth/instance.ts`).
  if (clientIp) {
    headers.set(
      deps.config.file.server.trustProxy === false
        ? SOCKET_ADDRESS_HEADER
        : "x-forwarded-for",
      clientIp
    )
  }

  const response = await deps.auth.handler(
    new Request(`${paths.authBaseUrl}/token`, { headers })
  )
  if (response.status !== 200) return { status: response.status }

  try {
    const body = (await response.json()) as { token?: unknown }
    return typeof body.token === "string"
      ? { status: 200, token: body.token }
      : { status: 500 }
  } catch {
    return { status: 500 }
  }
}

/**
 * Caches a minted token, with the size cap enforced expired-first.
 *
 * `apiKeys.tokenTtl` is deliberately **not** what bounds this: it feeds the
 * JWKS grace period, and the token's real lifetime is `jwt.sessionToken.ttl`
 * (FR-OIDC-14). The minus-sixty is so a cached token is never handed out in
 * the last minute of its own life, where a slow upstream would receive an
 * expired bearer.
 */
function storeToken(
  deps: GatewayProxyDeps,
  hash: string,
  token: string,
  now: number
): void {
  const seconds = Math.min(
    TOKEN_CACHE_MAX_SECONDS,
    deps.config.file.jwt.sessionToken.ttl - 60
  )
  if (seconds <= 0) return

  if (tokenCache.size >= TOKEN_CACHE_MAX_ENTRIES) {
    for (const [existing, entry] of tokenCache) {
      if (entry.expiresAt <= now) tokenCache.delete(existing)
    }
    // Insertion order is oldest-first, so this is the least recently minted.
    while (tokenCache.size >= TOKEN_CACHE_MAX_ENTRIES) {
      const oldest = tokenCache.keys().next()
      if (oldest.done) break
      tokenCache.delete(oldest.value)
    }
  }

  tokenCache.set(hash, { token, expiresAt: now + seconds * 1000 })
}

/**
 * `X-Forwarded-For` / `-Host` / `-Proto`, from **the inbound hop**.
 *
 * Not from `server.baseUrl`: SEC-1 governs the URLs the IdP *emits* — issuer,
 * discovery documents, e-mail links — and this is the opposite direction. An
 * upstream that builds its own links needs to know the address the caller
 * actually used, and inventing the configured one would break exactly the
 * sub-path and reverse-proxy deployments SEC-1 exists to make work.
 */
function applyForwardedHeaders(
  deps: GatewayProxyDeps,
  request: Request,
  outbound: Headers,
  clientIp: string | undefined
): void {
  if (clientIp) outbound.set("X-Forwarded-For", clientIp)

  const trustProxy = deps.config.file.server.trustProxy
  const incoming = new URL(request.url)
  const forwardedHost =
    trustProxy !== false ? request.headers.get("x-forwarded-host") : null
  const forwardedProto =
    trustProxy !== false ? request.headers.get("x-forwarded-proto") : null

  outbound.set(
    "X-Forwarded-Host",
    forwardedHost ?? request.headers.get("host") ?? incoming.host
  )
  outbound.set(
    "X-Forwarded-Proto",
    forwardedProto ?? incoming.protocol.replace(":", "")
  )
}

function badGateway(
  deps: GatewayProxyDeps,
  name: string,
  error: unknown
): Response {
  // The name and the cause, never the URL: a target can carry a host an
  // operator would rather not have in a log aggregator (SEC-5).
  deps.logger?.warn("gateway upstream did not answer", {
    gateway: name,
    error: error instanceof Error ? error.message : String(error),
  })
  return refuse(502, "bad_gateway")
}

/** Statuses that must not carry a body, whatever the upstream sent. */
const BODILESS_STATUS = new Set([204, 205, 304])

function buildResponse(
  request: Request,
  upstream: Response,
  row: GatewayRow
): Response {
  const headers = new Headers()
  const dropped = connectionTokens(upstream)
  for (const [key, value] of upstream.headers) {
    const lower = key.toLowerCase()
    if (HOP_BY_HOP.has(lower) || dropped.has(lower)) continue
    // Same-origin with the issuer: an upstream must not be able to set a
    // cookie on this host and path (**D91**, review finding S2).
    if (lower === "set-cookie") continue
    if (lower === "content-security-policy") continue
    if (lower === "content-security-policy-report-only") continue
    headers.append(key, value)
  }

  const location = upstream.headers.get("location")
  if (location !== null && !sameUpstreamOrigin(location, row.url)) {
    // A 3xx passes through, but its target does not: an open redirect on the
    // *issuer's* hostname is a phishing primitive that borrows the IdP's own
    // reputation (review finding S4). The status is left alone so the caller
    // still sees that a redirect happened.
    headers.delete("location")
  }

  headers.set("Content-Security-Policy", GATEWAY_CSP)
  headers.set("Cache-Control", "no-store")

  const bodiless =
    request.method === "HEAD" || BODILESS_STATUS.has(upstream.status)

  return new Response(bodiless ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  })
}

/**
 * Whether a `Location` stays on the upstream's own origin.
 *
 * Resolved against the upstream rather than pattern-matched, which is what
 * makes the protocol-relative form (`//evil.example`) come out as the
 * cross-origin redirect it is rather than as a relative path.
 */
function sameUpstreamOrigin(location: string, upstreamUrl: string): boolean {
  try {
    const base = new URL(upstreamUrl)
    return new URL(location, base).origin === base.origin
  } catch {
    return false
  }
}
