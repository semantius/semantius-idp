/**
 * The 2026-09 security review's gateway findings, against a live auth
 * instance and a real upstream.
 *
 * `unit/gateway-proxy.test.ts` proves each decision with a stubbed mint and a
 * stubbed `fetch`. What it cannot prove is the half that goes through Better
 * Auth: that a gateway's `audience` really lands in the `aud` of a JWT the
 * plugin signed, that a gateway without one still mints `jwt.audience` byte
 * for byte, and that a `audience` written through `config.jsonc` survives the
 * reconcile into the row the proxy reads. The rest — the traversal refusal,
 * the link-local refusal, the header deny-list, the body cap — is repeated
 * here through a `node:http` server so the whole path is exercised once
 * against sockets rather than mocks.
 *
 * The upstream is `127.0.0.1`, which is a literal and is never resolved — the
 * link-local case inserts its row straight into the table, the way a `psql`
 * edit would, because `checkGatewayUrl` refuses the literal on every write
 * path and the request-time check is the only one left to prove.
 */

import { createServer } from "node:http"
import type { Server } from "node:http"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { decodeJwt } from "jose"
import { eq } from "drizzle-orm"

import { createLocalAccountIssuer } from "@better-auth/core/db"
import { createUserWithoutRequest } from "@/server/auth/provisioning"
import {
  proxyGatewayRequest,
  resetGatewayTokenCache,
} from "@/server/gateways/proxy"
import { reconcileGateways } from "@/server/gateways/reconcile"
import { resetGatewayRegistry } from "@/server/gateways/registry"
import type { TestContext } from "./harness"
import { authRequest, createTestContext, sessionCookie } from "./harness"

const ISSUER = "http://localhost:3000"
const EMAIL = "review-gateway@example.com"
const PASSWORD = "correct-horse-battery-staple"
const AUDIENCE = "https://billing.example.com/api"
const BODY_CAP = 4 * 1024

let ctx: TestContext
let upstream: Server
let upstreamOrigin: string
let cookie: string

/** What the last upstream request carried; `undefined` when none arrived. */
let lastRequest: { url: string; headers: Record<string, string> } | undefined

