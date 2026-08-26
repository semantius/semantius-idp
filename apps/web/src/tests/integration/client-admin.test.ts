import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createLocalAccountIssuer } from "@better-auth/core/db"
import { eq } from "drizzle-orm"

import { createUserWithoutRequest } from "@/server/auth/provisioning"
import { clearDatabaseClientOrigins, clientOrigins } from "@/server/http/cors"
import { reconcileClients } from "@/server/oidc/reconcile"
import type { TestContext } from "./harness"
import { authRequest, createTestContext, sessionCookie } from "./harness"

/**
 * Registering OAuth clients from the admin area (**D50**, FR-OIDC-2/4/17,
 * SEC-4).
 *
 * The feature rests on one column — `oauth_client.user_id` — and on the fact
 * that reconciliation's orphan sweep has always been scoped to rows where it is
 * null. Everything here exists to keep that true, plus the one gap the design
 * review found: the origin set behind CORS and the CSP `form-action` list read
 * the configuration file and nothing else, so a database client's login would
 * have failed in Chrome with nothing in the log naming an origin.
 */

const PASSWORD = "correct-horse-battery-staple"

const FILE_CLIENT = {
  clientId: "file-app",
  type: "web",
  name: "File App",
  clientSecret: "file-client-secret-of-at-least-32-chars",
  redirectUris: ["https://file.example.com/callback"],
  // The schema refuses `enableEndSession` (its default) with no post-logout
  // URI, and this client has nothing to say about logout.
  enableEndSession: false,
}

let ctx: TestContext

beforeEach(async () => {
  clearDatabaseClientOrigins()
  ctx = await createTestContext("client-admin", {
    clients: [FILE_CLIENT],
    config: {
      auth: { requireEmailVerification: false },
      oauth: { scopes: ["openid", "profile", "email", "offline_access"] },
    },
  })
})

afterEach(async () => {
  await ctx.teardown()
  clearDatabaseClientOrigins()
})

