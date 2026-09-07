/**
 * `/gateway/<name>` — an authenticating reverse proxy.
 *
 * **What it is for.** A backend resource server — PostgREST, Neon's Data API —
 * validates this IdP's JWTs against the JWKS and knows nothing about its
 * per-user API keys or its browser sessions. A caller holding either therefore
 * cannot reach one at all. This endpoint closes that gap: it streams the
 * request through to a configured upstream and turns whatever credential the
 * caller arrived with into an `Authorization: Bearer` the upstream can verify.
 *
 * **Three credentials, in a fixed order** ({@link translateAuth}):
 *
 *  1. `Authorization` — forwarded untouched. The caller said what they want
 *     presented and this is not the place to second-guess it.
 *  2. `x-api-key` — exchanged. A refusal is a 401, because the caller chose to
 *     present it.
 *  3. the **session cookie** — exchanged, and never forwarded. A refusal falls
 *     through to anonymous, because the browser attached it by itself.
 *
 * **Every exchange rides Better Auth's own token endpoint, and must.**
 * `GET {authBaseUrl}/token` already does the whole job for both: with
 * `x-api-key` it resolves the key, runs `gateApiKeyPlugin`'s ban/approval
 * re-check, updates `lastRequest` / `requestCount` and the per-key
 * limiter, and mints a JWT whose `azp` is `apiKeys.tokenClientId`;
 * with a cookie it validates the session and mints one whose `azp` is the
 * IdP's own id. Every one of those lives *only* there. Re-implementing a mint
 * here would be a second copy of the gate, and the second copy is the one that
 * forgets the ban check. It is called in-process through `auth.handler`, which
 * is the pattern `oidc/protocol-proxy.ts` established — and the upstream can
 * tell the two apart, because `azp` says which.
 *
 * **The ten-minute token cache is a security trade-off, recorded as one.** A
 * mint is several database round trips — ~100 ms each against a hosted
 * Postgres — so doing it per request would put that on every call through the
 * gateway. Caching it means a cache hit skips the ban re-check, which relaxes
 * the spec's "asked on every use" for up to the TTL. Two things blunt that,
 * and both are deliberate: the TTL is `min(600 s, jwt.sessionToken.ttl − 60 s)`
 * so a cached token is never served near its own expiry, and the admin
 * ban/revoke/sign-out paths call {@link resetGatewayTokenCache}
 * (`admin/guard.ts`), so a revocation made through this process punches
 * straight through the window. What is left is a revocation made *elsewhere* —
 * `psql`, a second replica — taking up to ten minutes. The gateway design records that as the
 * accepted cost.
 *
 * **Cookies never cross in either direction.** Outbound, because a browser
 * hitting `/gateway/x` sends this IdP's session cookie and an upstream must
 * never receive it — reading it as a credential does not change that.
 * Inbound, because the gateway is *same-origin with the issuer*: an upstream
 * `Set-Cookie` would land on the IdP's own origin and path. For the same
 * same-origin reason every gateway response carries a forced
 * `Content-Security-Policy: sandbox; default-src 'none'` — the IdP's own
 * policy concedes `'unsafe-inline'` for the framework's streamed scripts
 * (`http/security-headers.ts`), and that concession must not extend to
 * untrusted upstream HTML served on the issuer's hostname. Same-origin is also
 * why the cookie path carries a Fetch-Metadata check; see
 * {@link sessionCredential}.
 */

import { createHash } from "node:crypto"
import { lookup } from "node:dns/promises"

import { isLinkLocalAddress } from "../../lib/gateway-rules"
import { withRequestedAudience } from "../auth/requested-audience"
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

/**
 * Hostname → every address it resolves to; injectable for tests, which
 * otherwise would hit real DNS for `upstream.example` on every call.
 */
type ResolveImpl = (hostname: string) => Promise<string[]>

