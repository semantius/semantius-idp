/**
 * The gateway proxy.
 *
 * The bulk of the proxy's coverage lives here rather than in the integration
 * suite, because almost everything it does is a pure decision about headers,
 * URLs and a cache: which headers cross, which do not, what is answered when
 * a key is refused, and when a cached token stops being used. All of that is
 * observable from a captured `fetchImpl` and a fake `auth.handler`, with no
 * database and no upstream.
 *
 * What is deliberately *not* here is the part a stub cannot prove: that Bun's
 * own `fetch` honors `duplex: "half"` and `decompress: false`. The
 * integration suite streams a real body through a real `Bun.serve` for that.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"

import { deriveConfig } from "@/server/config/derive"
import type { IdpConfig } from "@/server/config/derive"
import { configFileSchema } from "@/server/config/schema/config-schema"
import { BUILT_IN_ROLES } from "@/server/config/schema/roles-schema"
import type { DbHandle } from "@/server/db/client"
import { SOCKET_ADDRESS_HEADER } from "@/server/http/client-ip"
import {
  checkGatewayAudience,
  checkGatewayUrl,
  validateGatewayForm,
} from "@/lib/gateway-rules"
import { requestedAudience } from "@/server/auth/requested-audience"
import {
  MINT_MISS_MAX,
  NEGATIVE_CACHE_MS,
  UPSTREAM_TTFB_TIMEOUT_MS,
  proxyGatewayRequest,
  resetGatewayTokenCache,
} from "@/server/gateways/proxy"
import { resetGatewayRegistry } from "@/server/gateways/registry"
import { Route as GatewayRoot } from "@/routes/gateway/$name"
import { Route as GatewaySplat } from "@/routes/gateway/$name.$"
import { baseConfig } from "@/tests/fixtures/config-files"

const ISSUER = "http://localhost:3000"

interface Row {
  id: string
  name: string
  url: string
  requireAuth: boolean | null
  source: string
  enabled: boolean | null
  /** The audience the minted JWT names when set. */
  audience?: string | null
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: "g1",
    name: "data",
    url: "https://upstream.example",
    requireAuth: false,
    source: "manual",
    enabled: true,
    ...overrides,
  }
}

/**
 * The narrowest thing `registry.ts` actually asks of a handle: one
 * `select().from().orderBy()`. Building a fake here rather than mocking the
 * module keeps the registry's own caching in the test's path, which is where
 * three of the assertions below live.
 */
function fakeDb(rows: Row[]): DbHandle {
  return {
    db: {
      select: () => ({
        from: () => ({ orderBy: () => Promise.resolve(rows) }),
      }),
    },
    schema: { gateway: {} },
    sql: {},
    schemaName: "idp",
    close: async () => undefined,
  } as unknown as DbHandle
}

function config(overrides: Record<string, unknown> = {}): IdpConfig {
  return deriveConfig(
    configFileSchema.parse({ ...baseConfig(), ...overrides }),
    [],
    BUILT_IN_ROLES
  )
}

interface Harness {
  fetchImpl: ReturnType<typeof vi.fn>
  handler: ReturnType<typeof vi.fn>
  resolve: ReturnType<typeof vi.fn>
  call: (
    request: Request,
    options?: { name?: string; subPath?: string }
  ) => Promise<Response>
  /** The init the proxy handed to `fetchImpl`, after a call. */
  init: () => RequestInit & { decompress?: boolean; duplex?: string }
  url: () => string
  /** Outbound headers, after a call. */
  sent: () => Headers
}

function harness(
  options: {
    rows?: Row[]
    config?: IdpConfig
    now?: () => number
    upstream?: Response | ((init: RequestInit) => Promise<Response>)
    token?: Response | (() => Promise<Response>)
    /**
     * What the upstream's hostname resolves to. A private
     * address by default, so no test in this file ever touches real DNS for
     * `upstream.example` — and so the accepted private-range reach the design
     * records stays the ordinary case.
     */
    resolve?: (hostname: string) => Promise<string[]>
  } = {}
): Harness {
  const rows = options.rows ?? [row()]
  const upstream =
    options.upstream ?? new Response("hello", { status: 200 })
  // Typed parameters, not `vi.fn(async () => …)`: without them the mock's
  // `calls` is inferred as `[]` and every assertion about what the proxy sent
  // fails to compile rather than failing usefully.
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) =>
    typeof upstream === "function" ? upstream(init) : upstream.clone()
  )
  const resolve = vi.fn(
    options.resolve ?? (async (_hostname: string) => ["10.0.0.5"])
  )
  const token = options.token ?? new Response("{}", { status: 401 })
  const handler = vi.fn(async (_request: Request) =>
    typeof token === "function" ? token() : token.clone()
  )

  const deps = {
    config: options.config ?? config(),
    auth: { handler } as never,
    database: fakeDb(rows),
    fetchImpl: fetchImpl as never,
    resolveImpl: resolve as never,
    ...(options.now ? { now: options.now } : {}),
  }

  return {
    fetchImpl,
    handler,
    resolve,
    call: (request, { name = "data", subPath = "" } = {}) =>
      proxyGatewayRequest(deps, request, name, subPath),
    init: () => fetchImpl.mock.calls[0]![1],
    url: () => fetchImpl.mock.calls[0]![0],
    sent: () => new Headers(fetchImpl.mock.calls[0]![1].headers),
  }
}

function get(path = "/gateway/data", init: RequestInit = {}): Request {
  return new Request(`${ISSUER}${path}`, init)
}

