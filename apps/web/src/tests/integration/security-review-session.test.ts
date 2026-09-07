/**
 * Security review, work stream S1 — sessions and CSRF (2026-09-02).
 *
 * Five findings, each written from the attacker's side and each driven through
 * the real surface it was found on: the route `server.handlers` a browser
 * posts to (`setRuntime(asRuntime(context))` is the seam, as in
 * `account-revocation.test.ts`), the raw `/api/auth/*` endpoints a script can
 * reach with the same cookie, and the token endpoint.
 *
 *  - a forced password change is a wall, not a page. The
 *    session cookie is set *before* the redirect to `/change-password`, and
 *    nothing under `/account/*`, `/admin/*` or `/api/auth/*` read the flag.
 *  - **F7** — a session read and a refresh grant re-check the user's standing.
 *  - every form post is same-origin, or not from a browser.
 *  - **F9** — an impersonating administrator cannot mint an API key as the
 *    user, and the user's audit rows say who was really there.
 *  - **F10** — the consent trail names the client the provider verified.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createHash, randomBytes } from "node:crypto"

import { createLocalAccountIssuer } from "@better-auth/core/db"
import { and, desc, eq } from "drizzle-orm"

import { Route as ProfileRoute } from "@/routes/account/index"
import { Route as ApiKeysRoute } from "@/routes/account/api-keys"
import { Route as ConsentsRoute } from "@/routes/account/consents"
import { Route as SessionsRoute } from "@/routes/account/sessions"
import { Route as ClientsRoute } from "@/routes/admin/clients/index"
import { Route as GatewaysRoute } from "@/routes/admin/gateways/index"
import { Route as ConsentRoute } from "@/routes/consent"
import { createUserWithoutRequest } from "@/server/auth/provisioning"
import { readSession } from "@/server/http/session"
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
const SECRET = "review-client-secret-of-at-least-32-chars"
const REDIRECT = "https://app.example.com/callback"

/** Asks for consent, so `/consent` is on its path. */
const ASKING_CLIENT = {
  clientId: "asking-app",
  type: "web",
  name: "Asking App",
  clientSecret: SECRET,
  redirectUris: [REDIRECT],
  skipConsent: false,
  enableEndSession: false,
}

/** Skips consent and may hold a refresh token, so the refresh grant is one call away. */
const OFFLINE_CLIENT = {
  clientId: "offline-app",
  type: "web",
  name: "Offline App",
  clientSecret: SECRET,
  redirectUris: [REDIRECT],
  scopes: ["openid", "profile", "email", "offline_access"],
  skipConsent: true,
  enableEndSession: false,
}

let context: TestContext

beforeAll(async () => {
  context = await createTestContext("security_review_session", {
    clients: [ASKING_CLIENT, OFFLINE_CLIENT],
    config: {
      // `server` is replaced, not merged, so the base URL rides along. The
      // sibling-subdomain pattern is the documented example and the one case
      // Better Auth's own origin check lets through: a page on
      // `apps.example.com` posting to this host is *same-site*, and only
      // `Sec-Fetch-Site` can tell.
      server: {
        baseUrl: ISSUER,
        trustedOrigins: [ISSUER, "http://*.example.com"],
      },
      signUp: { enabled: true, requireApproval: false },
      auth: { requireEmailVerification: false },
      apiKeys: { enabled: true },
      admin: { allowImpersonation: true },
      oauth: { scopes: ["openid", "profile", "email", "offline_access"] },
    },
  })
  await reconcileClients({
    config: context.config,
    database: context.database,
    locking: context.database,
  })
  setRuntime(asRuntime(context))
}, 120_000)

afterAll(async () => {
  await context.teardown()
})

/** A user made the way the bootstrap step and the admin create do it. */
async function makeUser(
  email: string,
  extra: Record<string, unknown> = {}
): Promise<string> {
  const auth = await context.auth.$context
  const user = await createUserWithoutRequest(
    auth,
    { email, name: email, emailVerified: true, status: "active", ...extra },
    { method: "admin" }
  )
  await auth.internalAdapter.createAccount({
    userId: user.id,
    providerId: "credential",
    issuer: createLocalAccountIssuer("credential"),
    accountId: user.id,
    password: await auth.password.hash(PASSWORD),
  })
  return user.id
}

