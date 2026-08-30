/**
 * The gateway's data path against a live auth instance (FR-GW-3..6, **D91**).
 *
 * The unit suite stubs `auth.handler` and `fetchImpl`, so it proves the
 * decisions and nothing about the exchange. This file proves the exchange: a
 * **real** API key, minted through Better Auth's own token endpoint, arriving
 * at the upstream as a bearer token that verifies against the deployment's
 * published JWKS with the right `sub` and the right `azp`. That is the whole
 * premise of the feature — a client holding only a key reaching a resource
 * server that has never heard of keys — and it is not observable anywhere
 * else.
 *
 * It also pins the D91 trade-off in both directions, because "the ban is
 * re-checked on every use except for up to ten minutes" is the kind of
 * sentence that quietly stops being true: a banned owner's *fresh* mint is
 * refused, a cached one is not, and the admin punch-through closes it.
 *
 * **The upstream is a real HTTP server**, from `node:http`, because that is
 * the runner these tests execute under. What that proves is that the streamed
 * request body actually reaches an upstream over a socket — the unit tests
 * hand `request.body` to a stub that never reads it. What it cannot prove is
 * Bun's `decompress: false`, which is a Bun-specific fetch option and the
 * reason the container smoke test and the e2e suite run the built image.
 */

import { createServer } from "node:http"
import type { Server } from "node:http"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { createLocalJWKSet, decodeJwt, jwtVerify } from "jose"
import { eq } from "drizzle-orm"

import { createUserWithoutRequest } from "@/server/auth/provisioning"
import { createLocalAccountIssuer } from "@better-auth/core/db"
import {
  proxyGatewayRequest,
  resetGatewayTokenCache,
} from "@/server/gateways/proxy"
import { resetGatewayRegistry } from "@/server/gateways/registry"
import type { TestContext } from "./harness"
import { authRequest, createTestContext, sessionCookie } from "./harness"

const ISSUER = "http://localhost:3000"
const EMAIL = "gateway-user@example.com"
const PASSWORD = "correct-horse-battery-staple"

let ctx: TestContext
let upstream: Server
let upstreamOrigin: string
let userId: string
let cookie: string

/** What the last upstream request carried, for the header assertions. */
let lastRequest: { headers: Record<string, string>; body: string } | undefined

