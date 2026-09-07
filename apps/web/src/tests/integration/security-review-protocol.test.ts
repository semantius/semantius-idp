/**
 * Security review, stream S3: the protocol endpoints, rate limiting and the
 * role catalog.
 *
 * Every case here is written from the attacker's side and each one failed on
 * the code it was written against:
 *
 *  - the token endpoint's per-client bucket could be emptied by anyone who
 *    could *name* the client;
 *  - Better Auth's own address resolver disagreed with `clientIpFrom`, so a
 *    two-hop chain under `trustProxy: true` put every user of the deployment
 *    in one sign-in bucket, and `/setup` keyed on an address that had already
 *    been anonymized away;
 *  - the admin plugin accepted any string as a role, comma included, because
 *    it was never handed the catalog.
 */

import { afterEach, describe, expect, it } from "vitest"

import { createHash, randomBytes } from "node:crypto"
import { like } from "drizzle-orm"

import { createLocalAccountIssuer } from "@better-auth/core/db"
import { Route as SetupRoute } from "@/routes/setup"
import { Route as TokenRoute } from "@/routes/oauth2/token"
import { createUserWithoutRequest } from "@/server/auth/provisioning"
import {
  SOCKET_ADDRESS_HEADER,
  resolveClientAddress,
} from "@/server/http/client-ip"
import { withRequestContext } from "@/server/http/request-log"
import { reconcileClients } from "@/server/oidc/reconcile"
import { setRuntime } from "@/server/runtime"
import type { TestContext } from "./harness"
import {
  asRuntime,
  authRequest,
  createTestContext,
  sessionCookie,
} from "./harness"

const ISSUER = "http://localhost:3000"
const PASSWORD = "correct-horse-battery-staple"
const SECRET = "review-client-secret-at-least-32-chars-long"
const REDIRECT = "https://app.example.com/callback"

const CONFIDENTIAL = {
  clientId: "confidential-app",
  type: "web",
  name: "Confidential App",
  clientSecret: SECRET,
  redirectUris: [REDIRECT],
  skipConsent: true,
  enableEndSession: false,
}

let ctx: TestContext

afterEach(async () => {
  await ctx.teardown()
})

async function limitedContext(
  label: string,
  server: Record<string, unknown> = { baseUrl: ISSUER, trustProxy: true }
): Promise<TestContext> {
  const context = await createTestContext(label, {
    clients: [CONFIDENTIAL],
    config: {
      signUp: { enabled: true, requireApproval: false },
      auth: { requireEmailVerification: false },
      rateLimit: { enabled: true, storage: "database" },
      server,
    },
  })
  await reconcileClients({
    config: context.config,
    database: context.database,
    locking: context.database,
  })
  return context
}

/** Creates a user directly, so the test controls status and roles exactly. */
async function makeUser(email: string, role = "user"): Promise<string> {
  const context = await ctx.auth.$context
  const user = await createUserWithoutRequest(
    context,
    { email, name: email, emailVerified: true, role, status: "active" },
    { method: "admin" }
  )
  await context.internalAdapter.createAccount({
    userId: user.id,
    providerId: "credential",
    issuer: createLocalAccountIssuer("credential"),
    accountId: user.id,
    password: await context.password.hash(PASSWORD),
  })
  return user.id
}

type Handler = (input: { request: Request }) => Promise<Response>

function postHandler(route: typeof TokenRoute | typeof SetupRoute): Handler {
  const handlers = route.options.server?.handlers as
    | { POST?: unknown }
    | undefined
  if (typeof handlers?.POST !== "function") {
    throw new Error("the route has no POST handler in record form")
  }
  return handlers.POST as Handler
}

/** Our own buckets, by key prefix. */
async function bucketRows(prefix: string) {
  const { rateLimit } = ctx.database.schema
  return ctx.database.db
    .select({ key: rateLimit.key, count: rateLimit.count })
    .from(rateLimit)
    .where(like(rateLimit.key, `${prefix}%`))
    .orderBy(rateLimit.key)
}

/** A distinct public address for attempt `n`. */
function addressFor(n: number): string {
  return `198.${18 + Math.floor(n / 65536)}.${Math.floor(n / 256) % 256}.${n % 256}`
}

/**
 * A token request as the edge would deliver it: the socket header stamped
 * with the resolved address and the request context carrying it un-anonymized.
 */
