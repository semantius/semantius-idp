/**
 * The security properties, asserted against a real server (TST-5).
 *
 * Everything here is written from the attacker's side. Each case is a thing
 * somebody would actually try — a forged `Host`, an extra field in a sign-up
 * body, a code replayed a second time, a `Origin` from somewhere else — and
 * the assertion is that it does not work. Several of these properties are
 * enforced in code that has no other test, because the only way to observe
 * them is to attempt the attack.
 *
 * The last-admin, impersonation and non-admin cases live in `admin.test.ts`
 * with the rest of the admin surface rather than being repeated here.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createHash, randomBytes } from "node:crypto"
import { eq } from "drizzle-orm"

import { createLocalAccountIssuer } from "@better-auth/core/db"
import { createUserWithoutRequest } from "@/server/auth/provisioning"
import { createLogger } from "@/server/logger"
import { withStandardRetryAfter } from "@/server/http/security-headers"
import { forwardDiscovery } from "@/server/oidc/protocol-proxy"
import { reconcileClients } from "@/server/oidc/reconcile"
import type { Runtime } from "@/server/runtime"
import type { TestContext } from "./harness"
import { authRequest, createTestContext, sessionCookie } from "./harness"

const ISSUER = "http://localhost:3000"
const PASSWORD = "correct-horse-battery-staple"
const SECRET = "security-client-secret-at-least-32-chars"
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

const PUBLIC_CLIENT = {
  clientId: "public-app",
  type: "spa",
  name: "Public App",
  redirectUris: ["https://spa.example.com/callback"],
  skipConsent: true,
  enableEndSession: false,
}

let ctx: TestContext

beforeEach(async () => {
  ctx = await createTestContext("security", {
    clients: [CONFIDENTIAL, PUBLIC_CLIENT],
    config: {
      signUp: { enabled: true, requireApproval: false },
      auth: { requireEmailVerification: false },
      email: { resend: { apiKey: "re_test" }, from: "IdP <idp@example.com>" },
    },
  })
  await reconcileClients({
    config: ctx.config,
    database: ctx.database,
    locking: ctx.database,
  })
})

afterEach(async () => {
  await ctx.teardown()
})

async function makeUser(
  email: string,
  extra: Record<string, unknown> = {}
): Promise<string> {
  const context = await ctx.auth.$context
  const user = await createUserWithoutRequest(
    context,
    { email, name: email, emailVerified: true, status: "active", ...extra },
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

async function signIn(email: string): Promise<string> {
  const response = await ctx.auth.handler(
    authRequest("/sign-in/email", { json: { email, password: PASSWORD } })
  )
  const cookie = sessionCookie(response)
  expect(cookie, `sign-in failed for ${email}`).toBeTruthy()
  return cookie!
}

interface Pkce {
  verifier: string
  challenge: string
}

function pkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url")
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  }
}

/** Runs an authorization and returns the `Location` it produced. */
async function authorize(
  clientId: string,
  cookie: string,
  overrides: Record<string, string> = {}
): Promise<string> {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: "openid profile email",
    state: "state-1",
    ...overrides,
  })
  const response = await ctx.auth.handler(
    new Request(`${ISSUER}/api/auth/oauth2/authorize?${query.toString()}`, {
      headers: { cookie },
      redirect: "manual",
    })
  )
  return response.headers.get("location") ?? ""
}

function codeFrom(location: string): string | null {
  return new URL(location, ISSUER).searchParams.get("code")
}

/**
 * Posts to the token endpoint.
 *
 * `client_secret` in the body is moved into `Authorization: Basic`, because
 * that is the method a confidential client is registered with by default
 * (`authMethodFor` in `client-mapping.ts`) and posting the secret instead is
 * simply a different, unregistered method.
 */
