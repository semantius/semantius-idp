/**
 * The gateway proxy (FR-GW-3..6, **D91**).
 *
 * The bulk of the proxy's coverage lives here rather than in the integration
 * suite, because almost everything it does is a pure decision about headers,
 * URLs and a cache: which headers cross, which do not, what is answered when
 * a key is refused, and when a cached token stops being used. All of that is
 * observable from a captured `fetchImpl` and a fake `auth.handler`, with no
 * database and no upstream.
 *
 * What is deliberately *not* here is the part a stub cannot prove: that Bun's
 * own `fetch` honours `duplex: "half"` and `decompress: false`. The
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
    upstream?: Response | (() => Promise<Response>)
    token?: Response | (() => Promise<Response>)
  } = {}
): Harness {
  const rows = options.rows ?? [row()]
  const upstream =
    options.upstream ?? new Response("hello", { status: 200 })
  // Typed parameters, not `vi.fn(async () => …)`: without them the mock's
  // `calls` is inferred as `[]` and every assertion about what the proxy sent
  // fails to compile rather than failing usefully.
  const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
    typeof upstream === "function" ? upstream() : upstream.clone()
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
    ...(options.now ? { now: options.now } : {}),
  }

  return {
    fetchImpl,
    handler,
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

describe("resolving the gateway (FR-GW-6)", () => {
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

describe("auth translation (FR-GW-4)", () => {
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
    // last-used accounting and `azp` live only there (FR-KEY-3).
    const minted = h.handler.mock.calls[0]![0] as Request
    expect(minted.url).toBe(`${ISSUER}/api/auth/token`)
    expect(minted.headers.get("x-api-key")).toBe("idp_key")
  })

  it("puts the caller's address on the mint request", async () => {
    // Without it every mint in the deployment shares Better Auth's single
    // `no-trusted-ip` bucket, and one caller's spray starves the rest (S3).
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

  it("uses x-forwarded-for on the mint when a proxy is trusted", async () => {
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
    expect(minted.headers.get("x-forwarded-for")).toBe("198.51.100.4")
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

describe("the token cache (FR-GW-5)", () => {
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

  it("is emptied by resetGatewayTokenCache, which is D91's punch-through", async () => {
    const h = harness({ token: tokenResponse("jwt-1") })
    const request = () =>
      h.call(get("/gateway/data", { headers: { "x-api-key": "idp_key" } }))

    await request()
    expect(h.handler).toHaveBeenCalledTimes(1)

    // What `admin/guard.ts` calls after a ban or a key revocation: the next
    // call re-mints, so the FR-KEY-2 gate runs again immediately.
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

describe("outbound headers (FR-GW-3)", () => {
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

  it("honours trusted inbound forwarding headers when trustProxy is on", async () => {
    const h = harness({
      config: config({ server: { baseUrl: ISSUER, trustProxy: true } }),
    })
    await h.call(
      get("/gateway/data", {
        headers: {
          "x-forwarded-for": "198.51.100.4",
          "x-forwarded-host": "apps.example.com",
          "x-forwarded-proto": "https",
        },
      })
    )

    const sent = h.sent()
    expect(sent.get("x-forwarded-for")).toBe("198.51.100.4")
    expect(sent.get("x-forwarded-host")).toBe("apps.example.com")
    expect(sent.get("x-forwarded-proto")).toBe("https")
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

describe("the response (FR-GW-6)", () => {
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

  it("answers a HEAD with no body", async () => {
    const h = harness({ upstream: new Response("hello", { status: 200 }) })
    const response = await h.call(
      new Request(`${ISSUER}/gateway/data`, { method: "HEAD" })
    )
    expect(response.body).toBeNull()
  })
})

describe("the route files", () => {
  /**
   * Both of them, all seven methods (FR-GW-3).
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
