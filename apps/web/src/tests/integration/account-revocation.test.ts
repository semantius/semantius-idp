/**
 * `/account/sessions` and `/account/consents`, driven as form posts
 * (**D101**, **D102**, **D103**).
 *
 * The handlers are the requirement here, not the helpers underneath them.
 * Whether "Sign out" revokes the session's OAuth tokens depends on the *order*
 * the handler does two things in — the revocation has to happen while the
 * session row is still there to scope on — and on which gates run before
 * either. Asserting on `revokeForSession` alone would pass with the call in
 * the wrong place, or with no call at all.
 *
 * `setRuntime(asRuntime(context))` is the seam (`server/runtime.ts`, the CLI's
 * own). The route's POST is reached through `Route.options.server?.handlers`,
 * the way `tests/unit/readyz-draining.test.ts` reaches `/readyz`'s GET.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createHash, randomBytes } from "node:crypto"

import { and, eq, isNull } from "drizzle-orm"

import { Route as ConsentsRoute } from "@/routes/account/consents"
import { Route as SessionsRoute } from "@/routes/account/sessions"
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
const SECRET = "account-client-secret-of-at-least-32-chars"
const PASSWORD = "correct-horse-battery-staple"
const REDIRECT = "https://app.example.com/callback"

const CLIENT = {
  clientId: "account-app",
  name: "Account App",
  type: "web",
  clientSecret: SECRET,
  redirectUris: [REDIRECT],
  scopes: ["openid", "profile", "email", "offline_access"],
  enableEndSession: false,
}

let context: TestContext

beforeAll(async () => {
  context = await createTestContext("account_revocation", {
    clients: [CLIENT],
    config: {
      signUp: { enabled: true, requireApproval: false },
      auth: { requireEmailVerification: false },
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

/** A fresh account, so one test's revocations cannot reach another's rows. */
async function register(email: string): Promise<string> {
  const created = await context.auth.handler(
    authRequest("/sign-up/email", {
      json: { email, password: PASSWORD, name: "Account User" },
    })
  )
  expect(created.status).toBe(200)
  return signIn(email)
}

async function signIn(email: string): Promise<string> {
  const response = await context.auth.handler(
    authRequest("/sign-in/email", { json: { email, password: PASSWORD } })
  )
  const cookie = sessionCookie(response)
  expect(cookie, "sign-in should create a session").toBeTruthy()
  return cookie!
}

async function userIdFor(email: string): Promise<string> {
  const [row] = await context.database.db
    .select({ id: context.database.schema.user.id })
    .from(context.database.schema.user)
    .where(eq(context.database.schema.user.email, email))
  expect(row?.id).toBeTruthy()
  return row!.id
}

async function sessionIdFor(cookie: string): Promise<string> {
  const result = await context.auth.api.getSession({
    headers: new Headers({ cookie }),
  })
  const id = (result?.session as { id?: string } | undefined)?.id
  expect(id, "the cookie should resolve to a session").toBeTruthy()
  return id!
}