function tokenResponse(token = "minted.jwt.value"): Response {
  return new Response(JSON.stringify({ token }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

beforeEach(() => {
  resetGatewayRegistry()
  resetGatewayTokenCache()
})

describe("resolving the gateway", () => {
  it("answers 404 for an unknown name, without calling the upstream", async () => {
    const h = harness()
    const response = await h.call(get(), { name: "nope" })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: "unknown_gateway" })
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(h.fetchImpl).not.toHaveBeenCalled()
  })

  it("answers 404 — not 403 — for a disabled one", async () => {
    // The same answer as "no such gateway" on purpose: a different status
    // would confirm to an anonymous caller that the name exists.
    const h = harness({ rows: [row({ enabled: false })] })
    const response = await h.call(get())

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: "unknown_gateway" })
    expect(h.fetchImpl).not.toHaveBeenCalled()
  })

  it("refuses an upgrade with 501", async () => {
    const h = harness()
    const response = await h.call(
      get("/gateway/data", { headers: { upgrade: "websocket" } })
    )

    expect(response.status).toBe(501)
    expect(await response.json()).toEqual({ error: "upgrade_not_supported" })
    expect(h.fetchImpl).not.toHaveBeenCalled()
  })

  it("also refuses one announced only through Connection", async () => {
    const h = harness()
    const response = await h.call(
      get("/gateway/data", { headers: { connection: "keep-alive, Upgrade" } })
    )
    expect(response.status).toBe(501)
  })
})