beforeAll(async () => {
  ctx = await createTestContext("gateway-proxy", {
    config: {
      auth: { requireEmailVerification: false },
      // Deliberately not the "idp" default: `azp` for a key exchange is
      // supposed to be this value, and with the default the assertion below
      // would pass whether the discriminator worked or not.
      apiKeys: { tokenClientId: "api-key-client" },
    },
  })

  upstream = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      const body = Buffer.concat(chunks)
      lastRequest = {
        headers: Object.fromEntries(
          Object.entries(request.headers).map(([key, value]) => [
            key,
            Array.isArray(value) ? value.join(", ") : (value ?? ""),
          ])
        ),
        body: body.toString("utf8"),
      }
      response.writeHead(200, {
        "content-type": "application/json",
        // Stripped on the way back: the gateway is same-origin with the
        // issuer, so an upstream must not set a cookie here (**D91**).
        "set-cookie": "upstream=1; Path=/",
      })
      response.end(
        JSON.stringify({ url: request.url, length: body.byteLength })
      )
    })
  })
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  const address = upstream.address()
  upstreamOrigin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`

  const context = await ctx.auth.$context
  const user = await createUserWithoutRequest(
    context,
    {
      email: EMAIL,
      name: "Gateway User",
      emailVerified: true,
      role: "admin",
      status: "active",
    },
    { method: "admin" }
  )
  userId = user.id
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

  await ctx.database.db.insert(ctx.database.schema.gateway).values([
    {
      id: crypto.randomUUID(),
      name: "data",
      url: upstreamOrigin,
      requireAuth: false,
      source: "manual",
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: crypto.randomUUID(),
      name: "off",
      url: upstreamOrigin,
      requireAuth: false,
      source: "manual",
      enabled: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ])
})

afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
  await ctx.teardown()
})

afterEach(() => {
  resetGatewayTokenCache()
  resetGatewayRegistry()
  forgetUpstream()
})

/**
 * Forgets the last upstream request, so an assertion can prove none arrived.
 *
 * A function rather than an inline `lastRequest = undefined`, because the
 * assignment narrows the module-level `let` to `undefined` for the rest of the
 * block and every later `lastRequest?.…` then reads as `never`.
 */
function forgetUpstream(): void {
  lastRequest = undefined
}

function deps() {
  return {
    config: ctx.config,
    auth: ctx.auth,
    database: ctx.database,
  }
}

function proxy(
  request: Request,
  name = "data",
  subPath = ""
): Promise<Response> {
  return proxyGatewayRequest(deps(), request, name, subPath)
}

async function createKey(name = "Gateway key"): Promise<string> {
  const response = await ctx.auth.handler(
    authRequest("/api-key/create", { headers: { cookie }, json: { name } })
  )
  expect(response.status).toBe(200)
  return ((await response.json()) as { key: string }).key
}

async function jwks() {
  const response = await ctx.auth.handler(
    new Request(`${ISSUER}/api/auth/jwks`)
  )
  return createLocalJWKSet(
    (await response.json()) as { keys: Record<string, unknown>[] }
  )
}

/** A second account, so a ban is not refused by the last-admin invariant. */
async function createOrdinaryUser(
  email: string
): Promise<{ id: string; cookie: string }> {
  const context = await ctx.auth.$context
  const user = await createUserWithoutRequest(
    context,
    {
      email,
      name: "Gateway Victim",
      emailVerified: true,
      role: "user",
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
    authRequest("/sign-in/email", { json: { email, password: PASSWORD } })
  )
  const theirs = sessionCookie(signIn)
  expect(theirs, `${email} could not sign in`).toBeTruthy()
  return { id: user.id, cookie: theirs! }
}

async function createKeyAs(theirs: string, name: string): Promise<string> {
  const response = await ctx.auth.handler(
    authRequest("/api-key/create", { headers: { cookie: theirs }, json: { name } })
  )
  expect(response.status).toBe(200)
  return ((await response.json()) as { key: string }).key
}

async function setBanned(banned: boolean): Promise<void> {
  await ctx.database.db
    .update(ctx.database.schema.user)
    .set({ banned })
    .where(eq(ctx.database.schema.user.id, userId))
}

describe("the key → JWT exchange (FR-GW-4, FR-KEY-3)", () => {
  it("hands the upstream a bearer token that verifies against the JWKS", async () => {
    const key = await createKey()
    const response = await proxy(
      new Request(`${ISSUER}/gateway/data/items?select=id`, {
        headers: { "x-api-key": key, cookie },
      }),
      "data",
      "items"
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ url: "/items?select=id" })

    const authorization = lastRequest?.headers.authorization ?? ""
    expect(authorization.startsWith("Bearer ")).toBe(true)
    const jwt = authorization.slice("Bearer ".length)

    await expect(
      jwtVerify(jwt, await jwks(), { issuer: ISSUER })
    ).resolves.toBeTruthy()
    const payload = decodeJwt(jwt)
    expect(payload.sub).toBe(userId)
    expect(payload.email).toBe(EMAIL)
    // The honest answer to "who is presenting this": a key exchange is not the
    // browser session it borrows.
    expect(payload.azp).toBe("api-key-client")

    // The caller's own credentials never cross.
    expect(lastRequest?.headers["x-api-key"]).toBeUndefined()
    expect(lastRequest?.headers.cookie).toBeUndefined()
    // Nor does the upstream get to set one on the issuer's origin.
    expect(response.headers.getSetCookie()).toEqual([])
    expect(response.headers.get("content-security-policy")).toBe(
      "sandbox; default-src 'none'"
    )
  })

  it("counts the call against the key, the way GET /token does", async () => {
    const key = await createKey("Accounted key")
    await proxy(
      new Request(`${ISSUER}/gateway/data`, { headers: { "x-api-key": key } })
    )

    const [row] = await ctx.database.db
      .select()
      .from(ctx.database.schema.apikey)
      .where(eq(ctx.database.schema.apikey.name, "Accounted key"))
    // FR-KEY-1's last-used accounting is one of the things that lives only in
    // Better Auth's own endpoint, which is why the mint goes through it.
    expect(row?.lastRequest).toBeTruthy()
    expect(row?.requestCount ?? 0).toBeGreaterThan(0)
  })

  it("refuses a key whose owner has been banned — on a fresh mint", async () => {
    const key = await createKey("Banned owner key")
    await setBanned(true)
    try {
      const response = await proxy(
        new Request(`${ISSUER}/gateway/data`, { headers: { "x-api-key": key } })
      )
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: "invalid_api_key" })
    } finally {
      await setBanned(false)
    }
  })

  it("pins the D91 window in both directions", async () => {
    const key = await createKey("Cached key")

    // Warm the cache while the owner is fine.
    const first = await proxy(
      new Request(`${ISSUER}/gateway/data`, { headers: { "x-api-key": key } })
    )
    expect(first.status).toBe(200)

    await setBanned(true)
    try {
      // **The cost.** Inside the TTL the exchange is not repeated, so the ban
      // re-check does not run and the call still goes through. This is the
      // trade-off D91 records, and it is asserted rather than described so
      // that a change to it is visible in a diff.
      const cached = await proxy(
        new Request(`${ISSUER}/gateway/data`, {
          headers: { "x-api-key": key },
        })
      )
      expect(cached.status).toBe(200)

      // **The mitigation.** Every admin ban, removal and key revocation calls
      // exactly this (`admin/guard.ts`), so a revocation made through this
      // process bites on the next request rather than in ten minutes.
      resetGatewayTokenCache()
      const after = await proxy(
        new Request(`${ISSUER}/gateway/data`, {
          headers: { "x-api-key": key },
        })
      )
      expect(after.status).toBe(401)
    } finally {
      await setBanned(false)
    }
  })

  it("clears the cache when an administrator bans the owner", async () => {
    // The punch-through end to end, on the **API** path rather than the
    // button: the hook runs for every caller (**D67**), which is the whole
    // reason it lives in `admin/guard.ts` and not in a route handler.
    //
    // A second account, because the last-administrator invariant protects the
    // one this file signs in as — and a test whose subject may or may not have
    // been banned asserts nothing.
    const victim = await createOrdinaryUser("gateway-victim@example.com")
    const key = await createKeyAs(victim.cookie, "Victim key")

    expect(
      (
        await proxy(
          new Request(`${ISSUER}/gateway/data`, {
            headers: { "x-api-key": key },
          })
        )
      ).status,
      "the key works before the ban"
    ).toBe(200)

    const banned = await ctx.auth.handler(
      authRequest("/admin/ban-user", {
        headers: { cookie },
        json: { userId: victim.id, banReason: "gateway test" },
      })
    )
    expect(banned.status).toBe(200)

    // Without `resetGatewayTokenCache()` in the after-hook this is a 200 for
    // the next ten minutes, which is precisely the window D91 records.
    const after = await proxy(
      new Request(`${ISSUER}/gateway/data`, { headers: { "x-api-key": key } })
    )
    expect(after.status).toBe(401)
  })

  it("clears the cache when a key is revoked", async () => {
    const owner = await createOrdinaryUser("gateway-revoker@example.com")
    const key = await createKeyAs(owner.cookie, "Revoked key")
    expect(
      (
        await proxy(
          new Request(`${ISSUER}/gateway/data`, {
            headers: { "x-api-key": key },
          })
        )
      ).status
    ).toBe(200)

    const [row] = await ctx.database.db
      .select()
      .from(ctx.database.schema.apikey)
      .where(eq(ctx.database.schema.apikey.name, "Revoked key"))
    const revoked = await ctx.auth.handler(
      authRequest("/api-key/delete", {
        headers: { cookie: owner.cookie },
        json: { keyId: row!.id },
      })
    )
    expect(revoked.status).toBe(200)

    const after = await proxy(
      new Request(`${ISSUER}/gateway/data`, { headers: { "x-api-key": key } })
    )
    expect(after.status).toBe(401)
  })
})

describe("the session cookie as a credential (FR-GW-4, **D92**)", () => {
  it("exchanges it for a JWT the upstream can verify, and never forwards it", async () => {
    const response = await proxy(
      new Request(`${ISSUER}/gateway/data/me`, {
        headers: { cookie, "sec-fetch-site": "same-origin" },
      }),
      "data",
      "me"
    )
    expect(response.status).toBe(200)

    const authorization = lastRequest?.headers.authorization ?? ""
    const jwt = authorization.slice("Bearer ".length)
    await expect(
      jwtVerify(jwt, await jwks(), { issuer: ISSUER })
    ).resolves.toBeTruthy()

    const payload = decodeJwt(jwt)
    expect(payload.sub).toBe(userId)
    // **The discriminator.** A browser session says the IdP is presenting the
    // token; a key exchange says `apiKeys.tokenClientId`. An upstream that
    // cares which one it is talking to reads `azp`.
    expect(payload.azp).toBe("idp")
    expect(payload.azp).not.toBe("api-key-client")

    expect(lastRequest?.headers.cookie).toBeUndefined()
  })

  it("ignores it on a cross-site request", async () => {
    // `SameSite=Lax` still sends the cookie on a top-level GET navigation, so
    // without the Fetch-Metadata check a link would be a CSRF against every
    // upstream.
    const response = await proxy(
      new Request(`${ISSUER}/gateway/data`, {
        headers: { cookie, "sec-fetch-site": "cross-site" },
      })
    )
    expect(response.status).toBe(200)
    expect(lastRequest?.headers.authorization).toBeUndefined()
  })

  it("stops working the moment the browser signs out", async () => {
    const theirs = await createOrdinaryUser("gateway-signout@example.com")
    expect(
      (
        await proxy(
          new Request(`${ISSUER}/gateway/data`, {
            headers: { cookie: theirs.cookie },
          })
        )
      ).status
    ).toBe(200)
    expect(lastRequest?.headers.authorization).toBeTruthy()

    const out = await ctx.auth.handler(
      authRequest("/sign-out", {
        headers: { cookie: theirs.cookie },
        json: {},
      })
    )
    expect(out.status).toBe(200)

    // Without `/sign-out` in `ENDS_CREDENTIAL_ACCESS` this is still a 200 for
    // the next ten minutes, on a session that no longer exists (**D92**).
    forgetUpstream()
    const after = await proxy(
      new Request(`${ISSUER}/gateway/data`, {
        headers: { cookie: theirs.cookie },
      })
    )
    expect(after.status).toBe(200)
    expect(
      lastRequest?.headers.authorization,
      "a signed-out session is not a credential"
    ).toBeUndefined()
  })
})

describe("routing and streaming (FR-GW-3, FR-GW-6)", () => {
  it("answers 404 for a disabled gateway", async () => {
    const response = await proxy(
      new Request(`${ISSUER}/gateway/off`),
      "off"
    )
    expect(response.status).toBe(404)
  })

  it("streams a large request body through to the upstream", async () => {
    // The one thing a stubbed `fetchImpl` cannot show: the body is a
    // `ReadableStream` handed to a real `fetch` with `duplex: "half"`, and it
    // has to arrive at a socket on the other side intact.
    const payload = "x".repeat(512 * 1024)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        for (let index = 0; index < 8; index += 1) {
          controller.enqueue(encoder.encode(payload.slice(0, 64 * 1024)))
        }
        controller.close()
      },
    })

    const response = await proxy(
      new Request(`${ISSUER}/gateway/data/echo`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: stream,
        duplex: "half",
      } as RequestInit),
      "data",
      "echo"
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      url: "/echo",
      length: 8 * 64 * 1024,
    })
    expect(lastRequest?.body.length).toBe(8 * 64 * 1024)
  })
})
