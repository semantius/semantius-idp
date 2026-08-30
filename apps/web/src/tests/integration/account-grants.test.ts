/**
 * What "connected applications" means, once it is more than a consent table
 * (**D102**).
 *
 * `oidc/grants.ts` is where the merge rules live precisely so they can be
 * asserted here without a request: the interesting cases are a client with
 * tokens and no consent (every file client, since they default to
 * `skipConsent`), a client with both, and rows that exist only as evidence —
 * revoked or expired refresh tokens survive `oauth.tokenGraceDays` so reuse
 * detection can tell "revoked" from "never existed" (FR-OIDC-8), and a grants
 * list that showed them would offer to disconnect a month of applications the
 * user had already disconnected.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createHash, randomBytes } from "node:crypto"

import { eq } from "drizzle-orm"

import {
  activeGrantsFor,
  liveTokenClientsBySession,
} from "@/server/oidc/grants"
import { reconcileClients } from "@/server/oidc/reconcile"
import type { TestContext } from "./harness"
import { authRequest, createTestContext, sessionCookie } from "./harness"

const ISSUER = "http://localhost:3000"
const PASSWORD = "correct-horse-battery-staple"

/** Two clients, so a grouped list has something to group. */
const NAMED = {
  clientId: "named-app",
  name: "Named App",
  type: "web",
  clientSecret: "named-client-secret-of-at-least-32-chars",
  redirectUris: ["https://named.example.com/callback"],
  scopes: ["openid", "profile", "email", "offline_access"],
  enableEndSession: false,
}

/** No `name`, so the display has to fall back to the id. */
const UNNAMED = {
  clientId: "unnamed-app",
  type: "web",
  clientSecret: "unnamed-client-secret-of-at-least-32-chars",
  redirectUris: ["https://unnamed.example.com/callback"],
  scopes: ["openid", "profile", "email", "offline_access"],
  enableEndSession: false,
}

let context: TestContext

beforeAll(async () => {
  context = await createTestContext("account_grants", {
    clients: [NAMED, UNNAMED],
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
}, 120_000)

afterAll(async () => {
  await context.teardown()
})

async function register(email: string): Promise<string> {
  const created = await context.auth.handler(
    authRequest("/sign-up/email", {
      json: { email, password: PASSWORD, name: "Grant User" },
    })
  )
  expect(created.status).toBe(200)
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

interface Grant {
  client: typeof NAMED | typeof UNNAMED
  cookie: string
  scope?: string
}

/** One authorization-code exchange; returns the token response body. */
async function grant({
  client,
  cookie,
  scope = "openid offline_access",
}: Grant): Promise<{ refresh_token?: string }> {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const query = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: client.redirectUris[0]!,
    scope,
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
        authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: client.redirectUris[0]!,
        code_verifier: verifier,
      }).toString(),
    })
  )
  expect(exchanged.status).toBe(200)
  return (await exchanged.json()) as { refresh_token?: string }
}

