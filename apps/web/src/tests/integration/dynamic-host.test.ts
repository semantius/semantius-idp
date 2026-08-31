/**
 * `server.dynamicIssuer`, end to end: one process, one database, one JWKS —
 * answering as a different issuer on every host the edge routes.
 *
 * Each request is wrapped in the same request context the server entry
 * builds: the issuer is resolved ONCE at the edge (`oidc/request-issuer.ts`)
 * and everything downstream — the jwt plugin's issuer getter, the discovery
 * rewrite, the `{host}` template expansions in `getClient()` and CORS — reads
 * it from there. That wrapper is the seam under test as much as any endpoint.
 */

import { describe, expect, it } from "vitest"

import { createHash, randomBytes } from "node:crypto"
import { createLocalJWKSet, decodeJwt, jwtVerify } from "jose"

import { withRequestContext } from "@/server/http/request-log"
import { corsFor } from "@/server/http/cors"
import { forwardDiscovery } from "@/server/oidc/protocol-proxy"
import { resumeAuthorization } from "@/server/oidc/continuation"
import { reconcileClients } from "@/server/oidc/reconcile"
import { resolveRequestIssuer } from "@/server/oidc/request-issuer"
import { HOST_TEMPLATE_DISCOVERY_ID } from "@/server/oidc/host-template-clients"
import type { TestContext } from "./harness"
import { asRuntime, createTestContext, sessionCookie } from "./harness"

const CANONICAL = "https://a.example.com"
const AUTH_BASE = `${CANONICAL}/api/auth`
const HOST_B = "b.example.com"
const HOST_C = "c.example.com"
const PASSWORD = "correct-horse-battery-staple"
const AUDIENCE = "semantius://api"

/** The reference stack's SPA, template redirect URIs and all. */
const TEMPLATE_CLIENT = {
  clientId: "public-client",
  type: "spa",
  name: "Semantius App",
  redirectUris: ["https://{host}/oauth2_callback"],
  postLogoutRedirectUris: ["https://{host}/", "https://{host}/logout-success"],
  skipConsent: true,
  enableEndSession: true,
}

async function context(label: string): Promise<TestContext> {
  const ctx = await createTestContext(label, {
    clients: [TEMPLATE_CLIENT],
    config: {
      server: {
        baseUrl: CANONICAL,
        dynamicIssuer: true,
        trustProxy: true,
      },
      jwt: { audience: AUDIENCE },
      signUp: { enabled: true, requireApproval: false },
      auth: { requireEmailVerification: false },
    },
  })
  await reconcileClients({
    config: ctx.config,
    database: ctx.database,
    locking: ctx.database,
  })
  return ctx
}

/**
 * Runs `fn` inside the request context `server-entry.ts` would have built for
 * this request — the resolved issuer included.
 */
function atEdge<T>(ctx: TestContext, request: Request, fn: () => T): T {
  return withRequestContext(
    {
      requestId: "test",
      issuer: resolveRequestIssuer(ctx.config.base, request, {
        trustProxy: ctx.config.file.server.trustProxy,
      }),
    },
    fn
  )
}

/** A request aimed at the canonical auth mount, arriving with a Host header. */
function hostedRequest(
  path: string,
  host: string,
  init: RequestInit & { json?: unknown; form?: Record<string, string> } = {}
): Request {
  const { json, form, ...rest } = init
  const headers = new Headers(rest.headers)
  headers.set("host", host)
  if (!headers.has("origin")) headers.set("origin", `https://${host}`)
  let body: BodyInit | undefined
  if (json !== undefined) {
    headers.set("content-type", "application/json")
    body = JSON.stringify(json)
  } else if (form !== undefined) {
    headers.set("content-type", "application/x-www-form-urlencoded")
    body = new URLSearchParams(form).toString()
  }
  return new Request(`${AUTH_BASE}${path}`, {
    ...rest,
    headers,
    ...(body !== undefined ? { body, method: rest.method ?? "POST" } : {}),
  })
}

async function handleOn(
  ctx: TestContext,
  request: Request
): Promise<Response> {
  return atEdge(ctx, request, () => ctx.auth.handler(request))
}

async function register(ctx: TestContext, host: string): Promise<string> {
  const email = `user-${host.replace(/\W/g, "-")}@example.com`
  await handleOn(
    ctx,
    hostedRequest("/sign-up/email", host, {
      json: { email, password: PASSWORD, name: "Dynamic User" },
    })
  )
  const response = await handleOn(
    ctx,
    hostedRequest("/sign-in/email", host, {
      json: { email, password: PASSWORD },
    })
  )
  const cookie = sessionCookie(response)
  expect(cookie, await response.clone().text()).toBeTruthy()
  return cookie!
}

interface CodeGrant {
  code: string
  verifier: string
  redirectUri: string
}

