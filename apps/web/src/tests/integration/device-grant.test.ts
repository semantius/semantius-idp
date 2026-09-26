/**
 * The RFC 8628 device grant, against a live provider and a real Postgres.
 *
 * What a CLI on a headless box does — ask for a code, have a person approve it
 * somewhere else, poll — and every place this deployment adds a rule the
 * plugin does not have: the approver's standing re-checked at redemption, an
 * impersonating administrator refused, a code claimed by one person out of
 * reach of another, the client's `user_id` pre-binding dropped, the
 * first-party session mint absent, and a verification URI that survives a
 * sub-path. The refresh token is asserted in the same flow that issues it,
 * because a device-only client silently getting none is the trap the schema's
 * `authorization_code` rule exists for.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { eq } from "drizzle-orm"
import { decodeJwt } from "jose"

import { createLogger } from "@/server/logger"
import { forwardDiscovery } from "@/server/oidc/protocol-proxy"
import { reconcileClients } from "@/server/oidc/reconcile"
import type { Runtime } from "@/server/runtime"
import type { TestContext } from "./harness"
import { authRequest, createTestContext, sessionCookie } from "./harness"

const ISSUER = "http://localhost:3000"
const DEVICE = "urn:ietf:params:oauth:grant-type:device_code"
const PASSWORD = "correct-horse-battery-staple"
const SCOPE = "openid profile email offline_access"

const CLI = {
  clientId: "cli",
  name: "Command Line",
  type: "native",
  redirectUris: ["http://127.0.0.1:53682/callback"],
  scopes: ["openid", "profile", "email", "offline_access"],
  grantTypes: ["authorization_code", "refresh_token", DEVICE],
  enableEndSession: false,
}

/** The same program, registered the way every client was before this grant. */
const BROWSER_ONLY = {
  ...CLI,
  clientId: "browser-only",
  grantTypes: undefined,
}

let context: TestContext

beforeAll(async () => {
  context = await createTestContext("device", {
    clients: [CLI, BROWSER_ONLY],
    config: {
      signUp: { enabled: true, requireApproval: false },
      auth: { requireEmailVerification: false },
      admin: { allowImpersonation: true },
      oauth: {
        scopes: ["openid", "profile", "email", "offline_access"],
        deviceAuthorization: { enabled: true },
      },
    },
  })
  await reconcileClients({
    config: context.config,
    database: context.database,
    locking: context.database,
  })
})

afterAll(async () => {
  await context.teardown()
})

async function signUpAndIn(email: string, ctx = context): Promise<string> {
  await ctx.auth.handler(
    authRequest("/sign-up/email", {
      json: { email, password: PASSWORD, name: "Device User" },
    })
  )
  const response = await ctx.auth.handler(
    authRequest("/sign-in/email", { json: { email, password: PASSWORD } })
  )
  const cookie = sessionCookie(response)
  expect(cookie, email).toBeTruthy()
  return cookie!
}

async function userId(email: string): Promise<string> {
  const { user } = context.database.schema
  const [row] = await context.database.db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
  return row!.id
}

interface JsonResponse {
  status: number
  body: Record<string, unknown>
}

async function asJson(response: Response): Promise<JsonResponse> {
  return {
    status: response.status,
    body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
  }
}

/** What the CLI sends first: no browser, no credentials, a form body. */
async function requestCode(
  fields: Record<string, string> = {},
  ctx = context,
  origin = ISSUER
): Promise<JsonResponse> {
  return asJson(
    await ctx.auth.handler(
      new Request(`${origin}/api/auth/device/code`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: CLI.clientId,
          scope: SCOPE,
          ...fields,
        }).toString(),
      })
    )
  )
}

/** What `/device` does with the code a person typed: look it up, and claim it. */
async function lookUp(userCode: string, cookie: string): Promise<JsonResponse> {
  return asJson(
    await context.auth.handler(
      authRequest(`/device?user_code=${encodeURIComponent(userCode)}`, {
        method: "GET",
        headers: { cookie },
      })
    )
  )
}

async function decide(
  decision: "approve" | "deny",
  userCode: string,
  cookie: string
): Promise<JsonResponse> {
  return asJson(
    await context.auth.handler(
      authRequest(`/device/${decision}`, {
        json: { userCode },
        headers: { cookie },
      })
    )
  )
}