async function signIn(email: string): Promise<string> {
  const response = await context.auth.handler(
    authRequest("/sign-in/email", { json: { email, password: PASSWORD } })
  )
  const cookie = sessionCookie(response)
  expect(cookie, `sign-in failed for ${email}`).toBeTruthy()
  return cookie!
}

async function setUser(userId: string, values: Record<string, unknown>) {
  await context.database.db
    .update(context.database.schema.user)
    .set(values)
    .where(eq(context.database.schema.user.id, userId))
}

type Handler = (input: { request: Request }) => Promise<Response>

function postHandler(route: { options: { server?: unknown } }): Handler {
  const handlers = (
    route.options.server as { handlers?: { POST?: unknown } } | undefined
  )?.handlers
  const declared = handlers?.POST
  if (typeof declared !== "function") {
    throw new Error("the route has no POST handler in record form")
  }
  return declared as Handler
}

interface PostOptions {
  /** Added to, or overriding, the headers a same-origin form post carries. */
  headers?: Record<string, string>
  /** Headers to leave out entirely — how "neither header" is spelled. */
  without?: string[]
}

/** A browser's form post to one of this app's routes, unless told otherwise. */
async function post(
  route: { options: { server?: unknown } },
  path: string,
  cookie: string,
  fields: Record<string, string>,
  options: PostOptions = {}
): Promise<Response> {
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
    cookie,
    origin: ISSUER,
    "sec-fetch-site": "same-origin",
    ...options.headers,
  })
  for (const name of options.without ?? []) headers.delete(name)
  return postHandler(route)({
    request: new Request(`${ISSUER}${path}`, {
      method: "POST",
      headers,
      body: new URLSearchParams(fields).toString(),
    }),
  })
}

/** The `?notice=` or `?error=` the handler redirected to. */
function outcome(response: Response): string {
  expect(response.status).toBe(303)
  const location = new URL(response.headers.get("location") ?? "", ISSUER)
  return (
    location.searchParams.get("notice") ??
    location.searchParams.get("error") ??
    ""
  )
}

function locationOf(response: Response): URL {
  expect(response.status).toBe(303)
  return new URL(response.headers.get("location") ?? "", ISSUER)
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>
}

async function apiKeyCount(userId: string): Promise<number> {
  const { apikey } = context.database.schema
  const rows = await context.database.db
    .select({ id: apikey.id })
    .from(apikey)
    .where(eq(apikey.referenceId, userId))
  return rows.length
}

async function lastAudit(
  action: string,
  actorUserId?: string
): Promise<{ metadata: Record<string, unknown> | null } | undefined> {
  const { auditLog } = context.database.schema
  const [row] = await context.database.db
    .select({ metadata: auditLog.metadata })
    .from(auditLog)
    .where(
      actorUserId
        ? and(eq(auditLog.action, action), eq(auditLog.actorUserId, actorUserId))
        : eq(auditLog.action, action)
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(1)
  return row as { metadata: Record<string, unknown> | null } | undefined
}

/** An authorization with PKCE; returns where the provider sent the browser. */
async function authorize(
  clientId: string,
  cookie: string,
  scope = "openid profile email"
): Promise<{ location: string; verifier: string }> {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope,
    state: "state-1",
    code_challenge: challenge,
    code_challenge_method: "S256",
  })
  const response = await context.auth.handler(
    new Request(`${ISSUER}/api/auth/oauth2/authorize?${query.toString()}`, {
      headers: { cookie },
      redirect: "manual",
    })
  )
  return { location: response.headers.get("location") ?? "", verifier }
}