export interface GatewayProxyDeps {
  config: IdpConfig
  /** `handler()`, for the key → JWT exchange. */
  auth: { handler: AuthHandler }
  /** Registry lookups (cached; see `registry.ts`). */
  database: DbHandle
  logger?: Logger
  /** `password-breach.ts`'s precedent: the network is a dependency. */
  fetchImpl?: FetchImpl
  /** The resolver behind {@link upstreamAddressProblem}. */
  resolveImpl?: ResolveImpl
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
 * How long a refused credential is remembered as refused.
 *
 * Short on purpose: a key created a moment ago must start working promptly,
 * and ten seconds is the documented worst case. Its job is to blunt
 * a repeat — the same wrong key sent a thousand times a second is otherwise a
 * thousand database lookups. A fresh sign-in is unaffected either way: a new
 * session is a new token, so it is a different cache entry.
 */
export const NEGATIVE_CACHE_MS = 10_000

/** Entries kept before the oldest are evicted. Expired ones go first. */
export const TOKEN_CACHE_MAX_ENTRIES = 5_000

/**
 * The mint-miss limiter (review finding S3).
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
 * Empties the credential → JWT caches.
 *
 * Called by `admin/guard.ts` after a ban, a removal, an API-key revocation or
 * a sign-out, which is what makes the cache window closable from inside this
 * process. Also the reset every test needs, because these maps are
 * module-level by design.
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
 * Inbound headers that never reach the upstream, whatever else is true.
 *
 * `cookie` is the one worth pausing on: `/gateway/*` is on the issuer's own
 * origin and inside the session cookie's `Path`, so a browser attaches this
 * IdP's session cookie to every gateway request automatically. It is read
 * here — {@link translateAuth} exchanges it for a JWT — and it is
 * never passed on.
 */
const NEVER_FORWARDED = new Set([
  "host",
  "content-length",
  "cookie",
  API_KEY_HEADER,
  SOCKET_ADDRESS_HEADER,
])

/**
 * Headers that say where the request came from.
 *
 * Always dropped, because a value the caller supplied would otherwise reach
 * the upstream as though a trusted proxy had written it (review finding S5),
 * and replaced with this hop's own view — see {@link applyForwardedHeaders}.
 */
const FORWARDING_HEADERS = ["forwarded", "x-real-ip"] as const

function isForwardingHeader(lower: string): boolean {
  return (
    lower.startsWith("x-forwarded-") ||
    (FORWARDING_HEADERS as readonly string[]).includes(lower)
  )
}

const NO_STORE = { "cache-control": "no-store" } as const

/**
 * Upstream response headers that never reach the caller.
 *
 * The test for membership is one question: **does a browser honor this per
 * origin, or does it state a policy the IdP's own `security-headers.ts`
 * already sets for its origin?** `/gateway/*` *is* the issuer's origin, so an
 * upstream that could set any of these would be setting it for the IdP —
 * and `withSecurityHeaders` uses `setUnlessPresent`, so an upstream's value
 * would win over the IdP's own. A deny-list rather than an allow-list on
 * purpose: PostgREST answers with `Content-Range`, `Content-Location`,
 * `Preference-Applied`, `Content-Profile` and `Proxy-Status`, a REST upstream
 * paginates with `Link`, and an allow-list is the list that forgets the next
 * one of those. Each entry, and why:
 *
 *  - `set-cookie` (and the ancient `set-cookie2`): a cookie on the issuer's
 *    origin and path.
 *  - `content-security-policy(-report-only)`: replaced by the forced
 *    sandbox policy below; an upstream's would be OR-ed with it in the
 *    browser and could add a reporting endpoint.
 *  - `access-control-*`: a CORS grant is a statement about who may read
 *    responses from *this* origin, and `http/cors.ts` is the only thing
 *    entitled to make one.
 *  - `strict-transport-security`: per host, persisted — `max-age=0` from an
 *    upstream would clear the IdP's own.
 *  - `x-frame-options`, `permissions-policy`, `feature-policy`: the IdP sets
 *    these for its origin; an upstream `X-Frame-Options: ALLOWALL` or
 *    `Permissions-Policy: camera=*` would replace them on that response.
 *  - `clear-site-data`: `"*"` on a same-origin response wipes the IdP's
 *    cookies and storage — every session on that browser, signed out by an
 *    upstream.
 *  - `refresh`: an HTTP `Refresh` is a navigation the browser performs, to
 *    any URL, which is the open redirect the `Location` check below exists
 *    to stop, through a header that check does not read.
 *  - `report-to`, `reporting-endpoints`, `nel`: origin-scoped reporting
 *    registrations; NEL in particular persists and would ship the IdP's own
 *    network-error reports — URLs included — to a collector the upstream
 *    chose.
 *  - `alt-svc`: an alternative *service* for the origin; the browser would
 *    connect there for the issuer's later requests.
 *  - `public-key-pins(-report-only)`: obsolete, and the one header that can
 *    lock a browser out of a host for its `max-age`.
 *
 * **Deliberately not here**: `link` (inert under `default-src 'none'`, and
 * how REST APIs paginate), `www-authenticate` (an upstream 401 has to be
 * able to say what it wants), `referrer-policy`, `x-content-type-options`
 * and the `cross-origin-*-policy` trio (each restricts rather than grants),
 * and `location`, which has its own origin check.
 */
const RESPONSE_DENY = new Set([
  "strict-transport-security",
  "x-frame-options",
  "permissions-policy",
  "feature-policy",
  "clear-site-data",
  "refresh",
  "report-to",
  "reporting-endpoints",
  "nel",
  "alt-svc",
])
const RESPONSE_DENY_PREFIXES = [
  "set-cookie",
  "content-security-policy",
  "access-control-",
  "public-key-pins",
]

function isDeniedResponseHeader(lower: string): boolean {
  if (RESPONSE_DENY.has(lower)) return true
  return RESPONSE_DENY_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

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
  // unknown and disabled are the *same* answer. A 403 for a disabled
  // one would confirm that a gateway by that name exists, which is a fact an
  // anonymous caller has no business learning.
  if (!row || !row.enabled) return refuse(404, "unknown_gateway")

  // WebSockets need a hijacked socket that this handler never has. 501 rather
  // than a silent downgrade, so a client that asked for one is told.
  if (wantsUpgrade(request)) return refuse(501, "upgrade_not_supported")

  const incoming = new URL(request.url)
  const target = resolveTarget(row.url, subPath, incoming.search)
  // A sub-path that climbs out of the target is a request this proxy does
  // not have an upstream for. 400 rather than 404: The spec keeps
  // 404 for "no such gateway", and an upstream's own 404 passes through, so
  // a third meaning on the same status would leave an operator unable to
  // tell which of the three they are looking at.
  if (target === undefined) return refuse(400, "invalid_path")

  // Before anything is minted or connected: a body that says it is too big
  // is refused on its word.
  const limit = deps.config.file.server.maxRequestBodyBytes
  const declared = request.headers.get("content-length")
  if (declared !== null && Number(declared) > limit) {
    return refuse(413, "payload_too_large")
  }

  const address = await upstreamAddressProblem(deps, row)
  if (address) return badGateway(deps, name, address, "link_local")

  const outbound = new Headers()
  const dropped = connectionTokens(request)
  for (const [key, value] of request.headers) {
    const lower = key.toLowerCase()
    if (HOP_BY_HOP.has(lower) || NEVER_FORWARDED.has(lower)) continue
    if (dropped.has(lower)) continue
    // This hop is the one that gets to say where the request came from.
    if (isForwardingHeader(lower)) continue
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

  const bodiless = request.method === "GET" || request.method === "HEAD"
  const controller = new AbortController()
  // Set by the counting stream the moment the cap is passed, before it
  // aborts the upstream call — so the catch below can tell a 413 from a 502.
  // An object rather than a `let`: the assignment happens inside a closure,
  // which TypeScript's narrowing cannot see, and a plain boolean reads as
  // "always false" at the catch.
  const cap = { exceeded: false }
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
      ...(bodiless || request.body === null
        ? {}
        : {
            body: cappedBody(request.body, limit, () => {
              cap.exceeded = true
              controller.abort()
            }),
          }),
      // Required by the platform for a streamed request body.
      duplex: "half",
      // A 3xx is the upstream's answer to the caller, not an instruction to
      // this proxy.
      redirect: "manual",
      // The bytes are shovelled untouched: `accept-encoding` passed through,
      // `content-encoding` forwarded verbatim. Decompressing here would burn
      // CPU on every response and throw away the compression the client asked
      // for (review finding P1).
      decompress: false,
      signal: controller.signal,
    } as RequestInit)
  } catch (error) {
    if (cap.exceeded) return refuse(413, "payload_too_large")
    return badGateway(deps, name, error)
  } finally {
    clearTimeout(timer)
    request.signal.removeEventListener("abort", onAbort)
  }

  return buildResponse(request, upstream, row)
}