describe("auth translation", () => {
  it("leaves an existing Authorization alone, even beside an API key", async () => {
    const h = harness({ token: tokenResponse() })
    await h.call(
      get("/gateway/data", {
        headers: { authorization: "Bearer caller", "x-api-key": "idp_key" },
      })
    )

    expect(h.handler, "no mint when the caller brought a token").not.toHaveBeenCalled()
    expect(h.sent().get("authorization")).toBe("Bearer caller")
    expect(h.sent().has("x-api-key")).toBe(false)
  })

  it("forwards anonymously when neither header is present", async () => {
    const h = harness()
    const response = await h.call(get())

    expect(response.status).toBe(200)
    expect(h.sent().has("authorization")).toBe(false)
  })

  it("refuses anonymously on a requireAuth gateway", async () => {
    const h = harness({ rows: [row({ requireAuth: true })] })
    const response = await h.call(get())

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: "auth_required" })
    expect(h.fetchImpl).not.toHaveBeenCalled()
  })

  it("exchanges an API key for a bearer token and drops the key", async () => {
    const h = harness({ token: tokenResponse("jwt-1") })
    const response = await h.call(
      get("/gateway/data", { headers: { "x-api-key": "idp_key" } })
    )

    expect(response.status).toBe(200)
    expect(h.sent().get("authorization")).toBe("Bearer jwt-1")
    expect(h.sent().has("x-api-key"), "never forwarded upstream").toBe(false)

    // The exchange goes to Better Auth's own endpoint — the gate, the
    // last-used accounting and `azp` live only there.
    const minted = h.handler.mock.calls[0]![0] as Request
    expect(minted.url).toBe(`${ISSUER}/api/auth/token`)
    expect(minted.headers.get("x-api-key")).toBe("idp_key")
  })

  it("puts the caller's address on the mint request", async () => {
    // Without it every mint in the deployment shares Better Auth's single
    // `no-trusted-ip` bucket, and one caller's spray starves the rest.
    const h = harness({ token: tokenResponse() })
    await h.call(
      get("/gateway/data", {
        headers: {
          "x-api-key": "idp_key",
          [SOCKET_ADDRESS_HEADER]: "203.0.113.7",
        },
      })
    )

    const minted = h.handler.mock.calls[0]![0] as Request
    // `trustProxy: false`, so the resolver reads the private socket header.
    expect(minted.headers.get(SOCKET_ADDRESS_HEADER)).toBe("203.0.113.7")
  })

  it("stamps the resolved address into the private header when a proxy is trusted", async () => {
    // Not `x-forwarded-for`: the auth instance reads only the
    // private header, for every `trustProxy` value, so a mint that wrote the
    // forwarded header instead would land in the shared bucket again.
    const h = harness({
      config: config({ server: { baseUrl: ISSUER, trustProxy: true } }),
      token: tokenResponse(),
    })
    await h.call(
      get("/gateway/data", {
        headers: { "x-api-key": "idp_key", "x-forwarded-for": "198.51.100.4" },
      })
    )

    const minted = h.handler.mock.calls[0]![0] as Request
    expect(minted.headers.get(SOCKET_ADDRESS_HEADER)).toBe("198.51.100.4")
  })

  it("exchanges a session cookie for a bearer token and drops the cookie", async () => {
    const h = harness({ token: tokenResponse("jwt-session") })
    const response = await h.call(
      get("/gateway/data", {
        headers: {
          cookie: "idp.session_token=abc.def; idp.sidebar=1",
          "sec-fetch-site": "same-origin",
        },
      })
    )

    expect(response.status).toBe(200)
    expect(h.sent().get("authorization")).toBe("Bearer jwt-session")
    // Read as a credential, never passed on: the upstream must not receive
    // this IdP's session cookie.
    expect(h.sent().has("cookie")).toBe(false)

    // The mint carries the cookie so Better Auth validates the session — the
    // same endpoint the key path uses, which is what makes `azp` differ.
    const minted = h.handler.mock.calls[0]![0]
    expect(minted.headers.get("cookie")).toContain("idp.session_token=abc.def")
    expect(minted.headers.has("x-api-key")).toBe(false)
  })

  it("finds the session cookie under either cookie prefix", async () => {
    // `cookiePrefix` is `__Secure-idp` when the issuer is https, so the name
    // is matched by suffix rather than spelled out.
    const h = harness({ token: tokenResponse("jwt-secure") })
    await h.call(
      get("/gateway/data", {
        headers: { cookie: "__Secure-idp.session_token=xyz" },
      })
    )
    expect(h.sent().get("authorization")).toBe("Bearer jwt-secure")
  })

  it("ignores the session-data cookie, which is not a credential", async () => {
    const h = harness({ token: tokenResponse() })
    const response = await h.call(
      get("/gateway/data", { headers: { cookie: "idp.session_data=cached" } })
    )
    expect(h.handler, "nothing to exchange").not.toHaveBeenCalled()
    expect(response.status).toBe(200)
    expect(h.sent().has("authorization")).toBe(false)
  })

  it("ignores a session cookie on a cross-site request", async () => {
    // The CSRF guard. `SameSite=Lax` still sends the cookie on a
    // top-level GET navigation, so a link to /gateway/... from anywhere would
    // otherwise have the IdP mint a JWT for whoever clicked it.
    for (const site of ["cross-site", "same-site"]) {
      resetGatewayRegistry()
      resetGatewayTokenCache()
      const h = harness({ token: tokenResponse() })
      const response = await h.call(
        get("/gateway/data", {
          headers: {
            cookie: "idp.session_token=abc.def",
            "sec-fetch-site": site,
          },
        })
      )
      expect(h.handler, site).not.toHaveBeenCalled()
      // Anonymous, not refused: the browser attached the cookie by itself.
      expect(response.status, site).toBe(200)
      expect(h.sent().has("authorization")).toBe(false)
    }
  })

  it("accepts a session cookie on a same-origin or top-level request", async () => {
    for (const site of ["same-origin", "none"]) {
      resetGatewayRegistry()
      resetGatewayTokenCache()
      const h = harness({ token: tokenResponse("jwt-ok") })
      await h.call(
        get("/gateway/data", {
          headers: {
            cookie: "idp.session_token=abc.def",
            "sec-fetch-site": site,
          },
        })
      )
      expect(h.sent().get("authorization"), site).toBe("Bearer jwt-ok")
    }
  })

  it("prefers an API key over a session cookie", async () => {
    const h = harness({ token: tokenResponse("jwt-key") })
    await h.call(
      get("/gateway/data", {
        headers: {
          "x-api-key": "idp_key",
          cookie: "idp.session_token=abc.def",
        },
      })
    )
    const minted = h.handler.mock.calls[0]![0]
    expect(minted.headers.get("x-api-key")).toBe("idp_key")
    expect(minted.headers.has("cookie")).toBe(false)
  })

  it("falls through to anonymous when the session is refused", async () => {
    // Unlike a key: the caller did not choose to present this, so a stale
    // cookie must not turn a working anonymous call into a 401.
    const h = harness()
    const response = await h.call(
      get("/gateway/data", { headers: { cookie: "idp.session_token=stale" } })
    )
    expect(response.status).toBe(200)
    expect(h.sent().has("authorization")).toBe(false)
  })

  it("refuses a refused session on a requireAuth gateway", async () => {
    const h = harness({ rows: [row({ requireAuth: true })] })
    const response = await h.call(
      get("/gateway/data", { headers: { cookie: "idp.session_token=stale" } })
    )
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: "auth_required" })
  })

  it("caches a session exchange under its own key", async () => {
    // The `kind:` prefix in the cache key: a key and a cookie carrying the
    // same bytes must not share an entry.
    const h = harness({ token: tokenResponse("jwt-1") })
    const request = () =>
      h.call(
        get("/gateway/data", { headers: { cookie: "idp.session_token=same" } })
      )
    await request()
    await request()
    expect(h.handler).toHaveBeenCalledTimes(1)

    await h.call(
      get("/gateway/data", { headers: { "x-api-key": "same" } })
    )
    expect(h.handler, "a key with the same bytes is a separate entry").toHaveBeenCalledTimes(2)
  })

  it("answers 401 for a refused key and remembers it for ten seconds", async () => {
    let clock = 1_000_000
    const h = harness({ now: () => clock })

    const first = await h.call(
      get("/gateway/data", { headers: { "x-api-key": "bad" } })
    )
    expect(first.status).toBe(401)
    expect(await first.json()).toEqual({ error: "invalid_api_key" })
    expect(h.handler).toHaveBeenCalledTimes(1)

    // The negative cache: the same wrong key does not reach the database
    // again straight away.
    await h.call(get("/gateway/data", { headers: { "x-api-key": "bad" } }))
    expect(h.handler).toHaveBeenCalledTimes(1)

    // …and it is short, so a key created a moment ago starts working.
    clock += NEGATIVE_CACHE_MS + 1
    await h.call(get("/gateway/data", { headers: { "x-api-key": "bad" } }))
    expect(h.handler).toHaveBeenCalledTimes(2)
  })

  it("passes a 429 from the mint straight through", async () => {
    const h = harness({ token: new Response("{}", { status: 429 }) })
    const response = await h.call(
      get("/gateway/data", { headers: { "x-api-key": "idp_key" } })
    )

    expect(response.status).toBe(429)
    expect(await response.json()).toEqual({ error: "rate_limited" })
  })

  it("refuses a flood of misses from one address before touching the database", async () => {
    const h = harness()
    const headers = {
      "x-api-key": "bad",
      [SOCKET_ADDRESS_HEADER]: "203.0.113.9",
    }
    let limited: Response | undefined

    // Each attempt uses a distinct key so the negative cache never answers —
    // this asserts the limiter, not the cache.
    for (let attempt = 0; attempt <= MINT_MISS_MAX; attempt += 1) {
      limited = await h.call(
        get("/gateway/data", {
          headers: { ...headers, "x-api-key": `bad-${attempt}` },
        })
      )
    }

    expect(limited?.status).toBe(429)
    expect(await limited?.json()).toEqual({ error: "too_many_mint_attempts" })
    expect(h.handler).toHaveBeenCalledTimes(MINT_MISS_MAX)
  })
})