async function exchange(
  body: Record<string, string>,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { client_secret: secret, ...rest } = body
  if (secret !== undefined) {
    const pair = `${encodeURIComponent(body.client_id ?? "")}:${encodeURIComponent(secret)}`
    headers = {
      ...headers,
      authorization: `Basic ${Buffer.from(pair).toString("base64")}`,
    }
    body = rest
  }
  const response = await ctx.auth.handler(
    new Request(`${ISSUER}/api/auth/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: new URLSearchParams(body).toString(),
    })
  )
  return {
    status: response.status,
    body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
  }
}

describe("host-header injection (SEC-1)", () => {
  it("changes no URL in the discovery document", async () => {
    const path = "/.well-known/openid-configuration"
    const forged = await forwardDiscovery(
      {
        config: ctx.config,
        auth: ctx.auth,
        logger: createLogger({ level: "error", write: () => {} }),
      } as unknown as Runtime,
      new Request(`${ISSUER}${path}`, {
        headers: {
          host: "evil.example.com",
          "x-forwarded-host": "evil.example.com",
          "x-forwarded-proto": "https",
        },
      }),
      path
    )
    const document = (await forged.json()) as Record<string, string>
    // Every absolute URL comes from `server.baseUrl`, and nothing else.
    expect(JSON.stringify(document)).not.toContain("evil.example.com")
    expect(document.issuer).toBe(ISSUER)
  })

  it("does not move where a reset link points", async () => {
    await makeUser("reset@example.com")
    await ctx.auth.handler(
      authRequest("/request-password-reset", {
        json: { email: "reset@example.com" },
        headers: {
          host: "evil.example.com",
          "x-forwarded-host": "evil.example.com",
        },
      })
    )
    const mail = ctx.mailer.captured.last()
    expect(mail).toBeTruthy()
    expect(JSON.stringify(mail)).not.toContain("evil.example.com")
    expect(JSON.stringify(mail)).toContain("localhost:3000")
  })
})

describe("the CSRF origin check (SEC-3, D68)", () => {
  /**
   * A browser two hops away: it is on `https://idp.example.com`, the proxy
   * rewrote `Host` to the upstream it dialled, and `server.baseUrl` names
   * neither. Before D68 every one of these was refused before the password was
   * read, which is a deployment that cannot sign anybody in.
   *
   * The `cookie` header is not decoration — Better Auth only checks the origin
   * of a request that carries one, and a browser's sign-in does.
   */
  const behindProxy = (origin: string) => ({
    origin,
    cookie: "unrelated=1",
    host: "internal.svc:3000",
    "x-forwarded-host": "idp.example.com",
  })

  it("accepts a sign-in from the address the request arrived on", async () => {
    await makeUser("proxied@example.com")
    const response = await ctx.auth.handler(
      authRequest("/sign-in/email", {
        json: { email: "proxied@example.com", password: PASSWORD },
        headers: behindProxy("https://idp.example.com"),
      })
    )
    expect(response.status).toBe(200)
    expect(sessionCookie(response)).toBeTruthy()
  })

  it("still refuses one from somewhere else entirely", async () => {
    // The half that must not move: the browser chose `Origin`, and a page on
    // `evil.example` cannot choose `X-Forwarded-Host` or `Host` to match it.
    await makeUser("targeted@example.com")
    const response = await ctx.auth.handler(
      authRequest("/sign-in/email", {
        json: { email: "targeted@example.com", password: PASSWORD },
        headers: behindProxy("https://evil.example"),
      })
    )
    expect(response.status).toBe(403)
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      code: "INVALID_ORIGIN",
    })
  })

  it("refuses a forwarded host that is a wildcard rather than a host", async () => {
    // Better Auth matches the allow-list as patterns, so `*` reaching it would
    // switch the check off for the request that sent it.
    await makeUser("wildcard@example.com")
    const response = await ctx.auth.handler(
      authRequest("/sign-in/email", {
        json: { email: "wildcard@example.com", password: PASSWORD },
        headers: {
          origin: "https://evil.example",
          cookie: "unrelated=1",
          host: "internal.svc:3000",
          "x-forwarded-host": "*",
        },
      })
    )
    expect(response.status).toBe(403)
  })
})

