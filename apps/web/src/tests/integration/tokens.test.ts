/**
 * What the tokens actually contain, against a live provider
 * (FR-OIDC-5/6/7/8/12/13, FR-KEY-3, risks R1, R5, D32).
 *
 * These are the protocol proof points. Everything here is asserted against a
 * token that was really issued and really verifies against the published
 * JWKS — not against the code that builds it, which would only prove the code
 * agrees with itself.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createHash, randomBytes } from "node:crypto"

import { and, eq, isNull } from "drizzle-orm"
import {
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  jwtVerify,
} from "jose"

import { reconcileClients } from "@/server/oidc/reconcile"
import {
  backdateFamily,
  revokeExpiredRefreshFamilies,
} from "@/server/oidc/refresh-lifetime"
import type { TestContext } from "./harness"
import { authRequest, createTestContext, sessionCookie } from "./harness"

const ISSUER = "http://localhost:3000"
const SECRET = "tokens-client-secret-of-at-least-32-chars"
const EMAIL = "token-user@example.com"
const PASSWORD = "correct-horse-battery-staple"
const REDIRECT = "https://app.example.com/callback"

const CLIENT = {
  clientId: "token-app",
  type: "web",
  name: "Token App",
  clientSecret: SECRET,
  redirectUris: [REDIRECT],
  scopes: ["openid", "profile", "email", "offline_access"],
  enableEndSession: false,
}

let context: TestContext
let cookie: string

beforeAll(async () => {
  context = await createTestContext("tokens", {
    clients: [CLIENT],
    config: {
      signUp: { enabled: true, requireApproval: false },
      auth: { requireEmailVerification: false },
      // Deliberately *not* the "idp" default. `azp` for a key exchange is
      // supposed to be this value, and with the default the assertion below
      // would pass whether the discriminator worked or not — which is exactly
      // how it passed for two milestones while it did not.
      apiKeys: { tokenClientId: "api-key-client" },
      oauth: {
        scopes: ["openid", "profile", "email", "offline_access"],
        resources: [
          {
            identifier: "https://api.example.com",
            name: "Example API",
            accessTokenTtl: "5m",
          },
        ],
      },
    },
  })

  // The provider seeds `oauth_resource` on init; reconciliation links the
  // client to it, which `enforcePerClientResources` requires.
  await reconcileClients({
    config: {
      ...context.config,
      clients: [{ ...context.config.clients[0]!, resourceServer: true }],
    },
    database: context.database,
    locking: context.database,
  })

  await context.auth.handler(
    authRequest("/sign-up/email", {
      json: { email: EMAIL, password: PASSWORD, name: "Ada Lovelace" },
    })
  )
  await context.database.db
    .update(context.database.schema.user)
    .set({ firstName: "Ada", lastName: "Lovelace", role: "admin,user" })
    .where(eq(context.database.schema.user.email, EMAIL))

  const response = await context.auth.handler(
    authRequest("/sign-in/email", {
      json: { email: EMAIL, password: PASSWORD },
    })
  )
  cookie = sessionCookie(response)!
  expect(cookie).toBeTruthy()
})

afterAll(async () => {
  await context.teardown()
})

interface CodeResult {
  code: string
  verifier: string
}

async function authorize(
  extra: Record<string, string> = {}
): Promise<CodeResult> {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const query = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT.clientId,
    redirect_uri: REDIRECT,
    scope: "openid profile email",
    state: "state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...extra,
  })
  const response = await context.auth.handler(
    new Request(`${ISSUER}/api/auth/oauth2/authorize?${query.toString()}`, {
      headers: { cookie },
      redirect: "manual",
    })
  )
  const location = response.headers.get("location") ?? ""
  const url = new URL(location)
  const error = url.searchParams.get("error")
  expect(
    error,
    `authorize failed: ${error} ${url.searchParams.get("error_description") ?? ""}`
  ).toBeNull()
  return { code: url.searchParams.get("code") ?? "", verifier }
}

interface TokenResponse {
  status: number
  body: Record<string, unknown>
}

async function token(
  params: Record<string, string>,
  secret: string = SECRET
): Promise<TokenResponse> {
  const response = await context.auth.handler(
    new Request(`${ISSUER}/api/auth/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: ISSUER,
        authorization: `Basic ${Buffer.from(`${CLIENT.clientId}:${secret}`).toString("base64")}`,
      },
      body: new URLSearchParams(params).toString(),
    })
  )
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  }
}

async function exchange(
  extra: Record<string, string> = {}
): Promise<Record<string, unknown>> {
  const { code, verifier } = await authorize(extra)
  const result = await token({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
    ...(extra.resource ? { resource: extra.resource } : {}),
  })
  expect(result.status, JSON.stringify(result.body)).toBe(200)
  return result.body
}

/** The published key set, as a verifier would fetch it. */
async function jwks() {
  const response = await context.auth.handler(
    new Request(`${ISSUER}/api/auth/jwks`)
  )
  return createLocalJWKSet(
    (await response.json()) as { keys: Record<string, unknown>[] }
  )
}