describe("the token cache", () => {
  it("reuses a minted token and stops at the TTL", async () => {
    let clock = 1_000_000
    const h = harness({ token: tokenResponse("jwt-1"), now: () => clock })
    const request = () =>
      h.call(get("/gateway/data", { headers: { "x-api-key": "idp_key" } }))

    await request()
    await request()
    expect(h.handler, "the second call is a cache hit").toHaveBeenCalledTimes(1)

    // `jwt.sessionToken.ttl` defaults to 3600 s, so the cap is the 600 s one.
    clock += 600_000 + 1
    await request()
    expect(h.handler).toHaveBeenCalledTimes(2)
  })

  it("is emptied by resetGatewayTokenCache, which is the spec's punch-through", async () => {
    const h = harness({ token: tokenResponse("jwt-1") })
    const request = () =>
      h.call(get("/gateway/data", { headers: { "x-api-key": "idp_key" } }))

    await request()
    expect(h.handler).toHaveBeenCalledTimes(1)

    // What `admin/guard.ts` calls after a ban or a key revocation: the next
    // call re-mints, so the spec gate runs again immediately.
    resetGatewayTokenCache()
    await request()
    expect(h.handler).toHaveBeenCalledTimes(2)
  })

  it("does not cache anything when the token would already be near expiry", async () => {
    // A 60 s session token leaves nothing to cache once the minute of headroom
    // is taken off, and caching zero seconds would be a map that only grows.
    const h = harness({
      config: config({
        server: { baseUrl: ISSUER },
        jwt: { audience: ISSUER, sessionToken: { ttl: 60 } },
      }),
      token: tokenResponse("jwt-1"),
    })
    const request = () =>
      h.call(get("/gateway/data", { headers: { "x-api-key": "idp_key" } }))

    await request()
    await request()
    expect(h.handler).toHaveBeenCalledTimes(2)
  })
})

describe("outbound headers", () => {
  it("strips hop-by-hop, cookies and every forwarding header the caller sent", async () => {
    const h = harness()
    await h.call(
      get("/gateway/data", {
        headers: {
          cookie: "idp.session_token=secret",
          connection: "keep-alive, X-Private",
          "keep-alive": "timeout=5",
          te: "trailers",
          "x-private": "leaked",
          forwarded: "for=1.2.3.4",
          "x-real-ip": "1.2.3.4",
          "x-forwarded-for": "1.2.3.4",
          "x-forwarded-host": "evil.example",
          "x-forwarded-proto": "https",
          [SOCKET_ADDRESS_HEADER]: "203.0.113.7",
          accept: "application/json",
        },
      })
    )

    const sent = h.sent()
    for (const name of [
      "cookie",
      "connection",
      "keep-alive",
      "te",
      // Named by `Connection`, so it is hop-by-hop for this request.
      "x-private",
      "forwarded",
      "x-real-ip",
      SOCKET_ADDRESS_HEADER,
    ]) {
      expect(sent.has(name), `${name} must not be forwarded`).toBe(false)
    }
    expect(sent.get("accept")).toBe("application/json")
    // `trustProxy: false`, so the caller's own X-Forwarded-* are discarded and
    // this hop's view replaces them.
    expect(sent.get("x-forwarded-for")).toBe("203.0.113.7")
    expect(sent.get("x-forwarded-host")).toBe("localhost:3000")
    expect(sent.get("x-forwarded-proto")).toBe("http")
  })

  it("resolves the trusted inbound headers rather than relaying them", async () => {
    const h = harness({
      config: config({ server: { baseUrl: ISSUER, trustProxy: true } }),
    })
    await h.call(
      get("/gateway/data", {
        headers: {
          "x-forwarded-for": "198.51.100.4",
          "x-forwarded-host": "apps.example.com",
          "x-forwarded-proto": "https",
          forwarded: "for=198.51.100.4;proto=https",
          "x-real-ip": "198.51.100.4",
        },
      })
    )

    const sent = h.sent()
    // The address the mint limiter bucketed on is the address the upstream is
    // told, because both read the one value `clientIpFrom` resolved.
    expect(sent.get("x-forwarded-for")).toBe("198.51.100.4")
    expect(sent.get("x-forwarded-host")).toBe("apps.example.com")
    expect(sent.get("x-forwarded-proto")).toBe("https")
    // Trusting the edge decides what those values *are*. It never lets the
    // caller's own copies through unread — which is what would let the
    // outgoing account of the caller differ from the one that was throttled.
    expect(sent.has("forwarded")).toBe(false)
    expect(sent.has("x-real-ip")).toBe(false)
  })

  it("passes accept-encoding through and never recodes the bytes", async () => {
    const h = harness()
    await h.call(
      get("/gateway/data", { headers: { "accept-encoding": "br, gzip" } })
    )

    expect(h.sent().get("accept-encoding")).toBe("br, gzip")
    expect(h.init().decompress).toBe(false)
    expect(h.init().duplex).toBe("half")
    expect(h.init().redirect).toBe("manual")
  })
})