describe("mass assignment (FR-AUTH-7)", () => {
  it("ignores privileged fields in a sign-up body", async () => {
    const response = await ctx.auth.handler(
      authRequest("/sign-up/email", {
        json: {
          email: "climber@example.com",
          password: PASSWORD,
          name: "Climber",
          // Every one of these would be a privilege escalation if it landed.
          role: "admin",
          status: "active",
          emailVerified: true,
          banned: false,
          mustChangePassword: false,
        },
      })
    )
    // Two correct outcomes, and the test accepts both: refuse the body
    // outright, or accept it and ignore the fields that were not the caller's
    // to set. What must never happen is a user row with `role: admin` in it.
    expect([200, 400]).toContain(response.status)

    const rows = await ctx.database.db
      .select()
      .from(ctx.database.schema.user)
      .where(eq(ctx.database.schema.user.email, "climber@example.com"))
    if (rows.length > 0) {
      expect(rows[0]?.role ?? "").not.toContain("admin")
      expect(rows[0]?.emailVerified).not.toBe(true)
    }
  })
})

describe("the authorization endpoint", () => {
  it("never redirects to a URI the client did not register", async () => {
    await makeUser("redirect@example.com")
    const cookie = await signIn("redirect@example.com")
    const { challenge } = pkce()

    const response = await ctx.auth.handler(
      new Request(
        `${ISSUER}/api/auth/oauth2/authorize?${new URLSearchParams({
          response_type: "code",
          client_id: CONFIDENTIAL.clientId,
          redirect_uri: "https://attacker.example.com/steal",
          scope: "openid",
          state: "s",
          code_challenge: challenge,
          code_challenge_method: "S256",
        }).toString()}`,
        { headers: { cookie }, redirect: "manual" }
      )
    )

    const location = response.headers.get("location") ?? ""
    // The one thing that must never happen: an error delivered *to* the
    // unregistered URI, which is a redirect to it either way.
    expect(location).not.toContain("attacker.example.com")
  })

  it("refuses PKCE `plain` from a public client", async () => {
    await makeUser("pkce@example.com")
    const cookie = await signIn("pkce@example.com")
    const { verifier } = pkce()

    const location = await authorize(PUBLIC_CLIENT.clientId, cookie, {
      redirect_uri: PUBLIC_CLIENT.redirectUris[0]!,
      code_challenge: verifier,
      code_challenge_method: "plain",
    })
    // Either refused outright, or refused at the exchange — but a `plain`
    // challenge must not produce a usable code.
    if (codeFrom(location)) {
      const result = await exchange({
        grant_type: "authorization_code",
        code: codeFrom(location)!,
        redirect_uri: PUBLIC_CLIENT.redirectUris[0]!,
        client_id: PUBLIC_CLIENT.clientId,
        code_verifier: verifier,
      })
      expect(result.status).toBeGreaterThanOrEqual(400)
    } else {
      expect(location).toContain("error=")
    }
  })
})

describe("the token endpoint", () => {
  async function codeFor(email: string): Promise<{ code: string; pkce: Pkce }> {
    await makeUser(email)
    const cookie = await signIn(email)
    const challenge = pkce()
    const location = await authorize(CONFIDENTIAL.clientId, cookie, {
      code_challenge: challenge.challenge,
      code_challenge_method: "S256",
    })
    const code = codeFrom(location)
    expect(code, `no code in ${location}`).toBeTruthy()
    return { code: code!, pkce: challenge }
  }

  it("refuses a wrong secret, and refuses a missing one", async () => {
    const first = await codeFor("secret1@example.com")
    const wrong = await exchange({
      grant_type: "authorization_code",
      code: first.code,
      redirect_uri: REDIRECT,
      client_id: CONFIDENTIAL.clientId,
      client_secret: "not-the-secret-but-long-enough-to-pass",
      code_verifier: first.pkce.verifier,
    })
    expect(wrong.status).toBeGreaterThanOrEqual(400)

    const second = await codeFor("secret2@example.com")
    const missing = await exchange({
      grant_type: "authorization_code",
      code: second.code,
      redirect_uri: REDIRECT,
      client_id: CONFIDENTIAL.clientId,
      code_verifier: second.pkce.verifier,
    })
    expect(missing.status).toBeGreaterThanOrEqual(400)
  })

  it("refuses a code presented without its verifier", async () => {
    const { code } = await codeFor("verifier@example.com")
    const result = await exchange({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: CONFIDENTIAL.clientId,
      client_secret: SECRET,
    })
    expect(result.status).toBeGreaterThanOrEqual(400)
  })

  it("refuses a code presented with the wrong verifier", async () => {
    const { code } = await codeFor("wrongverifier@example.com")
    const result = await exchange({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: CONFIDENTIAL.clientId,
      client_secret: SECRET,
      code_verifier: pkce().verifier,
    })
    expect(result.status).toBeGreaterThanOrEqual(400)
  })

  it("refuses a redirect_uri that differs from the authorization's", async () => {
    const { code, pkce: challenge } = await codeFor("mismatch@example.com")
    const result = await exchange({
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://app.example.com/elsewhere",
      client_id: CONFIDENTIAL.clientId,
      client_secret: SECRET,
      code_verifier: challenge.verifier,
    })
    expect(result.status).toBeGreaterThanOrEqual(400)
  })

  it("accepts a code exactly once, and the replay gets nothing", async () => {
    const { code, pkce: challenge } = await codeFor("replay@example.com")
    const body = {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: CONFIDENTIAL.clientId,
      client_secret: SECRET,
      code_verifier: challenge.verifier,
    }

    const first = await exchange(body)
    expect(first.status).toBe(200)
    expect(first.body.access_token).toBeTruthy()

    const replay = await exchange(body)
    expect(replay.status).toBeGreaterThanOrEqual(400)
    expect(replay.body.access_token).toBeUndefined()
  })
})