/** A full PKCE authorization on `host`, driven the way the pages drive it. */
async function authorizeOn(
  ctx: TestContext,
  host: string,
  cookie: string
): Promise<CodeGrant> {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const redirectUri = `https://${host}/oauth2_callback`
  const query = new URLSearchParams({
    response_type: "code",
    client_id: TEMPLATE_CLIENT.clientId,
    redirect_uri: redirectUri,
    scope: "openid profile email",
    state: "state-1",
    code_challenge: challenge,
    code_challenge_method: "S256",
  })
  const request = new Request(
    `${AUTH_BASE}/oauth2/authorize?${query.toString()}`,
    { headers: { host, cookie }, redirect: "manual" }
  )
  const response = await handleOn(ctx, request)
  const location = response.headers.get("location") ?? ""
  expect(location, await response.clone().text()).toContain("code=")
  const code = new URL(location).searchParams.get("code") ?? ""
  expect(code).toBeTruthy()
  // The provider must send the browser back to the EXPANDED redirect URI —
  // the host the request arrived on, not the canonical one and not the
  // template.
  expect(location.startsWith(redirectUri)).toBe(true)
  return { code, verifier, redirectUri }
}

async function exchangeOn(
  ctx: TestContext,
  host: string,
  grant: CodeGrant
): Promise<Record<string, unknown>> {
  const response = await handleOn(
    ctx,
    hostedRequest("/oauth2/token", host, {
      form: {
        grant_type: "authorization_code",
        code: grant.code,
        redirect_uri: grant.redirectUri,
        client_id: TEMPLATE_CLIENT.clientId,
        code_verifier: grant.verifier,
      },
    })
  )
  const body = (await response.json()) as Record<string, unknown>
  expect(response.status, JSON.stringify(body)).toBe(200)
  return body
}

async function discoveryOn(
  ctx: TestContext,
  host: string
): Promise<Record<string, unknown>> {
  const path = "/.well-known/openid-configuration"
  const request = new Request(`${CANONICAL}${path}`, {
    headers: { host },
  })
  const response = await atEdge(ctx, request, () =>
    forwardDiscovery(asRuntime(ctx), request, path)
  )
  expect(response.status).toBe(200)
  return (await response.json()) as Record<string, unknown>
}

describe("discovery follows the request host", () => {
  it("advertises host B on host B, with no /api/auth anywhere", async () => {
    const ctx = await context("dynamic_discovery")
    try {
      const document = await discoveryOn(ctx, HOST_B)
      expect(document.issuer).toBe(`https://${HOST_B}`)
      expect(document.authorization_endpoint).toBe(
        `https://${HOST_B}/oauth2/authorize`
      )
      expect(document.token_endpoint).toBe(`https://${HOST_B}/oauth2/token`)
      expect(document.jwks_uri).toBe(
        `https://${HOST_B}/.well-known/jwks.json`
      )
      expect(JSON.stringify(document)).not.toContain("/api/auth")
      expect(JSON.stringify(document)).not.toContain("a.example.com")
    } finally {
      await ctx.teardown()
    }
  })

  it("resolves a second host in the same process to that host", async () => {
    const ctx = await context("dynamic_second_host")
    try {
      const forB = await discoveryOn(ctx, HOST_B)
      const forC = await discoveryOn(ctx, HOST_C)
      expect(forB.issuer).toBe(`https://${HOST_B}`)
      expect(forC.issuer).toBe(`https://${HOST_C}`)
    } finally {
      await ctx.teardown()
    }
  })
})

describe("the template client", () => {
  it("stores the template verbatim, stamped with the discovery id", async () => {
    const ctx = await context("dynamic_row")
    try {
      const rows = await ctx.database.db
        .select()
        .from(ctx.database.schema.oauthClient)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.clientDiscoveryId).toBe(HOST_TEMPLATE_DISCOVERY_ID)
      expect(rows[0]?.redirectUris).toEqual(["https://{host}/oauth2_callback"])
    } finally {
      await ctx.teardown()
    }
  })
})