async function postToken(
  params: Record<string, string>,
  secret: string,
  address: string
): Promise<Response> {
  const request = new Request(`${ISSUER}/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: ISSUER,
      authorization: `Basic ${Buffer.from(`${CONFIDENTIAL.clientId}:${secret}`).toString("base64")}`,
      "x-forwarded-for": address,
      [SOCKET_ADDRESS_HEADER]: address,
    },
    body: new URLSearchParams(params).toString(),
  })
  return withRequestContext({ requestId: "review", clientIp: address }, () =>
    postHandler(TokenRoute)({ request })
  )
}

async function signedInCookie(email: string): Promise<string> {
  await makeUser(email)
  const response = await ctx.auth.handler(
    authRequest("/sign-in/email", { json: { email, password: PASSWORD } })
  )
  const cookie = sessionCookie(response)
  expect(cookie, `sign-in failed for ${email}`).toBeTruthy()
  return cookie!
}

async function authorizationCode(
  cookie: string
): Promise<{ code: string; verifier: string }> {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const query = new URLSearchParams({
    response_type: "code",
    client_id: CONFIDENTIAL.clientId,
    redirect_uri: REDIRECT,
    scope: "openid profile email",
    state: "state",
    code_challenge: challenge,
    code_challenge_method: "S256",
  })
  const response = await ctx.auth.handler(
    new Request(`${ISSUER}/api/auth/oauth2/authorize?${query.toString()}`, {
      headers: { cookie },
      redirect: "manual",
    })
  )
  const url = new URL(response.headers.get("location") ?? "", ISSUER)
  expect(url.searchParams.get("error")).toBeNull()
  return { code: url.searchParams.get("code") ?? "", verifier }
}

describe("the token endpoint's per-client bucket", () => {
  it("cannot be exhausted by callers who do not hold the client's secret", async () => {
    ctx = await limitedContext("secrev-token-bucket")
    setRuntime(asRuntime(ctx))

    // A distributed guesser: every attempt names the victim client and
    // arrives from its own address, so no per-address rule is what stops it.
    // 601 is one past the per-client maximum.
    for (let attempt = 0; attempt <= 600; attempt += 1) {
      const response = await postToken(
        { grant_type: "refresh_token", refresh_token: "junk" },
        "not-the-secret",
        addressFor(attempt)
      )
      expect(response.status, `attempt ${attempt}`).not.toBe(429)
    }

    // The client itself, with its real secret, is untouched by all of that.
    const cookie = await signedInCookie("holder@example.com")
    const { code, verifier } = await authorizationCode(cookie)
    const exchanged = await postToken(
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      },
      SECRET,
      "203.0.113.200"
    )
    expect(exchanged.status, await exchanged.clone().text()).toBe(200)

    // Only the grant the provider accepted counted against the client.
    const [row] = await bucketRows(`idp:oauth2_token:${CONFIDENTIAL.clientId}`)
    expect(row?.count).toBe(1)
  }, 180_000)

  it("throttles credential guessing against one client from one address", async () => {
    ctx = await limitedContext("secrev-token-guess")
    setRuntime(asRuntime(ctx))

    let limited: Response | undefined
    for (let attempt = 0; attempt < 40 && !limited; attempt += 1) {
      const response = await postToken(
        { grant_type: "refresh_token", refresh_token: "junk" },
        "not-the-secret",
        "203.0.113.77"
      )
      if (response.status === 429) limited = response
    }
    expect(limited, "guessing was never refused").toBeTruthy()
    expect(limited!.headers.get("retry-after")).toBeTruthy()

    // Refused attempts are keyed on the address AND the client, never on the
    // client alone.
    const rows = await bucketRows("idp:oauth2_token")
    expect(rows.map((row) => row.key)).toEqual([
      `idp:oauth2_token_attempt:203.0.113.77:${CONFIDENTIAL.clientId}`,
    ])
  })
})

describe("rate-limit keys follow the edge's resolved address", () => {
  async function signInAttempt(
    email: string,
    forwardedFor: string,
    socket = "10.0.0.1"
  ): Promise<Response> {
    const inbound = authRequest("/sign-in/email", {
      json: { email, password: "wrong-password" },
      headers: {
        "x-forwarded-for": forwardedFor,
        [SOCKET_ADDRESS_HEADER]: socket,
      },
    })
    // What `server-entry.ts` does before the request reaches the handler.
    const { request } = resolveClientAddress(
      inbound,
      ctx.config.file.server.trustProxy
    )
    return ctx.auth.handler(request)
  }

  async function exhaust(email: string, forwardedFor: string): Promise<void> {
    let limited = false
    for (let attempt = 0; attempt < 25 && !limited; attempt += 1) {
      limited = (await signInAttempt(email, forwardedFor)).status === 429
    }
    expect(limited, `${forwardedFor} was never rate limited`).toBe(true)
  }

  it("keeps two clients behind two hops apart under trustProxy: true", async () => {
    ctx = await limitedContext("secrev-two-hops")
    await makeUser("hops@example.com")

    // Traefik → Caddy: the browser's address is the leftmost entry.
    await exhaust("hops@example.com", "203.0.113.5, 10.0.0.2")
    const other = await signInAttempt(
      "hops@example.com",
      "203.0.113.6, 10.0.0.2"
    )
    expect(
      other.status,
      "a second client shared the first one's bucket"
    ).not.toBe(429)
  })

  it("keeps two clients apart under a CIDR list", async () => {
    ctx = await limitedContext("secrev-cidr", {
      baseUrl: ISSUER,
      trustProxy: ["10.0.0.0/8"],
    })
    await makeUser("cidr@example.com")

    await exhaust("cidr@example.com", "203.0.113.5, 10.0.0.2")
    const other = await signInAttempt(
      "cidr@example.com",
      "203.0.113.6, 10.0.0.2"
    )
    expect(other.status).not.toBe(429)
  })

  it("puts two IPv6 addresses from one /64 in the same bucket", async () => {
    ctx = await limitedContext("secrev-ipv6")
    await makeUser("six@example.com")

    await exhaust("six@example.com", "2001:db8:1:2::1")
    // A /64 is one subscriber; rotating the low bits must not buy a new bucket.
    const sibling = await signInAttempt("six@example.com", "2001:db8:1:2::2")
    expect(sibling.status).toBe(429)
  })

  it("keys /setup on the caller's un-anonymized address, IPv6 masked to its /64", async () => {
    ctx = await limitedContext("secrev-setup-key")
    setRuntime(asRuntime(ctx))

    const post = (clientIp: string) =>
      withRequestContext({ requestId: "review", clientIp }, () =>
        postHandler(SetupRoute)({
          request: new Request(`${ISSUER}/setup`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            // Empty on purpose: the bucket is consumed before validation.
            body: "",
          }),
        })
      )
    await post("2001:db8:1:2::1")
    await post("2001:db8:1:2::2")
    await post("203.0.113.9")

    expect(await bucketRows("idp:setup:")).toEqual([
      { key: "idp:setup:2001:db8:1:2::/64", count: 2 },
      { key: "idp:setup:203.0.113.9", count: 1 },
    ])
  })
})

describe("the role catalog is enforced on write", () => {
  async function post(
    path: string,
    json: unknown,
    cookie: string
  ): Promise<{ status: number; code?: string }> {
    const response = await ctx.auth.handler(
      authRequest(path, { json, headers: { cookie } })
    )
    const body = (await response.json().catch(() => null)) as {
      code?: string
    } | null
    return {
      status: response.status,
      ...(body?.code ? { code: body.code } : {}),
    }
  }

  it("refuses a role outside the catalog, and a comma-joined pair", async () => {
    ctx = await createTestContext("secrev-role-catalog", {
      config: {
        signUp: { enabled: true, requireApproval: false },
        auth: { requireEmailVerification: false },
      },
    })
    await makeUser("boss@example.com", "admin")
    const target = await makeUser("staff@example.com")
    const response = await ctx.auth.handler(
      authRequest("/sign-in/email", {
        json: { email: "boss@example.com", password: PASSWORD },
      })
    )
    const cookie = sessionCookie(response)!

    for (const role of ["ghost", "admin,user", ["ghost", "user"]]) {
      const refused = await post(
        "/admin/set-role",
        { userId: target, role },
        cookie
      )
      expect(refused.status, JSON.stringify(role)).toBe(400)
      expect(refused.code).toBe("YOU_ARE_NOT_ALLOWED_TO_SET_NON_EXISTENT_VALUE")
    }
    const patched = await post(
      "/admin/update-user",
      { userId: target, data: { role: "ghost" } },
      cookie
    )
    expect(patched.status).toBe(400)

    // The catalog's own roles, as an array, still work — and are stored in
    // the comma-joined form the rest of the process reads.
    expect(
      (
        await post(
          "/admin/set-role",
          { userId: target, role: ["admin", "user"] },
          cookie
        )
      ).status
    ).toBe(200)
    const { user } = ctx.database.schema
    const [row] = await ctx.database.db
      .select({ role: user.role })
      .from(user)
      .where(like(user.email, "staff@example.com"))
    expect(row?.role).toBe("admin,user")
  })
})