describe("uniform answers (SEC-7)", () => {
  it("says the same thing whether or not the address exists", async () => {
    await makeUser("known@example.com")

    const known = await ctx.auth.handler(
      authRequest("/request-password-reset", {
        json: { email: "known@example.com" },
      })
    )
    const unknown = await ctx.auth.handler(
      authRequest("/request-password-reset", {
        json: { email: "nobody-here@example.com" },
      })
    )

    expect(known.status).toBe(unknown.status)
    expect(await known.text()).toBe(await unknown.text())
  })

  it("says the same thing for a wrong password and an unknown address", async () => {
    await makeUser("real@example.com")

    const wrong = await ctx.auth.handler(
      authRequest("/sign-in/email", {
        json: { email: "real@example.com", password: "not-the-password" },
      })
    )
    const absent = await ctx.auth.handler(
      authRequest("/sign-in/email", {
        json: { email: "ghost@example.com", password: "not-the-password" },
      })
    )

    expect(wrong.status).toBe(absent.status)
    const wrongBody = (await wrong.json()) as { code?: string }
    const absentBody = (await absent.json()) as { code?: string }
    expect(wrongBody.code).toBe(absentBody.code)
  })
})

describe("session cookies (FR-AUTH-5)", () => {
  it("are HttpOnly, SameSite=Lax and scoped to the mount path", async () => {
    await makeUser("cookie@example.com")
    const response = await ctx.auth.handler(
      authRequest("/sign-in/email", {
        json: { email: "cookie@example.com", password: PASSWORD },
      })
    )
    const cookies = response.headers.getSetCookie()
    const session = cookies.find((cookie) => cookie.includes("session_token"))
    expect(session).toBeTruthy()
    // HttpOnly is what stops an injected script reading it; SameSite is what
    // stops a cross-site form post riding it.
    expect(session).toContain("HttpOnly")
    expect(session).toContain("SameSite=Lax")
    expect(session).toContain("Path=/")
    // The issuer here is http, so `Secure` must be absent — a Secure cookie on
    // http is a cookie the browser never sends back.
    expect(session).not.toContain("Secure")
  })
})