async function poll(
  deviceCode: string,
  clientId = CLI.clientId
): Promise<JsonResponse> {
  // The plugin refuses a poll inside the five-second interval with
  // `slow_down`; a test that polls twice has to be allowed to.
  await context.database.db
    .update(context.database.schema.deviceCode)
    .set({ lastPolledAt: null })
    .where(eq(context.database.schema.deviceCode.deviceCode, deviceCode))
  return asJson(
    await context.auth.handler(
      new Request(`${ISSUER}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: DEVICE,
          device_code: deviceCode,
          client_id: clientId,
        }).toString(),
      })
    )
  )
}

function runtimeFor(ctx: TestContext): Runtime {
  return {
    config: ctx.config,
    auth: ctx.auth,
    logger: createLogger({ level: "error", write: () => {} }),
  } as unknown as Runtime
}

async function discovery(ctx: TestContext): Promise<Record<string, unknown>> {
  const issuer = ctx.config.base.origin + ctx.config.base.basePath
  const response = await forwardDiscovery(
    runtimeFor(ctx),
    new Request(`${issuer}/.well-known/openid-configuration`),
    "/.well-known/openid-configuration"
  )
  return (await response.json()) as Record<string, unknown>
}

describe("discovery", () => {
  it("advertises the grant and its endpoint at the issuer root when on", async () => {
    const document = await discovery(context)
    expect(document.grant_types_supported).toContain(DEVICE)
    expect(document.device_authorization_endpoint).toBe(
      `${ISSUER}/device/code`
    )
  })

  it("has neither, and no endpoint, when off (the default)", async () => {
    const off = await createTestContext("device-off")
    try {
      const document = await discovery(off)
      expect(document.grant_types_supported).not.toContain(DEVICE)
      expect(document.device_authorization_endpoint).toBeUndefined()
      expect((await requestCode({}, off)).status).toBe(404)
    } finally {
      await off.teardown()
    }
  })
})

describe("the flow a CLI takes", () => {
  it("signs a person in, with a JWT, an ID token and a working refresh token", async () => {
    const code = await requestCode()
    expect(code.status, JSON.stringify(code.body)).toBe(200)
    expect(code.body).toMatchObject({
      verification_uri: `${ISSUER}/device`,
      interval: 5,
      // `oauth.deviceCodeTtl`'s default.
      expires_in: 600,
    })
    const deviceCode = String(code.body.device_code)
    const userCode = String(code.body.user_code)

    // Bound to `jwt.audience` when it was issued, the way an authorization
    // code is. Unbound, the default the token endpoint injects arrived at
    // redemption as a resource nobody had approved: `invalid_target`.
    const [bound] = await context.database.db
      .select({ resources: context.database.schema.deviceCode.resources })
      .from(context.database.schema.deviceCode)
      .where(eq(context.database.schema.deviceCode.deviceCode, deviceCode))
    expect(bound?.resources).toEqual([ISSUER])

    // Before anybody approves, the answer is "keep waiting" — and that is not
    // a refusal the attempt bucket counts (routes/oauth2/token.ts).
    expect((await poll(deviceCode)).body.error).toBe("authorization_pending")

    const cookie = await signUpAndIn("device-flow@example.com")
    const looked = await lookUp(userCode, cookie)
    expect(looked.body).toMatchObject({
      status: "pending",
      client_id: CLI.clientId,
      scope: SCOPE,
    })
    expect((await decide("approve", userCode, cookie)).status).toBe(200)

    const tokens = await poll(deviceCode)
    expect(tokens.status, JSON.stringify(tokens.body)).toBe(200)
    const access = String(tokens.body.access_token)
    expect(access.split(".")).toHaveLength(3)
    const claims = decodeJwt(access)
    expect(claims.sub).toBe(await userId("device-flow@example.com"))
    expect(claims.azp ?? claims.client_id).toBe(CLI.clientId)
    expect([claims.aud].flat()).toContain(ISSUER)
    expect(tokens.body.id_token).toBeTruthy()
    expect(tokens.body.refresh_token).toBeTruthy()

    // The code is single-use.
    expect((await poll(deviceCode)).body.error).toBe("invalid_grant")

    const refreshed = await asJson(
      await context.auth.handler(
        new Request(`${ISSUER}/api/auth/oauth2/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: String(tokens.body.refresh_token),
            client_id: CLI.clientId,
          }).toString(),
        })
      )
    )
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200)
    expect(refreshed.body.access_token).toBeTruthy()
  })

  it("answers access_denied once the person denies it", async () => {
    const code = await requestCode()
    const cookie = await signUpAndIn("device-deny@example.com")
    await lookUp(String(code.body.user_code), cookie)
    expect(
      (await decide("deny", String(code.body.user_code), cookie)).status
    ).toBe(200)
    expect((await poll(String(code.body.device_code))).body.error).toBe(
      "access_denied"
    )
  })

  it("is refused for a client that was never given the grant", async () => {
    const code = await requestCode({ client_id: BROWSER_ONLY.clientId })
    expect(code.body.error).toBe("unauthorized_client")
  })
})