async function tokenRequest(
  clientId: string,
  fields: Record<string, string>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await context.auth.handler(
    new Request(`${ISSUER}/api/auth/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: ISSUER,
        authorization: `Basic ${Buffer.from(`${clientId}:${SECRET}`).toString("base64")}`,
      },
      body: new URLSearchParams(fields).toString(),
    })
  )
  return { status: response.status, body: await bodyOf(response) }
}

describe("a forced password change gates everything else", () => {
  const email = "temporary@example.com"
  let userId: string
  let cookie: string

  beforeAll(async () => {
    // Exactly what an administrator's "set a temporary password" produces.
    userId = await makeUser(email, { mustChangePassword: true })
    cookie = await signIn(email)
  })

  it("sends the account form posts to the change-password page", async () => {
    const profile = await post(ProfileRoute, "/account", cookie, {
      firstName: "Tem",
      lastName: "Porary",
    })
    const target = locationOf(profile)
    expect(target.pathname).toBe("/change-password")
    expect(target.searchParams.get("forced")).toBe("1")
    expect(target.searchParams.get("returnTo")).toBe("/account")

    const keys = await post(ApiKeysRoute, "/account/api-keys", cookie, {
      action: "create",
      name: "long-lived",
      expiresInDays: "365",
    })
    expect(locationOf(keys).pathname).toBe("/change-password")
    expect(await apiKeyCount(userId)).toBe(0)
  })

  it("sends an administrator's form posts there too", async () => {
    await makeUser("temporary-admin@example.com", {
      role: "admin",
      mustChangePassword: true,
    })
    const admin = await signIn("temporary-admin@example.com")
    const response = await post(GatewaysRoute, "/admin/gateways", admin, {
      action: "delete",
      name: "nothing",
    })
    expect(locationOf(response).pathname).toBe("/change-password")
  })

  it("refuses a direct API-key mint, and a session JWT, with the same cookie", async () => {
    // The finding: the cookie is a working credential from the first
    // response, and `POST /api/auth/api-key/create` never passes a page.
    const minted = await context.auth.handler(
      authRequest("/api-key/create", {
        headers: { cookie },
        json: { name: "long-lived" },
      })
    )
    expect(minted.status).toBe(403)
    expect((await bodyOf(minted)).code).toBe("PASSWORD_CHANGE_REQUIRED")
    expect(await apiKeyCount(userId)).toBe(0)

    // A GET that mints is a mint.
    const jwt = await context.auth.handler(
      new Request(`${ISSUER}/api/auth/token`, { headers: { cookie } })
    )
    expect(jwt.status).toBe(403)
  })

  it("re-reads the flag rather than trusting the cookie", async () => {
    // The cookie cache carries the user as they were at sign-in. Clearing the
    // flag in the database must open the door on the next request, not five
    // minutes later — and raising it must close it just as fast.
    await setUser(userId, { mustChangePassword: false })
    const opened = await post(ProfileRoute, "/account", cookie, {
      firstName: "Tem",
      lastName: "Porary",
    })
    expect(outcome(opened)).toBe("profile_saved")

    await setUser(userId, { mustChangePassword: true })
    const closed = await post(ProfileRoute, "/account", cookie, {
      firstName: "Tem",
      lastName: "Porary",
    })
    expect(locationOf(closed).pathname).toBe("/change-password")
  })

  it("lets the change itself through, and everything after it", async () => {
    const changed = await context.auth.handler(
      authRequest("/change-password", {
        headers: { cookie },
        json: {
          currentPassword: PASSWORD,
          newPassword: "a password of the user's own choosing",
          revokeOtherSessions: true,
        },
      })
    )
    expect(changed.status).toBe(200)
    // The endpoint may re-mint the cookie; the old one stays valid either way.
    cookie = sessionCookie(changed) ?? cookie

    const minted = await context.auth.handler(
      authRequest("/api-key/create", {
        headers: { cookie },
        json: { name: "after the change" },
      })
    )
    expect(minted.status).toBe(200)

    const created = await post(ApiKeysRoute, "/account/api-keys", cookie, {
      action: "create",
      name: "from the page",
      expiresInDays: "30",
    })
    expect(locationOf(created).searchParams.get("created")).toBeTruthy()
    expect(await apiKeyCount(userId)).toBe(2)
  })
})

describe("standing is re-checked on every read and every refresh", () => {
  function request(cookie: string): Request {
    return new Request(`${ISSUER}/account`, { headers: { cookie } })
  }

  it("a live session stops answering when the user is no longer active", async () => {
    const userId = await makeUser("standing@example.com")
    const cookie = await signIn("standing@example.com")
    const runtime = asRuntime(context)

    expect(
      await readSession(runtime, request(cookie), { authoritative: true })
    ).not.toBeNull()

    // An administrator withdraws approval (or the row is edited by hand):
    // the session row is untouched, and that must not matter.
    await setUser(userId, { status: "pending" })
    expect(
      await readSession(runtime, request(cookie), { authoritative: true })
    ).toBeNull()

    await setUser(userId, { status: "active" })
    expect(
      await readSession(runtime, request(cookie), { authoritative: true })
    ).not.toBeNull()

    await setUser(userId, { banned: true })
    expect(
      await readSession(runtime, request(cookie), { authoritative: true })
    ).toBeNull()
  })

  it("a live refresh token stops refreshing too", async () => {
    const userId = await makeUser("refresher@example.com")
    const cookie = await signIn("refresher@example.com")

    const { location, verifier } = await authorize(
      OFFLINE_CLIENT.clientId,
      cookie,
      "openid offline_access"
    )
    const code = new URL(location).searchParams.get("code")
    expect(code, "the flow must produce a code").toBeTruthy()
    const issued = await tokenRequest(OFFLINE_CLIENT.clientId, {
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    })
    expect(issued.status).toBe(200)
    let refresh = String(issued.body.refresh_token)
    expect(refresh).toBeTruthy()

    // Approval withdrawn: the grant is refused, and the token is not consumed
    // by the refusal — the spec says the *state* is re-verified, not that
    // the token is spent on the attempt.
    await setUser(userId, { status: "pending" })
    const refused = await tokenRequest(OFFLINE_CLIENT.clientId, {
      grant_type: "refresh_token",
      refresh_token: refresh,
    })
    expect(refused.status).toBe(400)
    expect(refused.body.error).toBe("invalid_grant")

    await setUser(userId, { status: "active" })
    const rotated = await tokenRequest(OFFLINE_CLIENT.clientId, {
      grant_type: "refresh_token",
      refresh_token: refresh,
    })
    expect(rotated.status).toBe(200)
    refresh = String(rotated.body.refresh_token)

    // A ban by SQL — the admin endpoint would also revoke, this is the case
    // where nothing else did.
    await setUser(userId, { banned: true })
    const banned = await tokenRequest(OFFLINE_CLIENT.clientId, {
      grant_type: "refresh_token",
      refresh_token: refresh,
    })
    expect(banned.status).toBe(400)
    expect(banned.body.error).toBe("invalid_grant")
  })
})

describe("every form post is same-origin, or not from a browser", () => {
  let cookie: string
  let admin: string

  beforeAll(async () => {
    await makeUser("poster@example.com")
    cookie = await signIn("poster@example.com")
    await makeUser("posting-admin@example.com", { role: "admin" })
    admin = await signIn("posting-admin@example.com")
  })

  const PROFILE = { firstName: "Post", lastName: "Er" }
  const KEY = { action: "create", name: "csrf", expiresInDays: "30" }
  const GATEWAY = { action: "delete", name: "nothing" }
  const CLIENT = { action: "delete", clientId: "nothing" }

  it("refuses a sibling subdomain, which the origin allow-list lets through", async () => {
    // `server.trustedOrigins` names `http://*.example.com`, so Better Auth
    // accepts the Origin. The browser still says the page was on another
    // site, and with `server.cookieDomain` set that page carries the cookie.
    const sibling = {
      headers: { origin: "http://apps.example.com", "sec-fetch-site": "same-site" },
    }
    expect(outcome(await post(ProfileRoute, "/account", cookie, PROFILE, sibling))).toBe("untrusted_origin")
    expect(outcome(await post(ApiKeysRoute, "/account/api-keys", cookie, KEY, sibling))).toBe("untrusted_origin")
    expect(outcome(await post(GatewaysRoute, "/admin/gateways", admin, GATEWAY, sibling))).toBe("untrusted_origin")
    expect(outcome(await post(ClientsRoute, "/admin/clients", admin, CLIENT, sibling))).toBe("untrusted_origin")
  })

  it("refuses a cross-site post and a foreign Origin", async () => {
    const crossSite = { headers: { "sec-fetch-site": "cross-site" } }
    const foreign = {
      headers: { origin: "https://evil.example" },
      without: ["sec-fetch-site"],
    }
    for (const shape of [crossSite, foreign]) {
      expect(outcome(await post(ProfileRoute, "/account", cookie, PROFILE, shape))).toBe("untrusted_origin")
      expect(outcome(await post(ApiKeysRoute, "/account/api-keys", cookie, KEY, shape))).toBe("untrusted_origin")
      expect(outcome(await post(GatewaysRoute, "/admin/gateways", admin, GATEWAY, shape))).toBe("untrusted_origin")
      expect(outcome(await post(ClientsRoute, "/admin/clients", admin, CLIENT, shape))).toBe("untrusted_origin")
    }
  })

  it("still accepts a post that carries neither header", async () => {
    // Not a browser: a script that attached the cookie itself already holds
    // it, and CSRF is not something that can be done to it. `/account/consents`
    // writes directly, so `not_found` is the handler's own uniform answer and
    // proves both gates were passed.
    const response = await post(
      ConsentsRoute,
      "/account/consents",
      cookie,
      { clientId: "never-connected" },
      { without: ["origin", "sec-fetch-site"] }
    )
    expect(outcome(response)).toBe("not_found")
  })

  it("still accepts a browser's own post", async () => {
    expect(outcome(await post(ProfileRoute, "/account", cookie, PROFILE))).toBe("profile_saved")
    expect(outcome(await post(GatewaysRoute, "/admin/gateways", admin, GATEWAY))).toBe("gateway_not_found")
  })
})