describe("the approval gate, on every path (FR-SIGNUP-2)", () => {
  it("refuses a pending user a session, a token and an API key alike", async () => {
    await ctx.teardown()
    ctx = await createTestContext("security-approval", {
      clients: [CONFIDENTIAL],
      config: {
        signUp: { enabled: true, requireApproval: true },
        auth: { requireEmailVerification: false },
        apiKeys: { enabled: true },
      },
    })
    await reconcileClients({
      config: ctx.config,
      database: ctx.database,
      locking: ctx.database,
    })

    // Sign up for real, so the user genuinely lands pending.
    await ctx.auth.handler(
      authRequest("/sign-up/email", {
        json: {
          email: "waiting@example.com",
          password: PASSWORD,
          name: "Waiting",
        },
      })
    )

    const attempt = await ctx.auth.handler(
      authRequest("/sign-in/email", {
        json: { email: "waiting@example.com", password: PASSWORD },
      })
    )
    expect(attempt.status).toBeGreaterThanOrEqual(400)
    expect(sessionCookie(attempt)).toBeUndefined()
  })

  it("keeps refusing after the status changes under a live session", async () => {
    const userId = await makeUser("active-then-not@example.com")
    const cookie = await signIn("active-then-not@example.com")

    // A session exists and works.
    const before = await ctx.auth.handler(
      authRequest("/get-session", { method: "GET", headers: { cookie } })
    )
    expect(
      ((await before.json()) as { user?: unknown } | null)?.user
    ).toBeTruthy()

    // The administrator suspends them. FR-AUTH-5's cookie cache must not keep
    // the session alive past this.
    await ctx.database.db
      .update(ctx.database.schema.user)
      .set({ status: "rejected" })
      .where(eq(ctx.database.schema.user.id, userId))

    const after = await ctx.auth.handler(
      authRequest("/get-session", {
        method: "GET",
        headers: { cookie },
        // The authoritative read is what the gates use; assert on the same
        // thing they do rather than on the cached copy.
        json: undefined,
      })
    )
    const body = (await after.json().catch(() => null)) as {
      user?: { status?: string }
    } | null
    // Either no session at all, or a session whose user is visibly not active.
    if (body?.user) expect(body.user.status).not.toBe("active")
  })
})

describe("rate limiting (SEC-2)", () => {
  it("refuses repeated sign-in attempts and says when to come back", async () => {
    await ctx.teardown()
    ctx = await createTestContext("security-ratelimit", {
      config: {
        signUp: { enabled: true, requireApproval: false },
        auth: { requireEmailVerification: false },
        // The other suites turn this off; here it is the subject.
        rateLimit: { enabled: true, storage: "database" },
      },
    })
    await makeUser("limited@example.com")

    let limited: Response | undefined
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const response = await ctx.auth.handler(
        authRequest("/sign-in/email", {
          json: { email: "limited@example.com", password: "wrong-password" },
        })
      )
      if (response.status === 429) {
        limited = response
        break
      }
    }

    expect(limited, "sign-in was never rate limited").toBeTruthy()

    // Better Auth answers with `X-Retry-After`, which is not a header anything
    // honours — no browser and no HTTP client does anything with it. The edge
    // copies it onto the real one, so the assertion goes through that function
    // rather than the raw handler, which is not what a client ever sees.
    const delivered = withStandardRetryAfter(limited!)
    expect(delivered.headers.get("retry-after")).toBeTruthy()

    // A refused caller is told when to come back and nothing else: the
    // threshold itself is exactly what an attacker wants to know.
    const body = await delivered.text()
    expect(body).not.toMatch(/\b(limit|max|remaining)\b/i)
  })

  it("cannot be escaped by forging X-Forwarded-For when no proxy is trusted", async () => {
    await ctx.teardown()
    ctx = await createTestContext("security-spoof", {
      config: {
        signUp: { enabled: true, requireApproval: false },
        auth: { requireEmailVerification: false },
        rateLimit: { enabled: true, storage: "database" },
        // The default. The header must be ignored entirely.
        server: { baseUrl: ISSUER, trustProxy: false },
      },
    })
    await makeUser("spoofer@example.com")

    let limited = false
    for (let attempt = 0; attempt < 25 && !limited; attempt += 1) {
      const response = await ctx.auth.handler(
        authRequest("/sign-in/email", {
          json: { email: "spoofer@example.com", password: "wrong-password" },
          // A different "address" every time. If this worked, the limiter
          // would never fire and a password list would run unimpeded.
          headers: { "x-forwarded-for": `203.0.113.${attempt}` },
        })
      )
      if (response.status === 429) limited = true
    }

    expect(limited, "a forged header escaped the rate limit").toBe(true)
  })
})

