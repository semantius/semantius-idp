/**
 * Which tokens a sign-out takes with it (FR-AUTH-6, FR-OIDC-12).
 *
 * `session.revokeOAuthTokensOnLogout` is off by default, and the scope when it
 * is on is the part worth testing: signing out on a laptop must not log the
 * phone out of every connected application, so the revocation is bounded by
 * the *session*, not the user.
 */

import { describe, expect, it } from "vitest"

import { createHash, randomBytes } from "node:crypto"

import { and, eq, isNull } from "drizzle-orm"

import { createLocalAccountIssuer } from "@better-auth/core/db"

import { createUserWithoutRequest } from "@/server/auth/provisioning"
import { reconcileClients } from "@/server/oidc/reconcile"
import { revokeForSession } from "@/server/oidc/revoke-user-tokens"
import type { TestContext } from "./harness"
import { authRequest, createTestContext, sessionCookie } from "./harness"

const ISSUER = "http://localhost:3000"
const SECRET = "logout-client-secret-of-at-least-32-chars"
const PASSWORD = "correct-horse-battery-staple"
const REDIRECT = "https://app.example.com/callback"
const EMAIL = "logout-user@example.com"

const CLIENT = {
  clientId: "logout-app",
  type: "web",
  clientSecret: SECRET,
  redirectUris: [REDIRECT],
  scopes: ["openid", "profile", "email", "offline_access"],
  enableEndSession: false,
}

async function contextWith(
  label: string,
  session: Record<string, unknown> = {}
): Promise<TestContext> {
  const context = await createTestContext(label, {
    clients: [CLIENT],
    config: {
      signUp: { enabled: true, requireApproval: false },
      auth: { requireEmailVerification: false },
      session,
      oauth: { scopes: ["openid", "profile", "email", "offline_access"] },
    },
  })
  await reconcileClients({
    config: context.config,
    database: context.database,
    locking: context.database,
  })
  return context
}

/** Registers, signs in twice, and returns both session cookies. */
async function twoSessions(context: TestContext): Promise<[string, string]> {
  await context.auth.handler(
    authRequest("/sign-up/email", {
      json: { email: EMAIL, password: PASSWORD, name: "Logout User" },
    })
  )
  const cookies: string[] = []
  for (let i = 0; i < 2; i++) {
    const response = await context.auth.handler(
      authRequest("/sign-in/email", {
        json: { email: EMAIL, password: PASSWORD },
      })
    )
    const cookie = sessionCookie(response)
    expect(cookie).toBeTruthy()
    cookies.push(cookie!)
  }
  return [cookies[0]!, cookies[1]!]
}