describe("impersonation", () => {
  let adminId: string
  let victimId: string
  let impersonated: string

  beforeAll(async () => {
    adminId = await makeUser("impersonator@example.com", { role: "admin" })
    victimId = await makeUser("impersonated@example.com")
    const adminCookie = await signIn("impersonator@example.com")
    const started = await context.auth.handler(
      authRequest("/admin/impersonate-user", {
        headers: { cookie: adminCookie },
        json: { userId: victimId },
      })
    )
    expect(started.status).toBe(200)
    impersonated = sessionCookie(started)!
    expect(impersonated).toBeTruthy()
  })

  it("cannot mint an API key as the user, from the page or the API", async () => {
    const fromPage = await post(ApiKeysRoute, "/account/api-keys", impersonated, {
      action: "create",
      name: "outlives the hour",
      expiresInDays: "365",
    })
    expect(outcome(fromPage)).toBe("impersonated_session")

    const fromApi = await context.auth.handler(
      authRequest("/api-key/create", {
        headers: { cookie: impersonated },
        json: { name: "outlives the hour" },
      })
    )
    expect(fromApi.status).toBe(403)
    expect((await bodyOf(fromApi)).code).toBe("IMPERSONATED_SESSION")
    expect(await apiKeyCount(victimId)).toBe(0)
  })

  it("names the administrator on the user's audit rows", async () => {
    // The user's own session, which the administrator then signs out.
    const own = await signIn("impersonated@example.com")
    const resolved = await context.auth.api.getSession({
      headers: new Headers({ cookie: own }),
    })
    const ownId = (resolved?.session as { id?: string } | undefined)?.id
    expect(ownId).toBeTruthy()

    const revoked = await post(SessionsRoute, "/account/sessions", impersonated, {
      scope: "one",
      sessionId: ownId!,
    })
    expect(outcome(revoked)).toBe("session_revoked")

    const row = await lastAudit("session.revoked", victimId)
    expect(row?.metadata?.impersonatedBy).toBe(adminId)
  })
})

describe("the consent trail names the verified client", () => {
  it("ignores a forged hidden field", async () => {
    const userId = await makeUser("consenting@example.com")
    const cookie = await signIn("consenting@example.com")
    const { location } = await authorize(ASKING_CLIENT.clientId, cookie)
    expect(location).toContain("/consent")
    const oauthQuery = new URL(location, ISSUER).search.replace(/^\?/, "")

    const decided = await post(ConsentRoute, "/consent", cookie, {
      oauth_query: oauthQuery,
      clientId: "forged-app",
      decision: "allow",
    })
    expect(locationOf(decided).searchParams.get("code")).toBeTruthy()

    const row = await lastAudit("consent.granted", userId)
    expect(row?.metadata?.clientId).toBe(ASKING_CLIENT.clientId)
  })
})