beforeAll(async () => {
  upstream = createServer((request, response) => {
    // Drain so a POST completes, but keep only what the assertions read.
    request.on("data", () => undefined)
    request.on("end", () => {
      lastRequest = {
        url: request.url ?? "",
        headers: Object.fromEntries(
          Object.entries(request.headers).map(([key, value]) => [
            key,
            Array.isArray(value) ? value.join(", ") : (value ?? ""),
          ])
        ),
      }
      response.writeHead(200, {
        "content-type": "application/json",
        // The PostgREST shape a client reads (the spec's deny-list must keep
        // these) beside the origin-scoped ones it must not.
        "content-range": "0-0/1",
        "preference-applied": "return=representation",
        "strict-transport-security": "max-age=0",
        "access-control-allow-origin": "*",
        "clear-site-data": '"*"',
        refresh: "0; url=https://evil.example/",
      })
      response.end(JSON.stringify({ url: request.url }))
    })
  })
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  const address = upstream.address()
  upstreamOrigin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`

  ctx = await createTestContext("security-review-gateway", {
    config: {
      server: { baseUrl: ISSUER, maxRequestBodyBytes: BODY_CAP },
      auth: { requireEmailVerification: false },
      apiKeys: { tokenClientId: "api-key-client" },
      // Through the file, so the `audience` is proven across the reconcile
      // and not only across an insert this test wrote itself.
      gateways: {
        plain: { url: upstreamOrigin },
        scoped: { url: `${upstreamOrigin}/v1`, audience: AUDIENCE },
      },
    },
  })
  await reconcileGateways({
    config: ctx.config,
    database: ctx.database,
    locking: ctx.database,
  })
  // A row `checkGatewayUrl` would refuse on every write path — what a
  // `psql` edit, or a record that changed after it was stored, looks like.
  await ctx.database.db.insert(ctx.database.schema.gateway).values({
    id: crypto.randomUUID(),
    name: "meta",
    url: "http://169.254.169.254",
    requireAuth: false,
    source: "manual",
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  resetGatewayRegistry()

  const context = await ctx.auth.$context
  const user = await createUserWithoutRequest(
    context,
    {
      email: EMAIL,
      name: "Review User",
      emailVerified: true,
      role: "admin",
      status: "active",
    },
    { method: "admin" }
  )
  await context.internalAdapter.createAccount({
    userId: user.id,
    providerId: "credential",
    issuer: createLocalAccountIssuer("credential"),
    accountId: user.id,
    password: await context.password.hash(PASSWORD),
  })
  const signIn = await ctx.auth.handler(
    authRequest("/sign-in/email", { json: { email: EMAIL, password: PASSWORD } })
  )
  cookie = sessionCookie(signIn)!
})

afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
  await ctx.teardown()
})

afterEach(() => {
  resetGatewayTokenCache()
  resetGatewayRegistry()
  lastRequest = undefined
})

function proxy(request: Request, name: string, subPath = ""): Promise<Response> {
  return proxyGatewayRequest(
    { config: ctx.config, auth: ctx.auth, database: ctx.database },
    request,
    name,
    subPath
  )
}

async function createKey(name: string): Promise<string> {
  const response = await ctx.auth.handler(
    authRequest("/api-key/create", { headers: { cookie }, json: { name } })
  )
  expect(response.status).toBe(200)
  return ((await response.json()) as { key: string }).key
}

/** The JWT the upstream was handed on the last call. */
function upstreamJwt() {
  const authorization = lastRequest?.headers.authorization ?? ""
  expect(authorization.startsWith("Bearer ")).toBe(true)
  return decodeJwt(authorization.slice("Bearer ".length))
}

describe("the sub-path cannot leave the target", () => {
  it("refuses what the router hands over for ..%2fsecret and never reaches the upstream", async () => {
    const response = await proxy(
      new Request(`${ISSUER}/gateway/scoped/..%2fsecret`),
      "scoped",
      "../secret"
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "invalid_path" })
    expect(lastRequest).toBeUndefined()
  })

  it("forwards a plain sub-path under the scoped prefix", async () => {
    const response = await proxy(
      new Request(`${ISSUER}/gateway/scoped/items?select=id`),
      "scoped",
      "items"
    )
    expect(response.status).toBe(200)
    expect(lastRequest?.url).toBe("/v1/items?select=id")
  })
})

describe("the upstream address", () => {
  it("answers 502 for a stored link-local target without connecting", async () => {
    const response = await proxy(new Request(`${ISSUER}/gateway/meta`), "meta")
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: "bad_gateway" })
    expect(lastRequest).toBeUndefined()
  })

  it("is refused by the admin API before it can be stored", async () => {
    const response = await ctx.auth.handler(
      authRequest("/idp/create-gateway", {
        headers: { cookie },
        json: { name: "meta2", url: "http://169.254.169.254" },
      })
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      code: "INVALID_GATEWAY_DEFINITION",
      message: expect.stringContaining("link-local"),
    })
  })
})

describe("the audience a gateway mints", () => {
  it("names the gateway's audience as `aud` for a key, and jwt.audience otherwise", async () => {
    const key = await createKey("Audience key")

    expect(
      (
        await proxy(
          new Request(`${ISSUER}/gateway/scoped`, {
            headers: { "x-api-key": key },
          }),
          "scoped"
        )
      ).status
    ).toBe(200)
    const scoped = upstreamJwt()
    expect(scoped.aud).toBe(AUDIENCE)
    // Everything else about the token is the spec token.
    expect(scoped.azp).toBe("api-key-client")

    expect(
      (
        await proxy(
          new Request(`${ISSUER}/gateway/plain`, {
            headers: { "x-api-key": key },
          }),
          "plain"
        )
      ).status
    ).toBe(200)
    // Not the cached `scoped` token: a gateway without a audience has its
    // own entry and its own default audience.
    expect(upstreamJwt().aud).toBe(ISSUER)
  })

  it("does the same for a session cookie", async () => {
    expect(
      (
        await proxy(
          new Request(`${ISSUER}/gateway/scoped`, {
            headers: { cookie, "sec-fetch-site": "same-origin" },
          }),
          "scoped"
        )
      ).status
    ).toBe(200)
    const scoped = upstreamJwt()
    expect(scoped.aud).toBe(AUDIENCE)
    expect(scoped.azp).toBe("idp")
  })

  it("leaves the direct /token mint on jwt.audience", async () => {
    // The ordinary call a script makes: no gateway, no requested audience.
    const key = await createKey("Direct key")
    const response = await ctx.auth.handler(
      new Request(`${ISSUER}/api/auth/token`, { headers: { "x-api-key": key } })
    )
    expect(response.status).toBe(200)
    const { token } = (await response.json()) as { token: string }
    expect(decodeJwt(token).aud).toBe(ISSUER)
  })

  it("stores a audience written through the admin API and refuses a bad one", async () => {
    const created = await ctx.auth.handler(
      authRequest("/idp/create-gateway", {
        headers: { cookie },
        json: {
          name: "manual-scoped",
          url: upstreamOrigin,
          audience: "urn:example:api",
        },
      })
    )
    expect(created.status).toBe(200)
    const [row] = await ctx.database.db
      .select()
      .from(ctx.database.schema.gateway)
      .where(eq(ctx.database.schema.gateway.name, "manual-scoped"))
    expect(row?.audience).toBe("urn:example:api")

    const refused = await ctx.auth.handler(
      authRequest("/idp/create-gateway", {
        headers: { cookie },
        json: { name: "manual-bad", url: upstreamOrigin, audience: "nope" },
      })
    )
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({
      code: "INVALID_GATEWAY_DEFINITION",
    })

    // A blank audience is "unset", not the empty string.
    const cleared = await ctx.auth.handler(
      authRequest("/idp/update-gateway", {
        headers: { cookie },
        json: { name: "manual-scoped", url: upstreamOrigin, audience: "  " },
      })
    )
    expect(cleared.status).toBe(200)
    const [after] = await ctx.database.db
      .select()
      .from(ctx.database.schema.gateway)
      .where(eq(ctx.database.schema.gateway.name, "manual-scoped"))
    expect(after?.audience).toBeNull()
  })
})

describe("response hygiene and the body cap", () => {
  it("strips the origin-scoped headers and keeps PostgREST's", async () => {
    const response = await proxy(new Request(`${ISSUER}/gateway/plain`), "plain")
    expect(response.status).toBe(200)
    for (const name of [
      "strict-transport-security",
      "access-control-allow-origin",
      "clear-site-data",
      "refresh",
    ]) {
      expect(response.headers.has(name), name).toBe(false)
    }
    expect(response.headers.get("content-range")).toBe("0-0/1")
    expect(response.headers.get("preference-applied")).toBe(
      "return=representation"
    )
  })

  it("answers 413 for a streamed body past server.maxRequestBodyBytes", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 8; index += 1) {
          controller.enqueue(new Uint8Array(1024))
        }
        controller.close()
      },
    })
    const response = await proxy(
      new Request(`${ISSUER}/gateway/plain/echo`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: stream,
        duplex: "half",
      } as RequestInit),
      "plain",
      "echo"
    )
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: "payload_too_large" })
  })

  it("answers 413 for a declared oversize body before connecting", async () => {
    const response = await proxy(
      new Request(`${ISSUER}/gateway/plain/echo`, {
        method: "POST",
        headers: { "content-length": String(BODY_CAP + 1) },
        body: "x",
      }),
      "plain",
      "echo"
    )
    expect(response.status).toBe(413)
    expect(lastRequest).toBeUndefined()
  })

  it("streams a body under the cap through", async () => {
    const response = await proxy(
      new Request(`${ISSUER}/gateway/plain/echo`, {
        method: "POST",
        body: "x".repeat(BODY_CAP - 1),
      }),
      "plain",
      "echo"
    )
    expect(response.status).toBe(200)
    expect(lastRequest?.url).toBe("/echo")
  })
})