/**
 * `${url}/${subPath}${search}`, or `undefined` when the sub-path would leave
 * the target.
 *
 * **The router hands over a decoded splat.** TanStack runs
 * `decodeURIComponent` on it, so `..%2fadmin` arrives here as `../admin` —
 * the WHATWG parser had already resolved a literal `../` (and `%2e%2e/`)
 * before the router saw the path, but an *encoded* slash survives the parser
 * and is decoded by the router, and the string this builds is then parsed
 * and normalized a second time by `fetch`. `https://api.internal/v1/../admin`
 * reaches `https://api.internal/admin`. Nothing in the chain was wrong;
 * three correct components composed into a traversal.
 *
 * So the built string is parsed here first and the result has to sit under
 * `${url}/` — compared on the parser's normalized `href`, because
 * `row.url` may spell the host in upper case or carry a default port and
 * the parser folds both. `row.url` never ends in `/` (`lib/gateway-rules.ts`
 * refuses one), so the prefix is unambiguous. Two more things the parse
 * catches for free: a backslash, which is a slash in a special scheme, and a
 * decoded `?` or `#` that would turn the tail of the path into a query or a
 * fragment ahead of the caller's own.
 *
 * What is forwarded is the **original** string, not the normalized one:
 * `a/./b` and `//odd/path` go through byte for byte, because whatever
 * `fetch` normalizes them to is under the prefix as well, and the upstream
 * is the one entitled to decide what its own odd paths mean. An empty
 * sub-path is the target itself, untouched — there is nothing to climb.
 */