async function refresh(
  client: typeof NAMED,
  refreshToken: string
): Promise<{ refresh_token?: string }> {
  const response = await context.auth.handler(
    new Request(`${ISSUER}/api/auth/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: ISSUER,
        authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }).toString(),
    })
  )
  expect(response.status).toBe(200)
  return (await response.json()) as { refresh_token?: string }
}

describe("activeGrantsFor (D102)", () => {
  it("lists a skipConsent client that holds a live refresh token", async () => {
    const email = "grants-token-only@example.com"
    const cookie = await register(email)
    const userId = await userIdFor(email)
    await grant({ client: NAMED, cookie })

    const grants = await activeGrantsFor(context.database, userId)

    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatchObject({
      clientId: NAMED.clientId,
      clientName: NAMED.name,
      // Nobody was ever asked: the administrator configured the client.
      hasConsent: false,
      activeTokens: 1,
    })
    expect(grants[0]?.scopes).toContain("offline_access")
  })

  it("dates the grant by auth_time, so a refresh does not move it", async () => {
    const email = "grants-rotation@example.com"
    const cookie = await register(email)
    const userId = await userIdFor(email)
    const issued = await grant({ client: NAMED, cookie })
    expect(issued.refresh_token).toBeTruthy()

    const before = await activeGrantsFor(context.database, userId)
    expect(before).toHaveLength(1)

    const rotated = await refresh(NAMED, issued.refresh_token!)
    expect(rotated.refresh_token).toBeTruthy()
    expect(rotated.refresh_token).not.toBe(issued.refresh_token)

    const after = await activeGrantsFor(context.database, userId)
    // One row, not two: rotation revokes the old token, and the live filter
    // is what keeps the replaced row out of the list.
    expect(after).toHaveLength(1)
    expect(after[0]?.activeTokens).toBe(1)
    // `created_at` walks forward on every refresh; `auth_time` does not, and
    // is why a year-old connection does not report itself as new.
    expect(after[0]?.connectedAt.getTime()).toBe(
      before[0]?.connectedAt.getTime()
    )
  })

  it("shows nothing for a revoked or an expired refresh token", async () => {
    const email = "grants-dead-rows@example.com"
    const cookie = await register(email)
    const userId = await userIdFor(email)
    await grant({ client: NAMED, cookie })
    await grant({ client: UNNAMED, cookie })
    expect(await activeGrantsFor(context.database, userId)).toHaveLength(2)

    const { oauthRefreshToken } = context.database.schema
    await context.database.db
      .update(oauthRefreshToken)
      .set({ revoked: new Date() })
      .where(eq(oauthRefreshToken.clientId, NAMED.clientId))
    await context.database.db
      .update(oauthRefreshToken)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(oauthRefreshToken.clientId, UNNAMED.clientId))

    // Both rows are still in the table — they are the FR-OIDC-8 evidence that
    // tells a revoked token apart from one that never existed, and the sweep
    // keeps them for `oauth.tokenGraceDays`. Neither is a connection.
    expect(await activeGrantsFor(context.database, userId)).toEqual([])
  })

  it("merges a consent and its tokens into one row, the consent winning", async () => {
    const email = "grants-merged@example.com"
    const cookie = await register(email)
    const userId = await userIdFor(email)
    await grant({ client: NAMED, cookie })

    // What a `skipConsent: false` client would have written when the user
    // said yes. Inserted directly: turning consent on for one client would
    // need a second context, and the merge is what is under test.
    const { oauthConsent } = context.database.schema
    const consentedAt = new Date("2026-01-01T00:00:00.000Z")
    await context.database.db.insert(oauthConsent).values({
      id: crypto.randomUUID(),
      clientId: NAMED.clientId,
      userId,
      scopes: ["openid", "profile"],
      createdAt: consentedAt,
      updatedAt: consentedAt,
    })

    const grants = await activeGrantsFor(context.database, userId)

    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatchObject({
      clientId: NAMED.clientId,
      hasConsent: true,
      // The consent's scopes are what the user was shown and agreed to; the
      // token's are what the client asked for afterwards.
      scopes: ["openid", "profile"],
      activeTokens: 1,
    })
    expect(grants[0]?.connectedAt.getTime()).toBe(consentedAt.getTime())
  })

  it("unions the scopes of a client's live tokens, and takes the earliest date", async () => {
    const email = "grants-union@example.com"
    const first = await register(email)
    const userId = await userIdFor(email)
    // Two sessions, two grants, two live rows for one client — the shape a
    // user who signed in to the same application from a laptop and a phone
    // ends up with. There is no consent row to speak for either.
    await grant({ client: NAMED, cookie: first })
    const second = await context.auth.handler(
      authRequest("/sign-in/email", { json: { email, password: PASSWORD } })
    )
    await grant({
      client: NAMED,
      cookie: sessionCookie(second)!,
      scope: "openid profile offline_access",
    })

    const grants = await activeGrantsFor(context.database, userId)

    // One application, not two rows of the same name.
    expect(grants).toHaveLength(1)
    expect(grants[0]?.activeTokens).toBe(2)
    // The union: what the application can do is the sum of what its live
    // tokens carry, not whichever row the planner returned first.
    expect([...(grants[0]?.scopes ?? [])].sort()).toEqual([
      "offline_access",
      "openid",
      "profile",
    ])

    const { oauthRefreshToken } = context.database.schema
    const rows = await context.database.db
      .select({
        authTime: oauthRefreshToken.authTime,
        createdAt: oauthRefreshToken.createdAt,
      })
      .from(oauthRefreshToken)
      .where(eq(oauthRefreshToken.userId, userId))
    const earliest = Math.min(
      ...rows.map((row) => (row.authTime ?? row.createdAt).getTime())
    )
    // When the connection began, not when the most recent half of it did.
    expect(grants[0]?.connectedAt.getTime()).toBe(earliest)
  })

  it("is scoped to the user asking", async () => {
    const mine = await register("grants-mine@example.com")
    await register("grants-theirs@example.com")
    const myId = await userIdFor("grants-mine@example.com")
    const theirId = await userIdFor("grants-theirs@example.com")
    await grant({ client: NAMED, cookie: mine })

    expect(await activeGrantsFor(context.database, myId)).toHaveLength(1)
    expect(await activeGrantsFor(context.database, theirId)).toEqual([])
  })
})

describe("liveTokenClientsBySession (D101)", () => {
  it("groups the names under the session that minted them", async () => {
    const email = "grants-by-session@example.com"
    const cookie = await register(email)
    const userId = await userIdFor(email)
    await grant({ client: NAMED, cookie })
    await grant({ client: UNNAMED, cookie })

    const { session } = context.database.schema
    const [row] = await context.database.db
      .select({ id: session.id })
      .from(session)
      .where(eq(session.userId, userId))

    const bySession = await liveTokenClientsBySession(context.database, userId)

    expect(bySession.size).toBe(1)
    // Sorted, and the unnamed client falls back to its id — a client the
    // reconciler has since removed is still something the user signed in to.
    expect(bySession.get(row!.id)).toEqual([NAMED.name, UNNAMED.clientId])
  })

  it("drops a token whose minting session is already gone", async () => {
    const email = "grants-orphan@example.com"
    const cookie = await register(email)
    const userId = await userIdFor(email)
    await grant({ client: NAMED, cookie })

    // What the `on delete set null` on `session_id` leaves behind. Such a
    // token belongs to no row on the sessions page; the client axis
    // (Disconnect) is what reaches it, and it is still a grant.
    const { oauthRefreshToken } = context.database.schema
    await context.database.db
      .update(oauthRefreshToken)
      .set({ sessionId: null })
      .where(eq(oauthRefreshToken.userId, userId))

    expect(
      (await liveTokenClientsBySession(context.database, userId)).size
    ).toBe(0)
    expect(await activeGrantsFor(context.database, userId)).toHaveLength(1)
  })
})