describe("access tokens (FR-OIDC-5/6, risk R1, D32)", () => {
  it("is a JWT even though the client sent no resource", async () => {
    // R1: without a `resource` the provider issues an *opaque* token. The
    // before-hook supplies `jwt.audience`, which is what makes this a JWT at
    // all — three dots is the entire assertion.
    const tokens = await exchange()
    const accessToken = String(tokens.access_token)
    expect(accessToken.split(".")).toHaveLength(3)
  })

  it("verifies against the published JWKS for the configured audience", async () => {
    const tokens = await exchange()
    const { payload, protectedHeader } = await jwtVerify(
      String(tokens.access_token),
      await jwks(),
      { issuer: ISSUER, audience: ISSUER }
    )

    // FR-OIDC-5: Neon and PostgREST take ES256, and need a `kid` to select
    // the key from the set.
    expect(protectedHeader.alg).toBe("ES256")
    expect(protectedHeader.kid).toBeTruthy()
    // `iss` must be byte-equal to the issuer a verifier was configured with.
    expect(payload.iss).toBe(ISSUER)
  })

  it("carries jwt.audience in aud, alongside the implicit userinfo one (D32)", async () => {
    const tokens = await exchange()
    const payload = decodeJwt(String(tokens.access_token))
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud]

    expect(aud).toContain(ISSUER)
    // The provider appends its own userinfo endpoint whenever `openid` is
    // requested and offers no way to suppress it; `jwt.sign`, which S1
    // planned to normalize it in, cannot be used without moving the key set
    // off this deployment. Recorded as D32 — every RFC 7519 §4.1.3 verifier
    // checks `aud` by membership, which is what the test above proves.
    expect(aud).toContain(`${ISSUER}/api/auth/oauth2/userinfo`)
  })

  it("is still accepted by userinfo (D32)", async () => {
    const tokens = await exchange()
    const response = await context.auth.handler(
      new Request(`${ISSUER}/api/auth/oauth2/userinfo`, {
        headers: { authorization: `Bearer ${String(tokens.access_token)}` },
      })
    )
    expect(response.status).toBe(200)
    const profile = (await response.json()) as { sub?: string }
    expect(profile.sub).toBeTruthy()
  })

  it("honors a resource the client is linked to, and refuses one it is not", async () => {
    const allowed = await exchange({ resource: "https://api.example.com" })
    const payload = decodeJwt(String(allowed.access_token))
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
    expect(aud).toContain("https://api.example.com")

    const { code, verifier } = await authorize()
    const refused = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      resource: "https://not-configured.example.com",
    })
    expect(refused.body.error).toBe("invalid_target")
  })

  it("uses the resource's own TTL when it declares one (FR-OIDC-13)", async () => {
    const tokens = await exchange({ resource: "https://api.example.com" })
    const payload = decodeJwt(String(tokens.access_token))
    const lifetime = Number(payload.exp) - Number(payload.iat)
    // The resource says 5 minutes; `oauth.accessTokenTtl` says 15.
    expect(lifetime).toBeLessThanOrEqual(300)
    expect(lifetime).toBeGreaterThan(240)
  })
})