function resolveTarget(
  url: string,
  subPath: string,
  search: string
): string | undefined {
  if (subPath === "") return `${url}${search}`

  const candidate = `${url}/${subPath}`
  let base: URL
  let parsed: URL
  try {
    base = new URL(url)
    parsed = new URL(candidate)
  } catch {
    return undefined
  }
  if (parsed.search !== "" || parsed.hash !== "") return undefined
  const prefix = base.href.endsWith("/") ? base.href : `${base.href}/`
  if (!parsed.href.startsWith(prefix)) return undefined
  return `${candidate}${search}`
}

/**
 * Refuses an upstream that lives at a link-local address, against
 * the address it resolves to *now*.
 *
 * Returns the reason as an `Error` (for the log) or `undefined` to proceed.
 * An address literal is judged directly and never resolved — that is the
 * integration suite's `127.0.0.1`, and the sibling deployment's
 * `postgrest` is a name Docker's embedded DNS answers in well under a
 * millisecond. A name that resolves to *any* link-local address is refused,
 * because a mixed answer is one whose next lookup may pick the other entry.
 *
 * What this does **not** do is pin the address `fetch` then connects to:
 * `fetch` resolves the name again, and a record that changes between the two
 * lookups is a rebinding this check cannot see. Pinning would mean
 * connecting by address and carrying the name in `Host` and SNI ourselves,
 * which is a second HTTP client. Recorded as the accepted residue of the
 * same trade already made about admin-defined targets: the operator who
 * names the upstream is trusted; the network they name it on is not.
 */