describe("the upstream call", () => {
  it("keeps the method, the sub-path and the query", async () => {
    const h = harness()
    await h.call(
      new Request(`${ISSUER}/gateway/data/rest/v1/items?select=id&limit=2`, {
        method: "PATCH",
        body: "{}",
      }),
      { subPath: "rest/v1/items" }
    )

    expect(h.url()).toBe(
      "https://upstream.example/rest/v1/items?select=id&limit=2"
    )
    expect(h.init().method).toBe("PATCH")
  })

  it("addresses the upstream root when there is no sub-path", async () => {
    const h = harness()
    await h.call(get())
    expect(h.url()).toBe("https://upstream.example")
  })

  it("sends no body for GET or HEAD", async () => {
    const h = harness()
    await h.call(get())
    expect(h.init().body).toBeUndefined()
  })

  it("answers 502 when the upstream cannot be reached", async () => {
    const h = harness({
      upstream: () => Promise.reject(new Error("ECONNREFUSED")),
    })
    const response = await h.call(get())

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: "bad_gateway" })
  })

  it("gives up on an upstream that never sends headers", async () => {
    vi.useFakeTimers()
    try {
      const h = harness({
        upstream: () =>
          new Promise<Response>((_resolve, reject) => {
            // Never resolves on its own; only the abort ends it, which is what
            // the TTFB timeout has to produce.
            const init = h.init() as { signal?: AbortSignal }
            init.signal?.addEventListener("abort", () => {
              reject(new Error("aborted"))
            })
          }),
      })
      const pending = h.call(get())
      await vi.advanceTimersByTimeAsync(UPSTREAM_TTFB_TIMEOUT_MS + 1)
      const response = await pending
      expect(response.status).toBe(502)
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not abort a response whose headers already arrived", async () => {
    vi.useFakeTimers()
    try {
      const h = harness({ upstream: new Response("ok", { status: 200 }) })
      const response = await h.call(get())
      const signal = (h.init() as { signal?: AbortSignal }).signal
      // The timer is cleared once `fetch` resolves, so a long-lived stream is
      // not cut off mid-flight (SSE).
      await vi.advanceTimersByTimeAsync(UPSTREAM_TTFB_TIMEOUT_MS * 3)
      expect(signal?.aborted).toBe(false)
      expect(response.status).toBe(200)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("the response", () => {
  it("strips Set-Cookie and forces the sandbox CSP", async () => {
    const h = harness({
      upstream: new Response("<b>hi</b>", {
        status: 200,
        headers: {
          "content-type": "text/html",
          "set-cookie": "upstream=1; Path=/",
          "content-security-policy": "default-src *",
        },
      }),
    })
    const response = await h.call(get())

    expect(response.headers.getSetCookie()).toEqual([])
    expect(response.headers.get("content-security-policy")).toBe(
      "sandbox; default-src 'none'"
    )
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  it("forwards content-encoding and content-length verbatim", async () => {
    const h = harness({
      upstream: new Response("x", {
        status: 200,
        headers: { "content-encoding": "gzip", "content-length": "1" },
      }),
    })
    const response = await h.call(get())

    expect(response.headers.get("content-encoding")).toBe("gzip")
    expect(response.headers.get("content-length")).toBe("1")
  })

  it("keeps a redirect that stays on the upstream, in both spellings", async () => {
    for (const location of ["/next", "https://upstream.example/next"]) {
      resetGatewayRegistry()
      const h = harness({
        upstream: new Response(null, { status: 302, headers: { location } }),
      })
      const response = await h.call(get())
      expect(response.status).toBe(302)
      expect(response.headers.get("location")).toBe(location)
    }
  })

  it("strips a redirect that leaves it — including the protocol-relative form", async () => {
    for (const location of ["https://evil.example/x", "//evil.example/x"]) {
      resetGatewayRegistry()
      const h = harness({
        upstream: new Response(null, { status: 302, headers: { location } }),
      })
      const response = await h.call(get())
      // The status stays, so the caller still sees that a redirect happened —
      // it just has nowhere on this issuer's hostname to send them.
      expect(response.status).toBe(302)
      expect(response.headers.get("location")).toBeNull()
    }
  })

  it("strips every header that states a policy for the issuer's origin", async () => {
    // Each of these is honored by a browser *per origin* — and `/gateway/*`
    // is the issuer's origin. PostgREST sends none of them.
    const stripped: Record<string, string> = {
      "access-control-allow-origin": "*",
      "access-control-allow-credentials": "true",
      "access-control-expose-headers": "x-secret",
      "strict-transport-security": "max-age=0",
      "x-frame-options": "ALLOWALL",
      "permissions-policy": "camera=*",
      "feature-policy": "camera *",
      "clear-site-data": '"*"',
      refresh: "0; url=https://evil.example/",
      "report-to": '{"group":"x","endpoints":[{"url":"https://evil.example/r"}]}',
      "reporting-endpoints": 'x="https://evil.example/r"',
      nel: '{"report_to":"x","max_age":86400}',
      "alt-svc": 'h2="evil.example:443"',
      "public-key-pins": 'pin-sha256="x"; max-age=1',
      "set-cookie2": "a=b",
    }
    const h = harness({
      upstream: new Response("{}", { status: 200, headers: stripped }),
    })
    const response = await h.call(get())
    for (const name of Object.keys(stripped)) {
      expect(response.headers.has(name), `${name} must be stripped`).toBe(false)
    }
    // The IdP's own X-Frame-Options and HSTS are added later by
    // `withSecurityHeaders`, whose `setUnlessPresent` an upstream value would
    // otherwise have pre-empted.
  })

  it("keeps the headers a PostgREST client reads", async () => {
    // the spec is a deny-list, not an allow-list, for exactly these: the
    // sibling deployment's Scalar page and its key-holding scripts read
    // every one of them, and `Link` is how a REST upstream paginates.
    const kept: Record<string, string> = {
      "content-range": "0-1/2",
      "content-location": "/items?select=id",
      "preference-applied": "return=representation",
      "content-profile": "public",
      "proxy-status": "postgrest",
      "www-authenticate": 'Bearer realm="api"',
      link: '</items?page=2>; rel="next"',
      "x-content-type-options": "nosniff",
    }
    const h = harness({
      upstream: new Response("[]", { status: 206, headers: kept }),
    })
    const response = await h.call(get())
    for (const [name, value] of Object.entries(kept)) {
      expect(response.headers.get(name), name).toBe(value)
    }
  })

  it("answers a HEAD with no body", async () => {
    const h = harness({ upstream: new Response("hello", { status: 200 }) })
    const response = await h.call(
      new Request(`${ISSUER}/gateway/data`, { method: "HEAD" })
    )
    expect(response.body).toBeNull()
  })
})

describe("the sub-path", () => {
  /**
   * What the router hands over. TanStack decodes the splat once
   * (`decodeURIComponent` in router-core's `new-process-route-tree.ts`), so
   * `..%2fadmin`, `%2e%2e%2fadmin` and `.%2e%2fadmin` all arrive here as the
   * plain `../admin`; a literal `../` or `%2e%2e/` never arrives at all,
   * because the WHATWG URL parser resolves dot segments before the router
   * sees the path. What the parser leaves alone — an encoded slash — the
   * router then decodes, which is the vector: `${url}/${subPath}` handed to
   * `fetch` is normalized *again*, and `https://api.internal/v1/../admin`
   * reaches `https://api.internal/admin`.
   */
  const SCOPED = row({ url: "https://api.internal/v1" })

  it.each([
    ["../admin", "what the router hands over for ..%2fadmin"],
    ["..", "a bare parent reference"],
    ["../", "a bare parent reference with a slash"],
    ["items/../../admin", "a climb that starts below the prefix"],
    ["%2e%2e/admin", "an encoded dot segment the parser treats as .."],
    [".%2e/admin", "the half-encoded spelling"],
    ["%2e./admin", "the other half-encoded spelling"],
    ["..\\admin", "a backslash, which is a slash in a special scheme"],
  ])("refuses %s (%s) with 400 and never calls the upstream", async (subPath) => {
    const h = harness({ rows: [SCOPED] })
    const response = await h.call(get("/gateway/data/x"), { subPath })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "invalid_path" })
    expect(h.fetchImpl).not.toHaveBeenCalled()
  })

  it("refuses a sub-path that would smuggle a query or a fragment", async () => {
    // `a%3Fb` arrives as `a?b` (the router decoded it), and appended to the
    // target it would become a query string ahead of the caller's own.
    for (const subPath of ["a?b", "a#b", "items?select=*"]) {
      resetGatewayRegistry()
      const h = harness({ rows: [SCOPED] })
      const response = await h.call(get("/gateway/data/x"), { subPath })
      expect(response.status, subPath).toBe(400)
      expect(h.fetchImpl, subPath).not.toHaveBeenCalled()
    }
  })

  it("forwards a plain sub-path under a path-scoped target verbatim", async () => {
    const h = harness({ rows: [SCOPED] })
    await h.call(get("/gateway/data/items?select=id"), { subPath: "items" })
    expect(h.url()).toBe("https://api.internal/v1/items?select=id")
  })

  it("forwards what is merely odd, byte for byte", async () => {
    // None of these leave `${url}/`: a double-encoded traversal is one
    // literal segment after the router's single decode, `./` resolves in
    // place, and `//` after the origin is a path — the target is built by
    // concatenation, never by resolving the sub-path as a reference.
    for (const subPath of [
      "%2e%2e%2fadmin",
      "a/./b",
      "items/",
      "//odd/path",
      "a%25b",
    ]) {
      resetGatewayRegistry()
      const h = harness({ rows: [SCOPED] })
      const response = await h.call(get("/gateway/data/x"), { subPath })
      expect(response.status, subPath).toBe(200)
      expect(h.url(), subPath).toBe(`https://api.internal/v1/${subPath}`)
    }
  })

  it("lets a climb that cannot leave a bare-origin target through", async () => {
    // `https://upstream.example/../admin` normalizes to
    // `https://upstream.example/admin`: a root has nothing above it, so the
    // result is still under `${url}/` and the rule — refuse what *leaves*
    // the target, nothing else — has no reason to fire. The upstream never
    // sees the `..`; `fetch` resolves it before the bytes go out.
    const h = harness()
    const response = await h.call(get("/gateway/data/x"), {
      subPath: "../admin",
    })
    expect(response.status).toBe(200)
    expect(h.url()).toBe("https://upstream.example/../admin")
  })
})

describe("the upstream address", () => {
  it("refuses an upstream that resolves to the IPv4 link-local range with 502", async () => {
    // The cloud metadata address. The design accepts private-address reach — the
    // sibling deployment's upstream *is* a compose-network name — and this
    // is the one range that accepted reach must not extend to.
    const h = harness({ resolve: async () => ["169.254.169.254"] })
    const response = await h.call(get())

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: "bad_gateway" })
    expect(h.resolve).toHaveBeenCalledWith("upstream.example")
    expect(h.fetchImpl).not.toHaveBeenCalled()
  })

  it("forwards to a private address, which the spec accepts", async () => {
    const h = harness({ resolve: async () => ["10.0.0.5"] })
    const response = await h.call(get())
    expect(response.status).toBe(200)
    expect(h.fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["fe80::1", "IPv6 link-local"],
    ["FE80::0202:B3FF:FE1E:8329", "IPv6 link-local, upper-case"],
    ["febf::1", "the top of fe80::/10"],
    ["::ffff:169.254.169.254", "IPv4-mapped, dotted"],
    ["::ffff:a9fe:a9fe", "IPv4-mapped, hex"],
    ["169.254.0.1", "the bottom of 169.254.0.0/16"],
  ])("refuses %s (%s)", async (address) => {
    const h = harness({ resolve: async () => [address] })
    const response = await h.call(get())
    expect(response.status).toBe(502)
    expect(h.fetchImpl).not.toHaveBeenCalled()
  })

  it("refuses when any resolved address is link-local", async () => {
    // A name that answers with a mix is a name whose next lookup may pick
    // the other one; the only safe reading of a mixed answer is the worst.
    const h = harness({ resolve: async () => ["10.0.0.5", "169.254.1.1"] })
    expect((await h.call(get())).status).toBe(502)
  })

  it("does not consult the resolver for an address literal, and still refuses a link-local one", async () => {
    for (const url of [
      "http://169.254.169.254",
      "http://169.254.169.254:8080/latest",
      "http://[fe80::1]:3000",
      "http://[::ffff:169.254.169.254]",
    ]) {
      resetGatewayRegistry()
      const h = harness({ rows: [row({ url })] })
      const response = await h.call(get())
      expect(response.status, url).toBe(502)
      expect(h.resolve, url).not.toHaveBeenCalled()
      expect(h.fetchImpl, url).not.toHaveBeenCalled()
    }
  })

  it("forwards to a loopback literal without a lookup", async () => {
    // What the integration suite does: a `node:http` server on 127.0.0.1.
    const h = harness({ rows: [row({ url: "http://127.0.0.1:9999" })] })
    expect((await h.call(get())).status).toBe(200)
    expect(h.resolve).not.toHaveBeenCalled()
  })

  it("answers 502 when the name does not resolve at all", async () => {
    const h = harness({
      resolve: async () => Promise.reject(new Error("ENOTFOUND")),
    })
    expect((await h.call(get())).status).toBe(502)
    expect(h.fetchImpl).not.toHaveBeenCalled()
  })
})

describe("the rules the file and the form share", () => {
  it("refuses a link-local literal at configuration time", () => {
    for (const url of [
      "http://169.254.169.254",
      "http://[fe80::1]",
      "http://[::ffff:169.254.169.254]:80",
    ]) {
      expect(checkGatewayUrl(url), url).toBe("link_local")
    }
    for (const url of [
      "http://10.0.0.5",
      "http://127.0.0.1:3000",
      "http://postgrest:3000",
      "http://[::1]:3000",
      "http://169.254.example.com",
    ]) {
      expect(checkGatewayUrl(url), url).toBeUndefined()
    }
  })

  it("is what the configuration file refuses with", () => {
    const parsed = configFileSchema.safeParse({
      ...baseConfig(),
      gateways: { meta: { url: "http://169.254.169.254" } },
    })
    expect(parsed.success).toBe(false)
    expect(
      parsed.error?.issues.map((issue) => issue.message).join(" ")
    ).toMatch(/link-local/)
  })

  it("accepts a audience that is an absolute URI or URN and refuses the rest", () => {
    for (const value of [
      "https://api.example/v1",
      "https://api.example",
      "urn:example:api",
      "https://api.example/v1?tenant=a",
    ]) {
      expect(checkGatewayAudience(value), value).toBeUndefined()
    }
    expect(checkGatewayAudience("not a uri")).toBe("not_uri")
    expect(checkGatewayAudience("/relative")).toBe("not_uri")
    expect(checkGatewayAudience("api.example")).toBe("not_uri")
    // RFC 8707 §2: a audience MUST NOT include a fragment.
    expect(checkGatewayAudience("https://api.example/#x")).toBe("fragment")
    expect(checkGatewayAudience("https://api.example/#")).toBe("fragment")
  })

  it("carries `audience` through the file schema", () => {
    const ok = configFileSchema.safeParse({
      ...baseConfig(),
      gateways: {
        data: { url: "https://api.example", audience: "https://api.example/v1" },
      },
    })
    expect(ok.success).toBe(true)
    expect(ok.data?.gateways.data?.audience).toBe("https://api.example/v1")

    const bad = configFileSchema.safeParse({
      ...baseConfig(),
      gateways: { data: { url: "https://api.example", audience: "nope" } },
    })
    expect(bad.success).toBe(false)
    expect(
      bad.error?.issues.map((issue) => issue.message).join(" ")
    ).toMatch(/absolute URI/)
  })

  it("names the form field a bad audience belongs to", () => {
    expect(
      validateGatewayForm({
        name: "data",
        url: "https://api.example",
        audience: "nope",
      })
    ).toEqual({ audience: "audience:not_uri:nope" })
    expect(
      validateGatewayForm({ name: "data", url: "https://api.example", audience: "" })
    ).toEqual({})
  })
})

describe("the request body cap", () => {
  const capped = () =>
    config({ server: { baseUrl: ISSUER, maxRequestBodyBytes: 1024 } })

  /** An upstream that drains the body, the way a real socket would. */
  const draining = async (init: RequestInit): Promise<Response> => {
    const body = init.body as ReadableStream<Uint8Array> | undefined
    let received = 0
    if (body) {
      for await (const chunk of body) received += chunk.byteLength
    }
    return new Response(String(received), { status: 200 })
  }

  function stream(chunks: number, size: number): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < chunks; index += 1) {
          controller.enqueue(new Uint8Array(size))
        }
        controller.close()
      },
    })
  }

  it("refuses a declared oversize body before the upstream is called", async () => {
    const h = harness({ config: capped(), upstream: draining })
    const response = await h.call(
      new Request(`${ISSUER}/gateway/data`, {
        method: "POST",
        headers: { "content-length": "4096" },
        body: stream(4, 1024),
        duplex: "half",
      } as RequestInit)
    )
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: "payload_too_large" })
    expect(h.fetchImpl).not.toHaveBeenCalled()
  })

  it("aborts a streamed body once it passes the cap and answers 413", async () => {
    // No `content-length` — a chunked upload — so the only place the size
    // can be known is in the stream, and the only honest answer is to stop
    // forwarding the moment the cap is passed rather than after buffering.
    const h = harness({ config: capped(), upstream: draining })
    const response = await h.call(
      new Request(`${ISSUER}/gateway/data`, {
        method: "POST",
        body: stream(4, 1024),
        duplex: "half",
      } as RequestInit)
    )
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: "payload_too_large" })
  })

  it("streams a body under the cap through untouched", async () => {
    const h = harness({ config: capped(), upstream: draining })
    const response = await h.call(
      new Request(`${ISSUER}/gateway/data`, {
        method: "POST",
        body: stream(2, 512),
        duplex: "half",
      } as RequestInit)
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("1024")
  })

  it("defaults to 64 MiB", () => {
    expect(config().file.server.maxRequestBodyBytes).toBe(64 * 1024 * 1024)
  })
})

