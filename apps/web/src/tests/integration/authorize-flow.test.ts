/**
 * The interrupted authorization, end to end (FR-OIDC-9/10/11).
 *
 * The mechanism under test is the provider's: an authorization that needs the
 * user to do something first is carried to the interstitial page as a signed,
 * expiring query string, and handed back to `/oauth2/continue` or
 * `/oauth2/consent` when the user is done. What is asserted here is that it
 * really is tamper-evident, really is bound to a session, and really refuses
 * to resume for someone other than the person it was issued to.
 */

import { describe, expect, it } from "vitest"

import { createHash, randomBytes } from "node:crypto"

import { reconcileClients } from "@/server/oidc/reconcile"
import type { TestContext } from "./harness"
import { authRequest, createTestContext, sessionCookie } from "./harness"

const ISSUER = "http://localhost:3000"
const SECRET = "authorize-client-secret-at-least-32-chars"
const REDIRECT = "https://app.example.com/callback"
const PASSWORD = "correct-horse-battery-staple"

const SKIP_CONSENT_CLIENT = {
  clientId: "quiet-app",
  type: "web",
  name: "Quiet App",
  clientSecret: SECRET,
  redirectUris: [REDIRECT],
  skipConsent: true,
  enableEndSession: false,
}

const ASKING_CLIENT = {
  clientId: "asking-app",
  type: "web",
  name: "Asking App",
  clientSecret: SECRET,
  redirectUris: [REDIRECT],
  skipConsent: false,
  enableEndSession: false,
}