async function upstreamAddressProblem(
  deps: GatewayProxyDeps,
  row: GatewayRow
): Promise<Error | undefined> {
  let hostname: string
  try {
    hostname = new URL(row.url).hostname
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  // `URL` keeps the brackets on an IPv6 literal; the rule strips them.
  if (isLinkLocalAddress(hostname)) {
    return new Error("upstream address is link-local")
  }
  if (isAddressLiteral(hostname)) return undefined

  let addresses: string[]
  try {
    addresses = await (deps.resolveImpl ?? defaultResolve)(hostname)
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  if (addresses.some(isLinkLocalAddress)) {
    return new Error("upstream resolves to a link-local address")
  }
  return undefined
}

/** Dotted IPv4, or a bracketed IPv6 literal — what `URL.hostname` yields. */
function isAddressLiteral(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith("[")
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true })
  return records.map((record) => record.address)
}

/**
 * The request body with a byte counter in the pipe.
 *
 * Nothing is buffered: every chunk is passed straight through, and the first
 * chunk that carries the running total past `limit` errors the stream — so
 * the upstream sees a truncated body, never a complete oversize one — and
 * calls `onExceeded`, which aborts the upstream call. The proxy answers 413
 * from the abort. A body that already finished streaming when the upstream
 * answered early is the one case this cannot revoke, and that is fine: the
 * cap bounds what is *forwarded*, and by then nothing more will be.
 */
function cappedBody(
  body: ReadableStream<Uint8Array>,
  limit: number,
  onExceeded: () => void
): ReadableStream<Uint8Array> {
  let seen = 0
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength
        if (seen > limit) {
          onExceeded()
          controller.error(new Error("request body exceeds the cap"))
          return
        }
        controller.enqueue(chunk)
      },
    })
  )
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
 * The forwarded-header contract, the whole of it.
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
  if (key) {
    const exchanged = await exchange(
      deps,
      { kind: "key", secret: key, headers: { [API_KEY_HEADER]: key } },
      row,
      clientIp
    )
    // A key is a credential the caller **chose** to present. Refusing it out
    // loud is the useful answer; silently forwarding anonymously would look
    // like the upstream rejecting them.
    return exchanged ?? { refusal: refuse(401, "invalid_api_key") }
  }

  const session = sessionCredential(request)
  if (session) {
    const exchanged = await exchange(
      deps,
      {
        kind: "session",
        secret: session.token,
        headers: { cookie: session.header },
      },
      row,
      clientIp
    )
    if (exchanged) return exchanged
    // **Falls through on a refusal, unlike the key above**. The
    // browser attached this cookie by itself; the caller did not choose to
    // present it. An expired session turning a working anonymous call into a
    // 401 would be this endpoint inventing a failure out of a cookie nobody
    // sent on purpose.
  }

  // PostgREST and the Data API both have an anonymous role, so anonymous
  // reach is a legitimate configuration — and `requireAuth` is the knob for
  // the upstream where it is not.
  return row.requireAuth ? { refusal: refuse(401, "auth_required") } : {}
}

/** One credential, on its way to being a bearer token. */
interface Credential {
  /** Namespaces the cache key, so a key and a cookie can never collide. */
  kind: "key" | "session"
  /** The secret whose hash keys the caches. Never stored or logged. */
  secret: string
  /** What the mint request carries to Better Auth. */
  headers: Record<string, string>
}

/**
 * Runs one credential through the caches, the limiter and the mint.
 *
 * `undefined` means "this did not produce a token", and **what that is worth
 * is the caller's decision** — the two callers answer it differently, which is
 * the whole reason this returns rather than refusing.
 */
async function exchange(
  deps: GatewayProxyDeps,
  credential: Credential,
  row: GatewayRow,
  clientIp: string | undefined
): Promise<Translation | undefined> {
  const now = deps.now ?? Date.now
  const hash = hashCredential(credential, row)

  const cached = tokenCache.get(hash)
  if (cached && cached.expiresAt > now()) {
    return { authorization: `Bearer ${cached.token}` }
  }
  if (cached) tokenCache.delete(hash)

  const negativeUntil = negativeCache.get(hash)
  if (negativeUntil !== undefined && negativeUntil > now()) return undefined
  if (negativeUntil !== undefined) negativeCache.delete(hash)

  // Before the database, not after: the point of the limiter is that a flood
  // of credentials that resolve to nothing costs nothing to refuse.
  if (!allowMintAttempt(clientIp, now())) {
    return { refusal: refuse(429, "too_many_mint_attempts") }
  }

  const minted = await mint(deps, credential.headers, row, clientIp)
  if (minted.status === 429) {
    // Better Auth's own per-key limit. Passed through rather than translated:
    // the caller is being told to slow down and that is exactly true.
    return { refusal: refuse(429, "rate_limited") }
  }
  if (!minted.token) {
    negativeCache.set(hash, now() + NEGATIVE_CACHE_MS)
    return undefined
  }

  storeToken(deps, hash, minted.token, now())
  return { authorization: `Bearer ${minted.token}` }
}