/** One authorization-code exchange on the given session. */
async function grant(cookie: string): Promise<void> {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const query = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT.clientId,
    redirect_uri: REDIRECT,
    scope: "openid offline_access",
    state: "state",
    code_challenge: challenge,
    code_challenge_method: "S256",
  })
  const authorized = await context.auth.handler(
    new Request(`${ISSUER}/api/auth/oauth2/authorize?${query.toString()}`, {
      headers: { cookie },
      redirect: "manual",
    })
  )
  const code = new URL(
    authorized.headers.get("location") ?? ""
  ).searchParams.get("code")
  expect(code, "the flow must produce a code").toBeTruthy()

  const exchanged = await context.auth.handler(
    new Request(`${ISSUER}/api/auth/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: ISSUER,
        authorization: `Basic ${Buffer.from(`${CLIENT.clientId}:${SECRET}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      }).toString(),
    })
  )
  expect(exchanged.status).toBe(200)
}

/** Live (unrevoked, unexpired) refresh tokens for one user. */
async function liveTokens(userId: string): Promise<number> {
  const { oauthRefreshToken } = context.database.schema
  const rows = await context.database.db
    .select({ id: oauthRefreshToken.id })
    .from(oauthRefreshToken)
    .where(
      and(
        eq(oauthRefreshToken.userId, userId),
        isNull(oauthRefreshToken.revoked)
      )
    )
  return rows.length
}

type Handler = (input: { request: Request }) => Promise<Response>

function postHandler(route: typeof SessionsRoute | typeof ConsentsRoute) {
  const handlers = route.options.server?.handlers as
    | { POST?: unknown }
    | undefined
  const declared = handlers?.POST
  if (typeof declared !== "function") {
    throw new Error("the route has no POST handler in record form")
  }
  return declared as Handler
}

interface PostOptions {
  /** Overrides the browser headers a same-origin form post would carry. */
  headers?: Record<string, string>
}

async function post(
  route: typeof SessionsRoute | typeof ConsentsRoute,
  path: string,
  cookie: string,
  fields: Record<string, string>,
  options: PostOptions = {}
): Promise<Response> {
  const body = new URLSearchParams(fields)
  return postHandler(route)({
    request: new Request(`${ISSUER}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie,
        origin: ISSUER,
        "sec-fetch-site": "same-origin",
        ...options.headers,
      },
      body: body.toString(),
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

describe("signing one session out (D101)", () => {
  it("revokes the tokens that session obtained, with the flag off", async () => {
    const email = "one-scope@example.com"
    const laptop = await register(email)
    const phone = await signIn(email)
    const userId = await userIdFor(email)
    await grant(laptop)
    await grant(phone)
    expect(await liveTokens(userId)).toBe(2)

    // The default. Nothing here depends on `revokeOAuthTokensOnLogout`, which
    // is the point: an explicit revocation is not a logout.
    expect(context.config.file.session.revokeOAuthTokensOnLogout).toBe(false)

    const laptopId = await sessionIdFor(laptop)
    const response = await post(SessionsRoute, "/account/sessions", phone, {
      scope: "one",
      sessionId: laptopId,
    })

    expect(outcome(response)).toBe("session_revoked")
    // The phone keeps its grant: the scope is the session, not the user.
    expect(await liveTokens(userId)).toBe(1)
  })

  it("refuses a session id belonging to somebody else, and touches nothing", async () => {
    const mine = await register("owner@example.com")
    const theirs = await register("stranger@example.com")
    const strangerId = await userIdFor("stranger@example.com")
    await grant(theirs)
    expect(await liveTokens(strangerId)).toBe(1)

    const response = await post(SessionsRoute, "/account/sessions", mine, {
      scope: "one",
      sessionId: await sessionIdFor(theirs),
    })

    // SEC-7: "not yours" and "does not exist" are the same answer.
    expect(outcome(response)).toBe("not_found")
    expect(await liveTokens(strangerId)).toBe(1)
    // And the session it named is still signed in.
    const still = await context.auth.api.getSession({
      headers: new Headers({ cookie: theirs }),
    })
    expect(still?.user).toBeTruthy()
  })
})

describe("signing every other session out (D101)", () => {
  it("cuts off every other device, expired sessions included", async () => {
    const email = "others-scope@example.com"
    const keep = await register(email)
    const laptop = await signIn(email)
    const forgotten = await signIn(email)
    const userId = await userIdFor(email)
    await grant(keep)
    await grant(laptop)
    await grant(forgotten)
    expect(await liveTokens(userId)).toBe(3)

    // The forgotten device: its session lapsed weeks ago and its refresh
    // token did not. Better Auth's own `/revoke-other-sessions` skips expired
    // rows, so this is the case nothing else would ever reach.
    const { session } = context.database.schema
    await context.database.db
      .update(session)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(session.id, await sessionIdFor(forgotten)))

    const response = await post(SessionsRoute, "/account/sessions", keep, {
      scope: "others",
    })

    expect(outcome(response)).toBe("session_revoked")
    expect(await liveTokens(userId)).toBe(1)
  })

  it("writes one token.revoked row per session, naming it", async () => {
    const email = "others-audit@example.com"
    const keep = await register(email)
    const laptop = await signIn(email)
    const phone = await signIn(email)
    const userId = await userIdFor(email)
    await grant(laptop)
    await grant(phone)

    const laptopId = await sessionIdFor(laptop)
    const phoneId = await sessionIdFor(phone)
    await post(SessionsRoute, "/account/sessions", keep, { scope: "others" })

    const rows = await auditRows(userId, "token.revoked")
    const named = rows.map(
      (row) => (row.metadata as { sessionId?: string }).sessionId
    )
    expect(named).toContain(laptopId)
    expect(named).toContain(phoneId)
    expect(rows[0]?.metadata).toMatchObject({
      scope: "session",
      reason: "session_revoked_by_user",
    })

    // A second pass revokes nothing twice: `revoke()` skips already-revoked
    // rows and `record()` suppresses a zero-row event, so the trail does not
    // grow a row that describes nothing happening.
    await post(SessionsRoute, "/account/sessions", keep, { scope: "others" })
    expect((await auditRows(userId, "token.revoked")).length).toBe(rows.length)
  })
})

describe("the gates in front of both destructive posts", () => {
  it("refuses a cross-site post to /account/sessions before writing anything", async () => {
    const email = "csrf-sessions@example.com"
    const keep = await register(email)
    const other = await signIn(email)
    const userId = await userIdFor(email)
    await grant(other)

    const response = await post(
      SessionsRoute,
      "/account/sessions",
      keep,
      { scope: "others" },
      {
        headers: {
          origin: "https://evil.example",
          "sec-fetch-site": "cross-site",
        },
      }
    )

    expect(outcome(response)).toBe("untrusted_origin")
    expect(await liveTokens(userId)).toBe(1)
  })

  it("refuses a same-site sibling subdomain too", async () => {
    const email = "csrf-sibling@example.com"
    const keep = await register(email)
    const other = await signIn(email)
    const userId = await userIdFor(email)
    await grant(other)

    // The cookies are `SameSite=Lax`, which does not stop a post from a page
    // on a sibling subdomain — and `server.cookieDomain` (**D97**) is what
    // makes such a page carry the cookie.
    const response = await post(
      SessionsRoute,
      "/account/sessions",
      keep,
      { scope: "others" },
      { headers: { "sec-fetch-site": "same-site" } }
    )

    expect(outcome(response)).toBe("untrusted_origin")
    expect(await liveTokens(userId)).toBe(1)
  })

  it("refuses a cross-site post to /account/consents before deleting anything", async () => {
    const email = "csrf-consents@example.com"
    const cookie = await register(email)
    const userId = await userIdFor(email)
    await grant(cookie)

    const response = await post(
      ConsentsRoute,
      "/account/consents",
      cookie,
      { clientId: CLIENT.clientId },
      {
        headers: {
          origin: "https://evil.example",
          "sec-fetch-site": "cross-site",
        },
      }
    )

    expect(outcome(response)).toBe("untrusted_origin")
    expect(await liveTokens(userId)).toBe(1)
  })
})

describe("disconnecting an application (D102)", () => {
  it("revokes a skipConsent client's tokens with no consent row to delete", async () => {
    const email = "disconnect@example.com"
    const cookie = await register(email)
    const userId = await userIdFor(email)
    await grant(cookie)
    expect(await liveTokens(userId)).toBe(1)

    // The case that made this page useless: every file client defaults to
    // `skipConsent`, so there has never been a row here to find.
    const { oauthConsent } = context.database.schema
    const consents = await context.database.db
      .select({ id: oauthConsent.id })
      .from(oauthConsent)
      .where(eq(oauthConsent.userId, userId))
    expect(consents.length).toBe(0)

    const response = await post(ConsentsRoute, "/account/consents", cookie, {
      clientId: CLIENT.clientId,
    })

    expect(outcome(response)).toBe("consent_revoked")
    expect(await liveTokens(userId)).toBe(0)

    const [audited] = await auditRows(userId, "consent.revoked")
    expect(audited?.metadata).toMatchObject({
      consentRows: 0,
      refreshTokens: 1,
    })
  })

  it("answers not_found when there was nothing of either kind", async () => {
    const cookie = await register("disconnect-twice@example.com")

    const first = await post(ConsentsRoute, "/account/consents", cookie, {
      clientId: CLIENT.clientId,
    })
    // Never connected: no consent row and no live token.
    expect(outcome(first)).toBe("not_found")

    // An unknown client id is the same answer, and revokes only the caller's
    // own nothing — `revokeForClient` is scoped to (user, client).
    const unknown = await post(ConsentsRoute, "/account/consents", cookie, {
      clientId: "no-such-client",
    })
    expect(outcome(unknown)).toBe("not_found")
  })
})

async function auditRows(
  userId: string,
  action: string
): Promise<{ metadata: unknown }[]> {
  const { auditLog } = context.database.schema
  return context.database.db
    .select({ metadata: auditLog.metadata })
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.actorUserId, userId)))
}