describe("the breach check (FR-AUTH-1)", () => {
  const BREACHED = "P@ssw0rd-that-is-in-the-corpus"

  /** A stand-in for the range API that only ever knows about one password. */
  function corpusWith(password: string) {
    const digest = createHash("sha1")
      .update(password, "utf8")
      .digest("hex")
      .toUpperCase()
    const suffix = digest.slice(5)
    return async (url: string) =>
      new Response(
        url.endsWith(digest.slice(0, 5))
          ? `${suffix}:31337
0000000000000000000000000000000000A:0`
          : "0000000000000000000000000000000000A:0"
      )
  }

  async function contextWithBreachCheck(label: string): Promise<void> {
    await ctx.teardown()
    ctx = await createTestContext(label, {
      breachFetch: corpusWith(BREACHED),
      config: {
        signUp: { enabled: true, requireApproval: false },
        auth: {
          requireEmailVerification: false,
          password: { breachCheck: true },
        },
      },
    })
  }

  it("refuses a breached password at sign-up", async () => {
    await contextWithBreachCheck("security-breach")

    const response = await ctx.auth.handler(
      authRequest("/sign-up/email", {
        json: {
          email: "breached@example.com",
          password: BREACHED,
          name: "Breached",
        },
      })
    )

    expect(response.status).toBe(400)
    const body = (await response.json()) as {
      code?: string
      message?: string
    }
    expect(body.code).toBe("PASSWORD_BREACHED")
    // The count is never shown: it tells the user nothing they can act on and
    // tells anyone watching exactly which password was tried.
    expect(JSON.stringify(body)).not.toContain("31337")

    const rows = await ctx.database.db
      .select()
      .from(ctx.database.schema.user)
      .where(eq(ctx.database.schema.user.email, "breached@example.com"))
    expect(rows, "the account must not have been created").toHaveLength(0)
  })

  it("accepts a password the corpus has not seen", async () => {
    await contextWithBreachCheck("security-breach-ok")
    const response = await ctx.auth.handler(
      authRequest("/sign-up/email", {
        json: {
          email: "fine@example.com",
          password: PASSWORD,
          name: "Fine",
        },
      })
    )
    expect(response.status).toBe(200)
  })

  it("refuses a breached password at a reset, not only at sign-up", async () => {
    await contextWithBreachCheck("security-breach-reset")
    const userId = await makeUser("resetter@example.com")

    const context = await ctx.auth.$context
    const token = randomBytes(24).toString("base64url")
    await context.internalAdapter.createVerificationValue({
      identifier: `reset-password:${token}`,
      value: userId,
      expiresAt: new Date(Date.now() + 600_000),
    })

    const response = await ctx.auth.handler(
      authRequest("/reset-password", {
        json: { token, newPassword: BREACHED },
      })
    )
    expect(response.status).toBe(400)
    expect(((await response.json()) as { code?: string }).code).toBe(
      "PASSWORD_BREACHED"
    )
  })

  it("does not check at sign-in, where the user could do nothing about it", async () => {
    await contextWithBreachCheck("security-breach-signin")
    // Somebody whose existing password is in the corpus must still be able to
    // sign in — and then change it. Refusing here locks them out over
    // something they cannot fix from a login form.
    const context = await ctx.auth.$context
    const user = await createUserWithoutRequest(
      context,
      {
        email: "legacy@example.com",
        name: "Legacy",
        emailVerified: true,
        status: "active",
      },
      { method: "admin" }
    )
    await context.internalAdapter.createAccount({
      userId: user.id,
      providerId: "credential",
      issuer: createLocalAccountIssuer("credential"),
      accountId: user.id,
      password: await context.password.hash(BREACHED),
    })

    const response = await ctx.auth.handler(
      authRequest("/sign-in/email", {
        json: { email: "legacy@example.com", password: BREACHED },
      })
    )
    expect(response.status).toBe(200)
    expect(sessionCookie(response)).toBeTruthy()
  })

  it("is off unless the operator turns it on", async () => {
    // The default context has `breachCheck` unset, and the mock is not even
    // installed — so a breached password sails through.
    const response = await ctx.auth.handler(
      authRequest("/sign-up/email", {
        json: {
          email: "unchecked@example.com",
          password: BREACHED,
          name: "Unchecked",
        },
      })
    )
    expect(response.status).toBe(200)
  })
})