/**
 * SHA-256 of the credential, never the credential itself, namespaced by kind.
 *
 * Unsalted is right here: both an `idp_` key and a session token are
 * high-entropy random secrets, so there is no dictionary to precompute, and a
 * per-process salt would only stop this map from being useful across a
 * restart, which it is not anyway. The `kind:` prefix is what makes a key and
 * a session token with the same bytes — impossible, but free to rule out —
 * two different cache entries.
 *
 * **A gateway with a `audience` gets entries of its own**: the
 * token it minted names that audience as `aud`, and must not be handed to a
 * gateway that wants another — or the default. The gateway's *name* goes
 * into the key rather than the audience string, so an edit to one gateway's
 * audience cannot hand a second gateway with the same value a token minted
 * for the old one; `/idp/update-gateway` clears the cache as well, so the
 * edited gateway itself re-mints at once. Without a audience the key is
 * byte-for-byte what it was, so every such gateway keeps sharing one entry
 * per credential. `kind@name` cannot collide with a bare `kind`.
 */
function hashCredential(credential: Credential, row: GatewayRow): string {
  const namespace =
    row.audience === null ? credential.kind : `${credential.kind}@${row.name}`
  return createHash("sha256")
    .update(`${namespace}:${credential.secret}`)
    .digest("base64url")
}

/**
 * Better Auth's session cookie, whatever prefix this deployment uses.
 *
 * `cookiePrefix` is `idp` or `__Secure-idp` depending on whether the issuer is
 * https (`auth/instance.ts`), so the name is matched by its suffix rather than
 * spelled out — and the suffix does not match `…session_data`, the cookie
 * cache, which is not a credential.
 */
const SESSION_COOKIE_SUFFIX = "session_token"

/**
 * The session cookie, if this request may use one.
 *
 * **The Fetch-Metadata check is the load-bearing half.** `/gateway/*` is on
 * the issuer's origin, so the browser attaches the session cookie by itself —
 * which is exactly the ambient authority CSRF exploits. The cookies are
 * `SameSite=Lax` and host-only, so a cross-site *subresource* never carries
 * one; what Lax still permits is a **top-level GET navigation**, and a link to
 * `…/gateway/data/rpc/something` is precisely that. Without this check, an
 * attacker's link would have the IdP mint a JWT for whoever clicked it and
 * forward the call as them.
 *
 * `Sec-Fetch-Site` is what settles it, because the browser sets it and a page
 * cannot. Absent means the caller is not a browser — a script that attached
 * the cookie itself already holds it, and CSRF is not a thing that can be done
 * to it.
 *
 * Returning `undefined` here means "no usable session", which lands in the
 * anonymous branch rather than in a refusal.
 */