describe("user claims (FR-OIDC-7, FR-ROLE-2)", () => {
  it("carries exactly the configured claim set", async () => {
    const tokens = await exchange()
    const payload = decodeJwt(String(tokens.access_token))
    expect(payload.email).toBe(EMAIL)
    expect(payload.name).toBe("Ada Lovelace")
    expect(payload.given_name).toBe("Ada")
    expect(payload.family_name).toBe("Lovelace")
    expect(payload.roles).toEqual(["admin", "user"])
  })

  it("does not let a custom claim shadow a protocol claim (S5 §2)", async () => {
    const tokens = await exchange()
    const payload = decodeJwt(String(tokens.access_token))
    // The builder never emits these; the provider writes them over whatever
    // custom claims produced, which is why it must not try.
    expect(payload.sub).toBeTruthy()
    expect(payload.client_id).toBe(CLIENT.clientId)
    expect(payload.azp).toBe(CLIENT.clientId)
    expect(payload.jti).toBeTruthy()
  })

  it("keeps the ID token free of user claims unless asked (FR-OIDC-7)", async () => {
    const tokens = await exchange()
    const idToken = decodeJwt(String(tokens.id_token))
    // `claimsInIdToken` is false by default: an ID token is an assertion
    // about authentication, and profile data belongs at userinfo.
    expect(idToken.email).toBeUndefined()
    expect(idToken.roles).toBeUndefined()
    // What it must carry.
    expect(idToken.sub).toBeTruthy()
    expect(idToken.aud).toBe(CLIENT.clientId)
    expect(idToken.iss).toBe(ISSUER)
  })
})

describe("the three token shapes (FR-OIDC-7, FR-KEY-3)", () => {
  it("differ only in sub, sid, azp and scope", async () => {
    const tokens = await exchange()
    const access = decodeJwt(String(tokens.access_token))

    const sessionToken = await context.auth.handler(
      new Request(`${ISSUER}/api/auth/token`, { headers: { cookie } })
    )
    expect(sessionToken.status).toBe(200)
    const session = (await sessionToken.json()) as { token: string }
    const sessionPayload = decodeJwt(session.token)

    const userClaims = (payload: Record<string, unknown>) => ({
      email: payload.email,
      name: payload.name,
      given_name: payload.given_name,
      family_name: payload.family_name,
      roles: payload.roles,
    })

    // The whole point of one builder: a resource server reading `roles` does
    // not have to know which endpoint minted the token it is holding.
    expect(userClaims(sessionPayload)).toEqual(userClaims(access))
    expect(sessionPayload.iss).toBe(access.iss)

    // And the allowed differences really are different.
    expect(sessionPayload.azp).not.toBe(access.azp)
    expect(sessionPayload.scope).toBe("openid profile email")
    expect(sessionPayload.sid).toBeTruthy()
  })

  it("verifies against the same key set as an access token", async () => {
    const response = await context.auth.handler(
      new Request(`${ISSUER}/api/auth/token`, { headers: { cookie } })
    )
    const { token: sessionToken } = (await response.json()) as { token: string }
    const header = decodeProtectedHeader(sessionToken)
    expect(header.alg).toBe("ES256")
    await expect(
      jwtVerify(sessionToken, await jwks(), { issuer: ISSUER })
    ).resolves.toBeTruthy()
  })
})