/** One authorization-code exchange on the given session. */
async function grant(context: TestContext, cookie: string): Promise<void> {
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

async function liveRefreshTokens(context: TestContext): Promise<number> {
  const { oauthRefreshToken } = context.database.schema
  const rows = await context.database.db
    .select({ id: oauthRefreshToken.id })
    .from(oauthRefreshToken)
    .where(
      and(
        eq(oauthRefreshToken.clientId, CLIENT.clientId),
        isNull(oauthRefreshToken.revoked)
      )
    )
  return rows.length
}

describe("revokeOAuthTokensOnLogout (FR-AUTH-6)", () => {
  it("revokes only the tokens the session obtained", async () => {
    const context = await contextWith("logout_revoke_on", {
      revokeOAuthTokensOnLogout: true,
    })
    try {
      const [laptop, phone] = await twoSessions(context)
      await grant(context, laptop)
      await grant(context, phone)
      expect(await liveRefreshTokens(context)).toBe(2)

      const signedOut = await context.auth.handler(
        authRequest("/sign-out", { headers: { cookie: laptop }, json: {} })
      )
      expect(signedOut.status).toBe(200)

      // The phone keeps its grant. Revoking the user's whole footprint here
      // would be a different, much blunter, requirement.
      expect(await liveRefreshTokens(context)).toBe(1)
    } finally {
      await context.teardown()
    }
  })

  it("leaves them alone when the option is off, which is the default", async () => {
    const context = await contextWith("logout_revoke_off")
    try {
      const [laptop] = await twoSessions(context)
      await grant(context, laptop)
      expect(await liveRefreshTokens(context)).toBe(1)

      await context.auth.handler(
        authRequest("/sign-out", { headers: { cookie: laptop }, json: {} })
      )
      // A connected application keeps working after the browser session ends;
      // that is what "offline access" means.
      expect(await liveRefreshTokens(context)).toBe(1)
    } finally {
      await context.teardown()
    }
  })

  it("records what it revoked (SEC-6)", async () => {
    const context = await contextWith("logout_revoke_audit", {
      revokeOAuthTokensOnLogout: true,
    })
    try {
      const [laptop] = await twoSessions(context)
      await grant(context, laptop)
      await context.auth.handler(
        authRequest("/sign-out", { headers: { cookie: laptop }, json: {} })
      )

      const rows = await context.database.db
        .select()
        .from(context.database.schema.auditLog)
        .where(eq(context.database.schema.auditLog.action, "token.revoked"))
      expect(rows.length).toBeGreaterThan(0)
      expect(rows[0]?.metadata).toMatchObject({
        scope: "session",
        reason: "logout",
      })
    } finally {
      await context.teardown()
    }
  })
})

/**
 * "Sign them out everywhere" means everywhere, whoever asks (**D67**).
 *
 * `docs/admin-api.md` documents `/admin/revoke-user-sessions` as signing a
 * user out everywhere, and FR-ADMIN-6 makes the admin API a supported
 * interface — so the promise has to hold for a `curl` and not only for the
 * button on `/admin/users/:id`.
 *
 * It did not. Better Auth's admin plugin deletes `session` rows and knows
 * nothing about this deployment's tokens, and the OAuth half of the action was
 * written inside the *route handler* behind the button. A direct call never
 * went through it: the browser session ended and the refresh token went on
 * minting access tokens. The revocation moved into the guard's `after` hook,
 * which runs for every caller, and this is the test that says so.
 */
describe("an administrator revoking sessions (FR-OIDC-12, D67)", () => {
  /** An administrator with a credential, made the way `admin.test.ts` does. */
  async function makeAdmin(context: TestContext): Promise<string> {
    const inner = await context.auth.$context
    const user = await createUserWithoutRequest(
      inner,
      {
        email: "revoker@example.com",
        name: "Revoker",
        emailVerified: true,
        role: "admin",
        status: "active",
      },
      { method: "admin" }
    )
    await inner.internalAdapter.createAccount({
      userId: user.id,
      providerId: "credential",
      issuer: createLocalAccountIssuer("credential"),
      accountId: user.id,
      password: await inner.password.hash(PASSWORD),
    })
    const signedIn = await context.auth.handler(
      authRequest("/sign-in/email", {
        json: { email: "revoker@example.com", password: PASSWORD },
      })
    )
    const cookie = sessionCookie(signedIn)
    expect(cookie, "the administrator must be able to sign in").toBeTruthy()
    return cookie!
  }

  it("revokes the user's OAuth tokens, called directly over the API", async () => {
    const context = await contextWith("admin_revoke_sessions")
    try {
      const [laptop, phone] = await twoSessions(context)
      await grant(context, laptop)
      await grant(context, phone)
      expect(await liveRefreshTokens(context)).toBe(2)

      const [target] = await context.database.db
        .select({ id: context.database.schema.user.id })
        .from(context.database.schema.user)
        .where(eq(context.database.schema.user.email, EMAIL))
      expect(target?.id).toBeTruthy()

      const admin = await makeAdmin(context)
      const revoked = await context.auth.handler(
        authRequest("/admin/revoke-user-sessions", {
          json: { userId: target!.id },
          headers: { cookie: admin },
        })
      )
      expect(revoked.status).toBe(200)

      // Both of them, and not because a route handler happened to be in the
      // way: this request never touched one.
      expect(await liveRefreshTokens(context)).toBe(0)
    } finally {
      await context.teardown()
    }
  })
})

/**
 * The two properties `revokeForSession` has to hold on its own (**D101**).
 *
 * Both are about the WHERE rather than about a caller: a revocation that a
 * refresh can walk out from under is not a revocation, and a scope enforced
 * only by whoever calls it is one careless caller away from reaching the wrong
 * account.
 */
describe("revokeForSession's scope (D101)", () => {
  /** The refresh token an authorization-code exchange handed back. */
  async function grantReturning(
    context: TestContext,
    cookie: string
  ): Promise<string> {
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
    const body = (await exchanged.json()) as { refresh_token?: string }
    expect(body.refresh_token).toBeTruthy()
    return body.refresh_token!
  }

  async function sessionIdFor(
    context: TestContext,
    cookie: string
  ): Promise<string> {
    const result = await context.auth.api.getSession({
      headers: new Headers({ cookie }),
    })
    const id = (result?.session as { id?: string } | undefined)?.id
    expect(id, "the cookie should resolve to a session").toBeTruthy()
    return id!
  }

  it("survives a rotation, because the new row inherits the session", async () => {
    const context = await contextWith("revoke_after_rotation")
    try {
      const [laptop] = await twoSessions(context)
      const first = await grantReturning(context, laptop)

      // A refresh writes a *new* row and stamps the old one `revoked`. The
      // new one carries `session_id` across, which is the property this
      // scope rests on: revoke by session after any number of refreshes and
      // the newest token is the one that dies.
      const refreshed = await context.auth.handler(
        new Request(`${ISSUER}/api/auth/oauth2/token`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: ISSUER,
            authorization: `Basic ${Buffer.from(`${CLIENT.clientId}:${SECRET}`).toString("base64")}`,
          },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: first,
          }).toString(),
        })
      )
      expect(refreshed.status).toBe(200)
      expect(await liveRefreshTokens(context)).toBe(1)

      const [target] = await context.database.db
        .select({ id: context.database.schema.user.id })
        .from(context.database.schema.user)
        .where(eq(context.database.schema.user.email, EMAIL))

      await revokeForSession(
        { database: context.database, audit: context.audit },
        {
          sessionId: await sessionIdFor(context, laptop),
          userId: target!.id,
          reason: "session_revoked_by_user",
        }
      )
      expect(await liveRefreshTokens(context)).toBe(0)
    } finally {
      await context.teardown()
    }
  })

  it("revokes nothing when the session and the user do not belong together", async () => {
    const context = await contextWith("revoke_wrong_owner")
    try {
      const [laptop] = await twoSessions(context)
      await grantReturning(context, laptop)
      expect(await liveRefreshTokens(context)).toBe(1)

      const result = await revokeForSession(
        { database: context.database, audit: context.audit },
        {
          sessionId: await sessionIdFor(context, laptop),
          // A real user id, and not this session's owner.
          userId: "somebody-else",
          reason: "session_revoked_by_user",
        }
      )

      expect(result).toEqual({ accessTokens: 0, refreshTokens: 0 })
      expect(await liveRefreshTokens(context)).toBe(1)
    } finally {
      await context.teardown()
    }
  })
})