describe("what this deployment adds to the plugin", () => {
  // Suspended between approving and the CLI's next poll. The plugin looks the
  // user up and nothing more, so without the before-hook the poll collected a
  // thirty-day refresh token for a banned account.
  it("re-checks the approver's standing at redemption, without consuming the code", async () => {
    const email = "device-banned@example.com"
    const code = await requestCode()
    const cookie = await signUpAndIn(email)
    await lookUp(String(code.body.user_code), cookie)
    await decide("approve", String(code.body.user_code), cookie)

    const { user } = context.database.schema
    await context.database.db
      .update(user)
      .set({ banned: true })
      .where(eq(user.email, email))
    const refused = await poll(String(code.body.device_code))
    expect(refused.status).toBe(400)
    expect(refused.body.error).toBe("access_denied")

    // Unbanned inside the code's lifetime: the same poll now succeeds.
    await context.database.db
      .update(user)
      .set({ banned: false })
      .where(eq(user.email, email))
    expect((await poll(String(code.body.device_code))).status).toBe(200)
  })

  it("refuses an approval from an administrator signed in as somebody else", async () => {
    const adminCookie = await signUpAndIn("device-admin@example.com")
    const { user } = context.database.schema
    await context.database.db
      .update(user)
      .set({ role: "admin" })
      .where(eq(user.email, "device-admin@example.com"))
    await signUpAndIn("device-subject@example.com")

    const impersonating = await context.auth.handler(
      authRequest("/admin/impersonate-user", {
        json: { userId: await userId("device-subject@example.com") },
        headers: { cookie: adminCookie },
      })
    )
    expect(impersonating.status).toBe(200)
    const asSubject = sessionCookie(impersonating)!

    const code = await requestCode()
    const userCode = String(code.body.user_code)
    await lookUp(userCode, asSubject)
    const refused = await decide("approve", userCode, asSubject)
    expect(refused.status).toBe(403)
    expect(refused.body.code).toBe("IMPERSONATED_SESSION")
  })

  it("keeps a code claimed by one person out of another's reach", async () => {
    const code = await requestCode()
    const userCode = String(code.body.user_code)
    const first = await signUpAndIn("device-first@example.com")
    const second = await signUpAndIn("device-second@example.com")

    expect((await lookUp(userCode, first)).body.client_id).toBe(CLI.clientId)
    // The second person sees the code exists and nothing about it…
    expect((await lookUp(userCode, second)).body.client_id).toBeUndefined()
    // …and cannot decide it.
    expect((await decide("approve", userCode, second)).status).toBe(403)
  })

  it("refuses a client that tries to pre-bind a code to a chosen account", async () => {
    await signUpAndIn("device-target@example.com")
    const code = await requestCode({
      user_id: await userId("device-target@example.com"),
    })
    // The first signed-in person to look a code up claims it, which is the
    // only way a code is ever meant to find its user.
    expect(code.status).toBe(400)
    expect(code.body.error).toBe("invalid_request")
  })

  it("does not serve the plugin's first-party session mint", async () => {
    const response = await context.auth.handler(
      new Request(`${ISSUER}/api/auth/device/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: DEVICE,
          device_code: "anything",
          client_id: CLI.clientId,
        }),
      })
    )
    expect(response.status).toBe(404)
  })
})

describe("under a sub-path", () => {
  // The plugin's default resolves `/device` against the origin, which put the
  // page at the host root — outside the mount, on nobody's page.
  it("points the user at the page inside the mount", async () => {
    const sub = await createTestContext("device-subpath", {
      clients: [CLI],
      config: {
        server: { baseUrl: "http://localhost:3000/idp" },
        jwt: { audience: "http://localhost:3000/idp" },
        oauth: { deviceAuthorization: { enabled: true } },
      },
    })
    try {
      await reconcileClients({
        config: sub.config,
        database: sub.database,
        locking: sub.database,
      })
      const response = await sub.auth.handler(
        new Request("http://localhost:3000/idp/api/auth/device/code", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: CLI.clientId,
            scope: "openid",
          }).toString(),
        })
      )
      const body = (await response.json()) as Record<string, string>
      expect(response.status, JSON.stringify(body)).toBe(200)
      expect(body.verification_uri).toBe("http://localhost:3000/idp/device")
      expect(body.verification_uri_complete).toBe(
        `http://localhost:3000/idp/device?user_code=${body.user_code}`
      )
      expect((await discovery(sub)).device_authorization_endpoint).toBe(
        "http://localhost:3000/idp/device/code"
      )
    } finally {
      await sub.teardown()
    }
  })
})