function sessionCredential(
  request: Request
): { token: string; header: string } | undefined {
  const header = request.headers.get("cookie")
  if (!header) return undefined

  const site = request.headers.get("sec-fetch-site")
  if (site !== null && site !== "same-origin" && site !== "none") {
    return undefined
  }

  for (const pair of header.split(";")) {
    const index = pair.indexOf("=")
    if (index === -1) continue
    const name = pair.slice(0, index).trim()
    const value = pair.slice(index + 1).trim()
    if (value === "" || !name.endsWith(SESSION_COOKIE_SUFFIX)) continue
    return { token: value, header }
  }
  return undefined
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
  credential: Record<string, string>,
  row: GatewayRow,
  clientIp: string | undefined
): Promise<MintResult> {
  // Runs INSIDE the request scope, so under `server.dynamicIssuer` the minted
  // JWT's `iss` is the arriving host — harmless against PostgREST, which
  // validates the signature and never `iss`. Worth knowing: the ten-minute
  // mint cache below replays that token across hosts, so a key first used on
  // host A briefly presents `iss: A` on host B.
  const paths = createBasePaths(deps.config.base)
  const headers = new Headers(credential)
  // The address the auth instance's own resolver trusts, so Better Auth
  // buckets this mint per caller instead of collapsing every one of them into
  // the shared `no-trusted-ip|/token` bucket. that resolver reads
  // the private header and nothing else, whatever `trustProxy` is
  // (`auth/instance.ts`): the address is already the resolved one.
  if (clientIp) headers.set(SOCKET_ADDRESS_HEADER, clientIp)

  // `/token` takes no parameters, and `definePayload` sees only the session
  // — so a gateway's `audience` reaches the payload through a scope around
  // the call (`auth/requested-audience.ts`). Without one the
  // plugin signs `jwt.audience`, which is every other mint.
  const call = () =>
    deps.auth.handler(new Request(`${paths.authBaseUrl}/token`, { headers }))
  const response =
    row.audience === null
      ? await call()
      : await withRequestedAudience(row.audience, call)
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
 *. The minus-sixty is so a cached token is never handed out in
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
 * Not from `server.baseUrl`: The spec governs the URLs the IdP *emits* — issuer,
 * discovery documents, e-mail links — and this is the opposite direction. An
 * upstream that builds its own links needs to know the address the caller
 * actually used, and inventing the configured one would break exactly the
 * sub-path and reverse-proxy deployments the base-URL rule exists to make work.
 *
 * **`server.trustProxy` is the only input.** Whether the edge's account of
 * the caller is credible is a fact about what sits in front of this process,
 * not about where the request is going, so it cannot vary per target.
 * Trusting, `clientIpFrom` has already resolved the browser's own address out
 * of the inbound chain, and the host and scheme it used are the edge's;
 * otherwise those headers are caller-controlled and this hop's own view is the
 * only honest answer.
 *
 * The inbound headers are **never relayed**, either way: they are stripped on
 * the way in and these three are written from the resolved values. That is
 * what makes the address the rate limiter buckets on and the address the
 * upstream is told the same address by construction rather than by
 * coincidence.
 */
function applyForwardedHeaders(
  deps: GatewayProxyDeps,
  request: Request,
  outbound: Headers,
  clientIp: string | undefined
): void {
  const set = (name: string, value: string | undefined): void => {
    if (value === undefined) return
    outbound.set(name, value)
  }

  set("X-Forwarded-For", clientIp)

  const trustProxy = deps.config.file.server.trustProxy
  const incoming = new URL(request.url)
  const forwardedHost =
    trustProxy !== false ? request.headers.get("x-forwarded-host") : null
  const forwardedProto =
    trustProxy !== false ? request.headers.get("x-forwarded-proto") : null

  set(
    "X-Forwarded-Host",
    forwardedHost ?? request.headers.get("host") ?? incoming.host
  )
  set("X-Forwarded-Proto", forwardedProto ?? incoming.protocol.replace(":", ""))
}

function badGateway(
  deps: GatewayProxyDeps,
  name: string,
  error: unknown,
  reason: "unreachable" | "link_local" = "unreachable"
): Response {
  // The name and the cause, never the URL: a target can carry a host an
  // operator would rather not have in a log aggregator. A refused
  // address gets its own line, because "did not answer" would
  // send an operator to check the upstream's health rather than its address
  // — and the caller gets the same 502 either way, so the log is the only
  // place the difference is visible.
  deps.logger?.warn(
    reason === "link_local"
      ? "gateway upstream refused: link-local address"
      : "gateway upstream did not answer",
    {
      gateway: name,
      error: error instanceof Error ? error.message : String(error),
    }
  )
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
    // Same-origin with the issuer: nothing an upstream says about *this*
    // origin crosses (the list says why for each).
    if (isDeniedResponseHeader(lower)) continue
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