async function adminCookie(): Promise<string> {
  const context = await ctx.auth.$context
  const user = await createUserWithoutRequest(
    context,
    {
      email: "client-admin@example.com",
      name: "Client Admin",
      emailVerified: true,
      role: "admin",
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

  const response = await ctx.auth.handler(
    authRequest("/sign-in/email", {
      json: { email: "client-admin@example.com", password: PASSWORD },
    })
  )
  const cookie = sessionCookie(response)
  expect(cookie, "the admin could not sign in").toBeTruthy()
  return cookie!
}

function post(path: string, json: unknown, cookie?: string) {
  return ctx.auth.handler(
    authRequest(path, { json, ...(cookie ? { headers: { cookie } } : {}) })
  )
}

const NEW_CLIENT = {
  clientId: "registered-app",
  name: "Registered App",
  type: "web",
  redirectUris: ["https://registered.example.com/callback"],
  scopes: ["openid", "profile"],
  // What the admin form sends: it collects no post-logout URIs, and the schema
  // refuses end-session without one.
  enableEndSession: false,
}

async function create(cookie: string, overrides: Record<string, unknown> = {}) {
  return post("/idp/create-client", { ...NEW_CLIENT, ...overrides }, cookie)
}

async function rowFor(clientId: string) {
  const [row] = await ctx.database.db
    .select()
    .from(ctx.database.schema.oauthClient)
    .where(eq(ctx.database.schema.oauthClient.clientId, clientId))
  return row
}

describe("registering a client (D50)", () => {
  it("stores the form's field set as the form now sends it (round 2, finding 10)", async () => {
    const cookie = await adminCookie()

    // Exactly what the create dialog posts once it grew the two checkboxes and
    // the post-logout textarea it had always been read for. Before that the
    // handler sent `skipConsent: false` with no field to send it from — a
    // *defined* false, which overrides the schema's default of true, so every
    // client registered here wrongly asked for consent (FR-OIDC-3/10).
    const response = await create(cookie, {
      clientId: "form-shaped-app",
      type: "spa",
      redirectUris: ["https://spa.example.com/callback"],
      postLogoutRedirectUris: ["https://spa.example.com/after-logout"],
      skipConsent: true,
      enableEndSession: true,
    })
    expect(response.status, await response.text()).toBe(200)

    const row = await rowFor("form-shaped-app")
    expect(row!.skipConsent).toBe(true)
    expect(row!.enableEndSession).toBe(true)
    expect(row!.postLogoutRedirectUris).toEqual([
      "https://spa.example.com/after-logout",
    ])
    // An SPA is a public client: no secret at rest, PKCE mandatory. This is
    // the shape the dialog now defaults to.
    expect(row!.clientSecret).toBeNull()
    expect(row!.requirePKCE).toBe(true)
  })

  it("still refuses end-session with no post-logout URI, which is why it defaults off", async () => {
    const cookie = await adminCookie()
    const response = await create(cookie, {
      clientId: "no-logout-uri-app",
      enableEndSession: true,
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
  })

  it("stores it with the creating administrator as its owner, and returns the secret once", async () => {
    const cookie = await adminCookie()

    const response = await create(cookie)
    const body = (await response.json()) as {
      clientId: string
      clientSecret: string | null
    }
    expect(response.status, JSON.stringify(body)).toBe(200)

    expect(body.clientId).toBe("registered-app")
    // Server-generated, comfortably past the schema's 32-character floor, and
    // the only time it is ever readable.
    expect(body.clientSecret ?? "").toHaveLength(64)

    const row = await rowFor("registered-app")
    // The marker the reconcile sweep skips. Everything else follows from it.
    expect(row!.userId).not.toBeNull()
    expect(row!.disabled).toBe(false)
    // SEC-10: a hash, not the secret.
    expect(row!.clientSecret).not.toBe(body.clientSecret)
    expect(row!.clientSecret).toMatch(/^[0-9a-f]{64}$/)
  })

  it("authenticates at the live token endpoint with the secret it handed back", async () => {
    const cookie = await adminCookie()
    const created = (await (await create(cookie)).json()) as {
      clientSecret: string
    }

    // The R4 assertion, from the other direction: the endpoint that verifies a
    // secret and the code that stored it have to agree, and only a live call
    // can say they do. A wrong grant is the *right* refusal here — it means the
    // client was found and authenticated.
    const token = await ctx.auth.handler(
      new Request("http://localhost:3000/api/auth/oauth2/token", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${Buffer.from(
            `registered-app:${created.clientSecret}`
          ).toString("base64")}`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "not-a-real-code",
          redirect_uri: "https://registered.example.com/callback",
          code_verifier: "x".repeat(43),
        }).toString(),
      })
    )
    const error = ((await token.json().catch(() => ({}))) as { error?: string })
      .error
    expect(error, "the client authenticated, only the code was junk").not.toBe(
      "invalid_client"
    )
  })

  it("puts its origin into the CORS and form-action set, and takes it out again", async () => {
    const cookie = await adminCookie()

    // Before: the file client only.
    expect([...clientOrigins(ctx.config)]).toEqual(["https://file.example.com"])

    await create(cookie)
    expect([...clientOrigins(ctx.config)]).toContain(
      "https://registered.example.com"
    )

    // Disabled means "not an allowed origin", not merely "gets no tokens".
    const disabled = await post(
      "/idp/set-client-disabled",
      { clientId: "registered-app", disabled: true },
      cookie
    )
    expect(disabled.status).toBe(200)
    expect([...clientOrigins(ctx.config)]).not.toContain(
      "https://registered.example.com"
    )
  })

  it("revokes what a disabled client was holding", async () => {
    const cookie = await adminCookie()
    await create(cookie)

    const context = await ctx.auth.$context
    const user = await createUserWithoutRequest(
      context,
      {
        email: "disabled-holder@example.com",
        name: "Holder",
        emailVerified: true,
        status: "active",
      },
      { method: "admin" }
    )
    await ctx.database.db.insert(ctx.database.schema.oauthRefreshToken).values({
      id: crypto.randomUUID(),
      token: "still-live",
      clientId: "registered-app",
      userId: user.id,
      scopes: ["openid"],
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    })

    await post(
      "/idp/set-client-disabled",
      { clientId: "registered-app", disabled: true },
      cookie
    )

    // Nothing cascades here — the row stays — so the explicit revoke is the
    // only thing standing between "disabled" and a refresh token that keeps
    // minting access tokens for a client nobody can reach any more.
    const [refresh] = await ctx.database.db
      .select()
      .from(ctx.database.schema.oauthRefreshToken)
      .where(
        eq(ctx.database.schema.oauthRefreshToken.clientId, "registered-app")
      )
    expect(refresh?.revoked ?? null).not.toBeNull()
  })

  it("refuses a client id that already exists", async () => {
    const cookie = await adminCookie()
    expect((await create(cookie)).status).toBe(200)

    const again = await create(cookie)
    expect(again.status).toBe(409)
    expect(((await again.json()) as { code?: string }).code).toBe(
      "CLIENT_ALREADY_EXISTS"
    )
  })

  it("refuses a redirect URI the file schema would refuse", async () => {
    const cookie = await adminCookie()
    const response = await create(cookie, {
      clientId: "bad-redirect",
      redirectUris: ["https://app.example.com/*"],
    })
    expect(response.status).toBe(400)
    // The zod message, not a re-worded one: it names the offending URI.
    expect(await response.text()).toContain("wildcard")
  })

  it("refuses a scope the deployment does not allow", async () => {
    const cookie = await adminCookie()
    const response = await create(cookie, {
      clientId: "bad-scope",
      scopes: ["openid", "billing"],
    })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { code?: string }).code).toBe(
      "SCOPE_NOT_ALLOWED"
    )
  })

  it("answers nothing useful to a caller who is not an administrator", async () => {
    const context = await ctx.auth.$context
    const user = await createUserWithoutRequest(
      context,
      {
        email: "ordinary@example.com",
        name: "Ordinary",
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
    const signedIn = await ctx.auth.handler(
      authRequest("/sign-in/email", {
        json: { email: "ordinary@example.com", password: PASSWORD },
      })
    )

    const response = await create(sessionCookie(signedIn)!)
    expect(response.status).toBe(403)
    expect(await rowFor("registered-app")).toBeUndefined()
  })
})

describe("the two kinds of client coexist (D50, FR-OIDC-2)", () => {
  it("survives a reconcile that disables everything else", async () => {
    const cookie = await adminCookie()
    await create(cookie)

    // A reconcile with the file exactly as it is: the registered client is not
    // in it, and must not be treated as an orphan.
    await reconcileClients({
      config: ctx.config,
      database: ctx.database,
      locking: ctx.database,
    })

    const row = await rowFor("registered-app")
    expect(row, "the admin-created client is still there").toBeDefined()
    expect(row!.disabled, "and still enabled").toBe(false)
  })

  it("refuses to disable or delete a file-managed client", async () => {
    const cookie = await adminCookie()
    await reconcileClients({
      config: ctx.config,
      database: ctx.database,
      locking: ctx.database,
    })

    for (const [path, body] of [
      ["/idp/delete-client", { clientId: "file-app" }],
      ["/idp/set-client-disabled", { clientId: "file-app", disabled: true }],
    ] as const) {
      const response = await post(path, body, cookie)
      expect(response.status, path).toBe(400)
      expect(((await response.json()) as { code?: string }).code).toBe(
        "CLIENT_MANAGED_BY_FILE"
      )
    }

    // Untouched, which is the point: an edit here is one the next restart
    // would silently undo.
    expect((await rowFor("file-app"))!.disabled).toBe(false)
  })
})

describe("removing a client (D50)", () => {
  it("takes its tokens and consents with it", async () => {
    const cookie = await adminCookie()
    await create(cookie)

    const context = await ctx.auth.$context
    const user = await createUserWithoutRequest(
      context,
      {
        email: "holder@example.com",
        name: "Holder",
        emailVerified: true,
        status: "active",
      },
      { method: "admin" }
    )

    await ctx.database.db.insert(ctx.database.schema.oauthRefreshToken).values({
      id: crypto.randomUUID(),
      token: "a-refresh-token",
      clientId: "registered-app",
      userId: user.id,
      scopes: ["openid"],
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    await ctx.database.db.insert(ctx.database.schema.oauthConsent).values({
      id: crypto.randomUUID(),
      clientId: "registered-app",
      userId: user.id,
      scopes: ["openid"],
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const removed = await post(
      "/idp/delete-client",
      { clientId: "registered-app" },
      cookie
    )
    expect(removed.status, await removed.text()).toBe(200)

    expect(await rowFor("registered-app")).toBeUndefined()

    // Both are gone. The endpoint revokes them explicitly *and* the foreign
    // keys cascade, and the belt is worth having: the revoke is what the
    // disable path relies on, where nothing cascades because the row stays.
    //
    // A refresh token outliving its client is a credential with no owner; a
    // surviving consent would let a re-registered id skip the consent screen.
    expect(
      await ctx.database.db
        .select()
        .from(ctx.database.schema.oauthRefreshToken)
        .where(
          eq(ctx.database.schema.oauthRefreshToken.clientId, "registered-app")
        )
    ).toHaveLength(0)
    expect(
      await ctx.database.db
        .select()
        .from(ctx.database.schema.oauthConsent)
        .where(eq(ctx.database.schema.oauthConsent.clientId, "registered-app"))
    ).toHaveLength(0)
  })

  it("records every mutation in the audit trail (SEC-6)", async () => {
    const cookie = await adminCookie()
    await create(cookie)
    await post(
      "/idp/set-client-disabled",
      { clientId: "registered-app", disabled: true },
      cookie
    )
    await post("/idp/delete-client", { clientId: "registered-app" }, cookie)

    const rows = await ctx.database.db
      .select()
      .from(ctx.database.schema.auditLog)
    const actions = rows.map((row) => row.action)
    expect(actions).toContain("client.created")
    expect(actions).toContain("client.disabled")
    expect(actions).toContain("client.deleted")
    // SEC-6, SEC-10: ids and outcomes, never a secret.
    expect(JSON.stringify(rows)).not.toMatch(/[A-Za-z0-9_-]{64}/)
  })
})