describe("refresh tokens (FR-OIDC-8/13)", () => {
  it("is only issued for offline_access", async () => {
    const withoutOffline = await exchange()
    expect(withoutOffline.refresh_token).toBeUndefined()

    const withOffline = await exchange({
      scope: "openid profile email offline_access",
    })
    expect(withOffline.refresh_token).toBeTruthy()
  })

  it("rotates on use, and reuse revokes the family", async () => {
    const tokens = await exchange({
      scope: "openid profile email offline_access",
    })
    const first = String(tokens.refresh_token)

    const rotated = await token({
      grant_type: "refresh_token",
      refresh_token: first,
    })
    expect(rotated.status).toBe(200)
    const second = String(rotated.body.refresh_token)
    expect(second).not.toBe(first)

    // Presenting the spent token is the classic stolen-token signal.
    const replay = await token({
      grant_type: "refresh_token",
      refresh_token: first,
    })
    expect(replay.status).toBeGreaterThanOrEqual(400)

    // And the family goes with it: the *rotated* token must not survive the
    // replay of its predecessor.
    const afterReplay = await token({
      grant_type: "refresh_token",
      refresh_token: second,
    })
    expect(afterReplay.status).toBeGreaterThanOrEqual(400)
  })

  it("re-validates scopes against the client's current allowance", async () => {
    const tokens = await exchange({
      scope: "openid profile email offline_access",
    })
    const refused = await token({
      grant_type: "refresh_token",
      refresh_token: String(tokens.refresh_token),
      // Never granted, and not in the client's list.
      scope: "openid admin:everything",
    })
    expect(refused.status).toBeGreaterThanOrEqual(400)
  })
})

describe("revocation (FR-OIDC-12, FR-AUTH-3)", () => {
  it("a password change kills the refresh token", async () => {
    const tokens = await exchange({
      scope: "openid profile email offline_access",
    })
    const refresh = String(tokens.refresh_token)

    const changed = await context.auth.handler(
      authRequest("/change-password", {
        headers: { cookie },
        json: {
          currentPassword: PASSWORD,
          newPassword: "an-entirely-different-password",
          revokeOtherSessions: false,
        },
      })
    )
    expect(changed.status).toBe(200)

    const afterChange = await token({
      grant_type: "refresh_token",
      refresh_token: refresh,
    })
    expect(afterChange.status).toBeGreaterThanOrEqual(400)

    const rows = await context.database.db
      .select()
      .from(context.database.schema.oauthRefreshToken)
      .where(
        and(
          eq(
            context.database.schema.oauthRefreshToken.clientId,
            CLIENT.clientId
          ),
          isNull(context.database.schema.oauthRefreshToken.revoked)
        )
      )
    expect(rows).toHaveLength(0)

    // Put it back so the rest of the file keeps working.
    await context.auth.handler(
      authRequest("/change-password", {
        headers: { cookie },
        json: {
          currentPassword: "an-entirely-different-password",
          newPassword: PASSWORD,
          revokeOtherSessions: false,
        },
      })
    )
  })

  it("revokes a real token, and the provider still answers 400 for an unknown one", async () => {
    const tokens = await exchange({
      scope: "openid profile email offline_access",
    })
    const revoked = await revoke(String(tokens.refresh_token))
    expect(revoked.status).toBe(200)

    const afterRevoke = await token({
      grant_type: "refresh_token",
      refresh_token: String(tokens.refresh_token),
    })
    expect(afterRevoke.status).toBeGreaterThanOrEqual(400)

    // RFC 7009 §2.2 is explicit that an *unknown* token is a success, so a
    // client cannot use the endpoint as an oracle for which tokens exist.
    // 1.7.1 answers `400 invalid_request "token not found"`. This asserts the
    // behavior as it stands so that M8c's issuer-root delegate, which
    // normalizes it to 200, is a visible change rather than a silent one.
    const unknown = await revoke("not-a-token")
    expect(unknown.status).toBe(400)
    expect(JSON.parse(unknown.body).error).toBe("invalid_request")
  })
})