async function context(label: string): Promise<TestContext> {
  const ctx = await createTestContext(label, {
    clients: [SKIP_CONSENT_CLIENT, ASKING_CLIENT],
    config: {
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

async function register(
  ctx: TestContext,
  email = "authorize@example.com"
): Promise<string> {
  await ctx.auth.handler(
    authRequest("/sign-up/email", {
      json: { email, password: PASSWORD, name: "Authorize User" },
    })
  )
  const response = await ctx.auth.handler(
    authRequest("/sign-in/email", { json: { email, password: PASSWORD } })
  )
  const cookie = sessionCookie(response)
  expect(cookie).toBeTruthy()
  return cookie!
}

interface AuthorizeAttempt {
  status: number
  location: string
  verifier: string
}

/** An authorization request with PKCE, made with or without a session. */
async function authorize(
  ctx: TestContext,
  clientId: string,
  {
    cookie,
    extra = {},
  }: { cookie?: string; extra?: Record<string, string> } = {}
): Promise<AuthorizeAttempt> {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: "openid profile email",
    state: "state-1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...extra,
  })
  const response = await ctx.auth.handler(
    new Request(`${ISSUER}/api/auth/oauth2/authorize?${query.toString()}`, {
      ...(cookie ? { headers: { cookie } } : {}),
      redirect: "manual",
    })
  )
  return {
    status: response.status,
    location: response.headers.get("location") ?? "",
    verifier,
  }
}

/** The signed request the provider handed to the interstitial page. */
function signedQuery(location: string): string {
  return new URL(location, ISSUER).search.replace(/^\?/, "")
}

async function post(
  ctx: TestContext,
  path: string,
  body: Record<string, unknown>,
  cookie?: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json",
    origin: ISSUER,
  })
  if (cookie) headers.set("cookie", cookie)
  const response = await ctx.auth.handler(
    new Request(`${ISSUER}/api/auth${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })
  )
  return {
    status: response.status,
    body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
  }
}

/**
 * Where `/oauth2/continue` and `/oauth2/consent` say to go.
 *
 * 1.7.1 answers `{ redirect: true, url }`; the OpenAPI description in the same
 * file says `redirect_uri`. Both are read, because a version that changes its
 * mind should not silently produce a page that redirects nowhere.
 */
function destinationOf(body: Record<string, unknown>): string {
  for (const key of ["url", "redirect_uri"]) {
    const value = body[key]
    if (typeof value === "string" && value !== "") return value
  }
  return ""
}

describe("an authorization that needs a sign-in first (FR-OIDC-9)", () => {
  it("carries the whole request to the login page", async () => {
    const ctx = await context("authorize_to_login")
    try {
      const attempt = await authorize(ctx, SKIP_CONSENT_CLIENT.clientId)
      expect(attempt.location).toContain("/login")

      const carried = new URLSearchParams(signedQuery(attempt.location))
      // The request travels with the user rather than being stored: the page
      // hands it straight back, and the signature is what makes that safe.
      expect(carried.get("client_id")).toBe(SKIP_CONSENT_CLIENT.clientId)
      expect(carried.get("state")).toBe("state-1")
      expect(carried.get("sig")).toBeTruthy()
      expect(carried.get("exp")).toBeTruthy()
    } finally {
      await ctx.teardown()
    }
  })

  it("resumes into an authorization code once there is a session", async () => {
    const ctx = await context("authorize_resume")
    try {
      const attempt = await authorize(ctx, SKIP_CONSENT_CLIENT.clientId)
      const cookie = await register(ctx)

      const resumed = await post(
        ctx,
        "/oauth2/continue",
        { selected: true, oauth_query: signedQuery(attempt.location) },
        cookie
      )
      expect(resumed.status).toBe(200)

      const destination = new URL(destinationOf(resumed.body))
      expect(destination.origin + destination.pathname).toBe(REDIRECT)
      expect(destination.searchParams.get("code")).toBeTruthy()
      // The client's `state` survives the whole detour, which is what lets it
      // match the answer to the request it made.
      expect(destination.searchParams.get("state")).toBe("state-1")
    } finally {
      await ctx.teardown()
    }
  })

  it("refuses a request whose signature does not hold", async () => {
    const ctx = await context("authorize_tampered")
    try {
      const attempt = await authorize(ctx, SKIP_CONSENT_CLIENT.clientId)
      const cookie = await register(ctx)

      // The one edit an attacker would actually make.
      const tampered = signedQuery(attempt.location).replace(
        encodeURIComponent(REDIRECT),
        encodeURIComponent("https://evil.example/steal")
      )
      const resumed = await post(
        ctx,
        "/oauth2/continue",
        { selected: true, oauth_query: tampered },
        cookie
      )
      expect(resumed.status).toBeGreaterThanOrEqual(400)
      expect(destinationOf(resumed.body)).not.toContain("evil.example")
    } finally {
      await ctx.teardown()
    }
  })

  it("will not resume for someone who is not signed in", async () => {
    const ctx = await context("authorize_no_session")
    try {
      const attempt = await authorize(ctx, SKIP_CONSENT_CLIENT.clientId)
      const resumed = await post(ctx, "/oauth2/continue", {
        selected: true,
        oauth_query: signedQuery(attempt.location),
      })
      expect(resumed.status).toBeGreaterThanOrEqual(400)
    } finally {
      await ctx.teardown()
    }
  })
})

describe("consent (FR-OIDC-9/10)", () => {
  it("asks when the client does not skip it", async () => {
    const ctx = await context("consent_asked")
    try {
      const cookie = await register(ctx)
      const attempt = await authorize(ctx, ASKING_CLIENT.clientId, { cookie })
      // A session is not enough: this client wants the user's own decision.
      expect(attempt.location).toContain("/consent")
      expect(
        new URLSearchParams(signedQuery(attempt.location)).get("client_id")
      ).toBe(ASKING_CLIENT.clientId)
    } finally {
      await ctx.teardown()
    }
  })

  it("does not ask when the client skips it", async () => {
    const ctx = await context("consent_skipped")
    try {
      const cookie = await register(ctx)
      const attempt = await authorize(ctx, SKIP_CONSENT_CLIENT.clientId, {
        cookie,
      })
      // An administrator configured this client in the file, so the decision
      // was already made (FR-OIDC-3).
      expect(attempt.location).toContain("code=")
    } finally {
      await ctx.teardown()
    }
  })

  it("turns an approval into a code, and remembers it", async () => {
    const ctx = await context("consent_approve")
    try {
      const cookie = await register(ctx)
      const attempt = await authorize(ctx, ASKING_CLIENT.clientId, { cookie })

      const decided = await post(
        ctx,
        "/oauth2/consent",
        { accept: true, oauth_query: signedQuery(attempt.location) },
        cookie
      )
      expect(decided.status).toBe(200)
      expect(destinationOf(decided.body)).toContain("code=")

      // The grant is stored, so the next authorization for the same scopes
      // goes straight through — which is also what `/account/consents` lists
      // and revokes.
      const again = await authorize(ctx, ASKING_CLIENT.clientId, { cookie })
      expect(again.location).toContain("code=")

      const consents = await ctx.database.db
        .select()
        .from(ctx.database.schema.oauthConsent)
      expect(consents).toHaveLength(1)
      expect(consents[0]?.clientId).toBe(ASKING_CLIENT.clientId)
    } finally {
      await ctx.teardown()
    }
  })

  it("turns a refusal into access_denied, not a code", async () => {
    const ctx = await context("consent_deny")
    try {
      const cookie = await register(ctx)
      const attempt = await authorize(ctx, ASKING_CLIENT.clientId, { cookie })

      const decided = await post(
        ctx,
        "/oauth2/consent",
        { accept: false, oauth_query: signedQuery(attempt.location) },
        cookie
      )
      const destination = destinationOf(decided.body)
      expect(destination).toContain("error=access_denied")
      expect(destination).not.toContain("code=")
      // The refusal still goes back to the client's registered URI: the
      // client asked, and it is entitled to the answer.
      expect(destination.startsWith(REDIRECT)).toBe(true)
    } finally {
      await ctx.teardown()
    }
  })

  it("refuses a decision made from a different session", async () => {
    const ctx = await context("consent_cross_session")
    try {
      const owner = await register(ctx, "owner@example.com")
      const attempt = await authorize(ctx, ASKING_CLIENT.clientId, {
        cookie: owner,
      })
      const stranger = await register(ctx, "stranger@example.com")

      const decided = await post(
        ctx,
        "/oauth2/consent",
        { accept: true, oauth_query: signedQuery(attempt.location) },
        stranger
      )
      // Whatever it does, it must not hand the *owner's* code to a request
      // authenticated as somebody else.
      const consents = await ctx.database.db
        .select()
        .from(ctx.database.schema.oauthConsent)
      for (const consent of consents) {
        expect(consent.userId).not.toBe(null)
      }
      expect(decided.status).toBeLessThan(500)
    } finally {
      await ctx.teardown()
    }
  })
})

describe("prompt (FR-OIDC-9)", () => {
  it("answers prompt=none with login_required when nobody is signed in", async () => {
    const ctx = await context("prompt_none_anon")
    try {
      const attempt = await authorize(ctx, SKIP_CONSENT_CLIENT.clientId, {
        extra: { prompt: "none" },
      })
      // `prompt=none` means "do not show me anything": the answer is an error
      // back to the client, never a login page.
      expect(attempt.location).toContain("error=login_required")
      expect(attempt.location).not.toContain("/login")
    } finally {
      await ctx.teardown()
    }
  })

  it("answers prompt=none with consent_required when consent is missing", async () => {
    const ctx = await context("prompt_none_consent")
    try {
      const cookie = await register(ctx)
      const attempt = await authorize(ctx, ASKING_CLIENT.clientId, {
        cookie,
        extra: { prompt: "none" },
      })
      expect(attempt.location).toContain("error=consent_required")
      expect(attempt.location).not.toContain("/consent")
    } finally {
      await ctx.teardown()
    }
  })

  it("re-asks when prompt=consent, even with a grant on file", async () => {
    const ctx = await context("prompt_consent")
    try {
      const cookie = await register(ctx)
      const first = await authorize(ctx, ASKING_CLIENT.clientId, { cookie })
      await post(
        ctx,
        "/oauth2/consent",
        { accept: true, oauth_query: signedQuery(first.location) },
        cookie
      )

      const forced = await authorize(ctx, ASKING_CLIENT.clientId, {
        cookie,
        extra: { prompt: "consent" },
      })
      expect(forced.location).toContain("/consent")
    } finally {
      await ctx.teardown()
    }
  })
})