describe("the token cache keyed per gateway", () => {
  const rows = [
    row({ id: "a", name: "a" }),
    row({ id: "b", name: "b" }),
    row({ id: "c", name: "c", audience: "https://c.example" }),
    row({ id: "d", name: "d", audience: "https://c.example" }),
  ]

  it("shares one entry across gateways without a audience, and keeps one per gateway with", async () => {
    const h = harness({ rows, token: tokenResponse("jwt") })
    const call = (name: string) =>
      h.call(get(`/gateway/${name}`, { headers: { "x-api-key": "same" } }), {
        name,
      })

    await call("a")
    await call("b")
    // Byte-for-byte today's behavior: no audience, one entry per credential.
    expect(h.handler, "a and b share the entry").toHaveBeenCalledTimes(1)

    await call("c")
    expect(h.handler, "c mints its own").toHaveBeenCalledTimes(2)
    await call("c")
    expect(h.handler, "and reuses it").toHaveBeenCalledTimes(2)

    // Same audience, different gateway: still a separate entry, because the
    // key is the gateway's name — an edit to one gateway's audience must not
    // hand another gateway a token minted for the old value.
    await call("d")
    expect(h.handler).toHaveBeenCalledTimes(3)
  })

  it("asks the mint for the gateway's audience as the audience, and for nothing otherwise", async () => {
    const seen: (string | undefined)[] = []
    const h = harness({
      rows,
      token: async () => {
        seen.push(requestedAudience())
        return tokenResponse("jwt")
      },
    })
    await h.call(get("/gateway/a", { headers: { "x-api-key": "k" } }), {
      name: "a",
    })
    await h.call(get("/gateway/c", { headers: { "x-api-key": "k" } }), {
      name: "c",
    })
    expect(seen).toEqual([undefined, "https://c.example"])
    // Outside a mint there is no requested audience — the ordinary `/token`
    // call must keep minting `jwt.audience`.
    expect(requestedAudience()).toBeUndefined()
  })
})

describe("the route files", () => {
  /**
   * Both of them, all seven methods.
   *
   * An **undeclared** method does not 405 here — it falls through to the page
   * tree and answers 200 with the sign-in document, so a client that sent
   * `DELETE` would read a success and an HTML body. That is the lesson
   * `/oauth2/token` taught, and this is the only gate that would notice it
   * coming back. The `readyz-draining` pattern: assert the record form, so a
   * route that stops declaring handlers throws rather than passing vacuously.
   */
  const METHODS = [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "OPTIONS",
    "HEAD",
  ] as const

  it.each([
    ["/gateway/$name", GatewayRoot],
    ["/gateway/$name/$", GatewaySplat],
  ])("%s declares every method", (_path, route) => {
    const handlers = route.options.server?.handlers as
      | Record<string, unknown>
      | undefined
    expect(handlers, "handlers must be declared in record form").toBeTypeOf(
      "object"
    )
    for (const method of METHODS) {
      expect(typeof handlers?.[method], `${method} handler`).toBe("function")
    }
  })
})