describe("the absolute refresh lifetime (FR-OIDC-13)", () => {
  it("revokes a family that has outlived the maximum, however recently it rotated", async () => {
    const tokens = await exchange({
      scope: "openid profile email offline_access",
    })
    const refresh = String(tokens.refresh_token)

    // Rotate once, so the newest token in the family is seconds old — which
    // is the whole point: a sliding window alone would keep this alive for
    // ever, and the ceiling is measured from the family's origin instead.
    const rotated = await token({
      grant_type: "refresh_token",
      refresh_token: refresh,
    })
    expect(rotated.status).toBe(200)
    const current = String(rotated.body.refresh_token)

    const { oauthRefreshToken } = context.database.schema
    const [row] = await context.database.db
      .select({ familyId: oauthRefreshToken.authorizationCodeId })
      .from(oauthRefreshToken)
      .where(isNull(oauthRefreshToken.revoked))
      .limit(1)
    expect(row?.familyId).toBeTruthy()

    await backdateFamily(
      context.database,
      row!.familyId!,
      new Date(Date.now() - 100 * 86_400_000)
    )

    const swept = await revokeExpiredRefreshFamilies({
      config: context.config,
      database: context.database,
    })
    expect(
      swept,
      "the sweep itself must find the over-age family"
    ).toBeGreaterThan(0)

    const afterCeiling = await token({
      grant_type: "refresh_token",
      refresh_token: current,
    })
    expect(afterCeiling.status).toBeGreaterThanOrEqual(400)
  })
})

describe("the session JWT from an API key (FR-KEY-3)", () => {
  it("carries the same user claims, and says who is presenting it", async () => {
    const created = await context.auth.handler(
      authRequest("/api-key/create", {
        headers: { cookie },
        json: { name: "Token test key" },
      })
    )
    expect(created.status).toBe(200)
    const { key } = (await created.json()) as { key: string }

    const response = await context.auth.handler(
      new Request(`${ISSUER}/api/auth/token`, { headers: { "x-api-key": key } })
    )
    expect(response.status).toBe(200)
    const { token: jwt } = (await response.json()) as { token: string }
    const payload = decodeJwt(jwt)

    expect(payload.email).toBe(EMAIL)
    expect(payload.roles).toEqual(["admin", "user"])
    // `azp` is the honest answer to "who is presenting this": a key exchange
    // is not the browser session it borrows, so it carries the configured
    // `apiKeys.tokenClientId` — and never the IdP's own id, which is what a
    // JWT minted from a real browser session says.
    expect(payload.azp).toBe("api-key-client")
    expect(payload.azp).not.toBe("idp")
    expect(payload.sid).toBeTruthy()

    await expect(
      jwtVerify(jwt, await jwks(), { issuer: ISSUER })
    ).resolves.toBeTruthy()

    // The other half of the same claim: the identical endpoint, reached with a
    // browser session instead of a key, says the IdP is presenting it. Without
    // this the assertion above only proves that *some* constant is emitted.
    const fromSession = await context.auth.handler(
      new Request(`${ISSUER}/api/auth/token`, { headers: { cookie } })
    )
    expect(fromSession.status).toBe(200)
    const { token: sessionJwt } = (await fromSession.json()) as {
      token: string
    }
    expect(decodeJwt(sessionJwt).azp).toBe("idp")
  })
})

async function revoke(
  value: string
): Promise<{ status: number; body: string }> {
  const response = await context.auth.handler(
    new Request(`${ISSUER}/api/auth/oauth2/revoke`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: ISSUER,
        authorization: `Basic ${Buffer.from(`${CLIENT.clientId}:${SECRET}`).toString("base64")}`,
      },
      body: new URLSearchParams({ token: value }).toString(),
    })
  )
  return { status: response.status, body: await response.text() }
}

describe("grants that do not exist (D26)", () => {
  it("refuses client_credentials", async () => {
    const result = await token({
      grant_type: "client_credentials",
      scope: "openid",
    })
    expect(result.status).toBeGreaterThanOrEqual(400)
    expect(String(result.body.error)).toMatch(
      /unsupported_grant_type|invalid_grant|unauthorized_client/
    )
  })

  it("refuses a replayed authorization code", async () => {
    const { code, verifier } = await authorize()
    const first = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    })
    expect(first.status).toBe(200)

    const replay = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    })
    expect(replay.status).toBeGreaterThanOrEqual(400)
  })
})