describe("sign-in and authorization complete on host B", () => {
  it("issues tokens whose iss is host B, verifiable against the shared JWKS", async () => {
    const ctx = await context("dynamic_tokens")
    try {
      const cookie = await register(ctx, HOST_B)
      const grant = await authorizeOn(ctx, HOST_B, cookie)
      const tokens = await exchangeOn(ctx, HOST_B, grant)

      const jwksResponse = await ctx.auth.handler(
        new Request(`${AUTH_BASE}/jwks`)
      )
      const jwks = createLocalJWKSet(await jwksResponse.json())

      const accessToken = String(tokens.access_token)
      const idToken = String(tokens.id_token)
      expect(decodeJwt(accessToken).iss).toBe(`https://${HOST_B}`)

      const { payload } = await jwtVerify(idToken, jwks, {
        issuer: `https://${HOST_B}`,
        audience: TEMPLATE_CLIENT.clientId,
      })
      expect(payload.iss).toBe(`https://${HOST_B}`)

      const { payload: accessPayload } = await jwtVerify(accessToken, jwks, {
        issuer: `https://${HOST_B}`,
      })
      // The audience stays the FIXED URI, independent of the issuer host —
      // that is what keeps a resource server's `aud` check working on every
      // domain.
      const aud = accessPayload.aud
      expect(Array.isArray(aud) ? aud : [aud]).toContain(AUDIENCE)
    } finally {
      await ctx.teardown()
    }
  })

  it("resumes an interrupted authorization on host B", async () => {
    const ctx = await context("dynamic_resume")
    try {
      // No session yet: the authorize lands on /login with the signed query.
      const verifier = randomBytes(32).toString("base64url")
      const challenge = createHash("sha256")
        .update(verifier)
        .digest("base64url")
      const query = new URLSearchParams({
        response_type: "code",
        client_id: TEMPLATE_CLIENT.clientId,
        redirect_uri: `https://${HOST_B}/oauth2_callback`,
        scope: "openid profile email",
        state: "state-resume",
        code_challenge: challenge,
        code_challenge_method: "S256",
      })
      const attempt = await handleOn(
        ctx,
        new Request(`${AUTH_BASE}/oauth2/authorize?${query.toString()}`, {
          headers: { host: HOST_B },
          redirect: "manual",
        })
      )
      const location = attempt.headers.get("location") ?? ""
      expect(location).toContain("/login")
      const signed = new URL(location, CANONICAL).search.replace(/^\?/, "")

      const cookie = await register(ctx, HOST_B)

      // The REAL resume path — `oidc/continuation.ts` — with the login page's
      // own request standing in for the browser's form post. This is the
      // synthetic request whose copied Host header is load-bearing: without
      // it the origin check resolves to the canonical host and answers 403
      // INVALID_ORIGIN.
      const loginPost = new Request(`${CANONICAL}/login`, {
        method: "POST",
        headers: {
          host: HOST_B,
          origin: `https://${HOST_B}`,
          cookie,
        },
      })
      const resumed = await atEdge(ctx, loginPost, () =>
        resumeAuthorization(asRuntime(ctx), loginPost, signed)
      )
      expect(resumed.invalid).toBeUndefined()
      expect(resumed.destination).toBeTruthy()
      expect(
        resumed.destination!.startsWith(`https://${HOST_B}/oauth2_callback`)
      ).toBe(true)
      expect(resumed.destination).toContain("code=")
    } finally {
      await ctx.teardown()
    }
  })
})

describe("CORS expands the template per request", () => {
  it("allows the SPA's token POST from the host it arrived on, and only that one", async () => {
    const ctx = await context("dynamic_cors")
    try {
      const onB = new Request(`${AUTH_BASE}/oauth2/token`, {
        method: "POST",
        headers: { host: HOST_B, origin: `https://${HOST_B}` },
      })
      const decisionB = atEdge(ctx, onB, () =>
        corsFor(onB, ctx.config, "clients")
      )
      expect(decisionB.headers["access-control-allow-origin"]).toBe(
        `https://${HOST_B}`
      )

      // Host C's expansion is host C: an Origin from B on a request that
      // arrived on C matches nothing.
      const crossed = new Request(`${AUTH_BASE}/oauth2/token`, {
        method: "POST",
        headers: { host: HOST_C, origin: `https://${HOST_B}` },
      })
      const decisionCrossed = atEdge(ctx, crossed, () =>
        corsFor(crossed, ctx.config, "clients")
      )
      expect(
        decisionCrossed.headers["access-control-allow-origin"]
      ).toBeUndefined()
    } finally {
      await ctx.teardown()
    }
  })
})

describe("RP-initiated logout works on host B", () => {
  it("verifies the hint against host B's issuer and honours the expanded post-logout URI", async () => {
    const ctx = await context("dynamic_logout")
    // `verifyLogoutHint` fetches the deployment's OWN key set over HTTP
    // (`${baseURL}/jwks`) — in production that resolves through the front
    // door; in this process nothing listens on the canonical host, so the
    // fetch is answered locally with the same keys the handler would serve.
    // Everything under test — the per-request `iss` comparison and the
    // expanded post-logout URI — runs after that fetch.
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url === `${AUTH_BASE}/jwks`) {
        return ctx.auth.handler(new Request(`${AUTH_BASE}/jwks`))
      }
      return realFetch(input, init)
    }) as typeof fetch
    try {
      const cookie = await register(ctx, HOST_B)
      const grant = await authorizeOn(ctx, HOST_B, cookie)
      const tokens = await exchangeOn(ctx, HOST_B, grant)
      const idToken = String(tokens.id_token)

      const query = new URLSearchParams({
        id_token_hint: idToken,
        post_logout_redirect_uri: `https://${HOST_B}/`,
        state: "logout-state",
      })
      const response = await handleOn(
        ctx,
        new Request(
          `${AUTH_BASE}/oauth2/end-session?${query.toString()}`,
          { headers: { host: HOST_B, cookie }, redirect: "manual" }
        )
      )
      const location = response.headers.get("location") ?? ""
      expect(location, await response.clone().text()).toContain(
        `https://${HOST_B}/?state=logout-state`
      )
    } finally {
      globalThis.fetch = realFetch
      await ctx.teardown()
    }
  })
})
