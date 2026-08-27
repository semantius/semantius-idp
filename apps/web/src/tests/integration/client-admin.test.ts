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

async function update(cookie: string, overrides: Record<string, unknown> = {}) {
  return post("/idp/update-client", { ...NEW_CLIENT, ...overrides }, cookie)
}

async function rotate(cookie: string, clientId = "registered-app") {
  return post("/idp/rotate-client-secret", { clientId }, cookie)
}

/**
 * Whether a secret still authenticates this client, against a live endpoint.
 *
 * **`/oauth2/introspect`, not `/oauth2/token`.** The token endpoint validates
 * the authorization code *before* the client credential, so a junk code
 * answers `invalid_grant` whatever secret is presented — including one that
 * was never right. A test built on it asserts nothing, which is what the D50
 * test below did until D72's rotation case exposed it: the old secret "still
 * worked" after a rotation that had in fact replaced it.
 *
 * Introspection authenticates the client and then answers about the token, so
 * it separates the two: a wrong secret is `401 invalid_client`, and a right
 * one is `200 {"active": false}` for a token that does not exist. Asserting
 * the stored hash proves the column did not change; this proves the credential
 * an operator has deployed still opens the door.
 */
async function authenticates(secret: string): Promise<boolean> {
  const response = await ctx.auth.handler(
    new Request("http://localhost:3000/api/auth/oauth2/introspect", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(
          `registered-app:${secret}`
        ).toString("base64")}`,
      },
      body: new URLSearchParams({ token: "not-a-real-token" }).toString(),
    })
  )
  return response.status === 200
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

  it("authenticates against a live endpoint with the secret it handed back", async () => {
    const cookie = await adminCookie()
    const created = (await (await create(cookie)).json()) as {
      clientSecret: string
    }

    // The R4 assertion, from the other direction: the endpoint that verifies a
    // secret and the code that stored it have to agree, and only a live call
    // can say they do.
    //
    // This used to post a junk authorization code to `/oauth2/token` and
    // assert the answer was not `invalid_client`. It never could be: the code
    // is validated first, so `invalid_grant` comes back for *any* secret and
    // the test passed for a credential that had never been right. Found while
    // writing D72's rotation case, which asserted the *old* secret stops
    // working and was told it had not. `authenticates` says how the oracle
    // works; both halves are asserted here so it cannot go quiet again.
    expect(
      await authenticates(created.clientSecret),
      "the secret it handed back opens the door"
    ).toBe(true)
    expect(
      await authenticates("x".repeat(64)),
      "and one that was never right does not"
    ).toBe(false)
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

describe("editing a client (D72)", () => {
  it("replaces the writable fields and leaves the row's identity alone", async () => {
    const cookie = await adminCookie()
    await create(cookie)
    const before = await rowFor("registered-app")

    const response = await update(cookie, {
      name: "Renamed App",
      redirectUris: [
        "https://registered.example.com/callback",
        "https://registered.example.com/other",
      ],
      scopes: ["openid", "email"],
      skipConsent: false,
    })
    expect(response.status, await response.text()).toBe(200)

    const after = await rowFor("registered-app")
    expect(after!.name).toBe("Renamed App")
    expect(after!.redirectUris).toHaveLength(2)
    expect(after!.scopes).toEqual(["openid", "email"])
    expect(after!.skipConsent).toBe(false)

    // The three that are not the form's to change. `userId` most of all: the
    // default is `null`, which is the file marker, and a nulled owner is what
    // the next reconcile's orphan sweep disables.
    expect(after!.userId).toBe(before!.userId)
    expect(after!.createdAt?.getTime()).toBe(before!.createdAt?.getTime())
    expect(after!.clientId).toBe("registered-app")
  })

  it("does not re-enable a client that was disabled", async () => {
    // `clientSchema` defaults `disabled` to false, so an update that let the
    // default through would turn a suspended application back on as a side
    // effect of correcting its name.
    const cookie = await adminCookie()
    await create(cookie)
    await post(
      "/idp/set-client-disabled",
      { clientId: "registered-app", disabled: true },
      cookie
    )

    expect((await update(cookie, { name: "Still Off" })).status).toBe(200)
    const row = await rowFor("registered-app")
    expect(row!.disabled).toBe(true)
    expect(row!.name).toBe("Still Off")
  })

  it("keeps a confidential client's secret working, byte for byte", async () => {
    const cookie = await adminCookie()
    const created = (await (await create(cookie)).json()) as {
      clientSecret: string
    }
    const before = await rowFor("registered-app")

    const response = await update(cookie, { name: "Same Secret" })
    const body = (await response.json()) as { clientSecret: string | null }
    // Nothing to hand over: the plaintext is gone and the row holds a hash.
    expect(body.clientSecret).toBeNull()

    const after = await rowFor("registered-app")
    expect(after!.clientSecret).toBe(before!.clientSecret)
    // The assertion that matters to whoever deployed the application: the
    // secret in their configuration still gets them a token.
    expect(await authenticates(created.clientSecret)).toBe(true)
  })

  it("mints a secret when a public client becomes confidential", async () => {
    const cookie = await adminCookie()
    await create(cookie, { type: "spa" })
    expect((await rowFor("registered-app"))!.clientSecret).toBeNull()

    const response = await update(cookie, { type: "web" })
    const body = (await response.json()) as {
      clientSecret: string | null
      isPublic: boolean
    }
    expect(body.isPublic).toBe(false)
    // Shown once, exactly as a creation's is.
    expect(body.clientSecret ?? "").toHaveLength(64)
    expect((await rowFor("registered-app"))!.clientSecret).toMatch(
      /^[0-9a-f]{64}$/
    )
    expect(await authenticates(body.clientSecret!)).toBe(true)
  })

  it("revokes when the credential model flips, and not when a URI changes", async () => {
    const cookie = await adminCookie()
    await create(cookie)

    const context = await ctx.auth.$context
    const user = await createUserWithoutRequest(
      context,
      {
        email: "edit-holder@example.com",
        name: "Holder",
        emailVerified: true,
        status: "active",
      },
      { method: "admin" }
    )
    const liveToken = async (token: string) => {
      await ctx.database.db
        .insert(ctx.database.schema.oauthRefreshToken)
        .values({
          id: crypto.randomUUID(),
          token,
          clientId: "registered-app",
          userId: user.id,
          scopes: ["openid"],
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 86_400_000),
        })
    }
    const revokedFlags = async () =>
      (
        await ctx.database.db
          .select()
          .from(ctx.database.schema.oauthRefreshToken)
          .where(
            eq(ctx.database.schema.oauthRefreshToken.clientId, "registered-app")
          )
      ).map((row) => row.revoked ?? null)

    // An ordinary edit. Reconciliation's own update path revokes nothing for
    // a renamed file client, and this must match it — otherwise correcting a
    // typo in a name signs everybody out of the application.
    await liveToken("survives-a-uri-edit")
    await update(cookie, {
      redirectUris: ["https://registered.example.com/moved"],
    })
    expect(await revokedFlags()).toEqual([null])

    // The flip. Confidential and public are different ways of authenticating,
    // so a token issued under one is not evidence under the other.
    await update(cookie, { type: "spa" })
    expect((await revokedFlags()).every((flag) => flag !== null)).toBe(true)
    expect((await rowFor("registered-app"))!.clientSecret).toBeNull()
  })

  it("re-validates the stored URIs against the new type", async () => {
    const cookie = await adminCookie()
    // A private-use scheme is legal for a native application and for nothing
    // else, so this is only refusable at the moment the type changes.
    await create(cookie, {
      type: "native",
      redirectUris: ["com.example.app:/callback"],
    })

    const response = await update(cookie, {
      type: "web",
      redirectUris: ["com.example.app:/callback"],
    })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { code?: string }).code).toBe(
      "INVALID_CLIENT_DEFINITION"
    )
    // Refused inside the transaction, so nothing landed.
    expect((await rowFor("registered-app"))!.applicationType).toBe("native")
  })

  it("follows a redirect-URI edit into the CORS and form-action set", async () => {
    const cookie = await adminCookie()
    await create(cookie)
    expect([...clientOrigins(ctx.config)]).toContain(
      "https://registered.example.com"
    )

    await update(cookie, { redirectUris: ["https://moved.example.com/cb"] })
    const origins = [...clientOrigins(ctx.config)]
    expect(origins).toContain("https://moved.example.com")
    // Not merely added: the old origin is no longer one this deployment
    // answers CORS for or allows as a `form-action`.
    expect(origins).not.toContain("https://registered.example.com")
  })

  it("refuses the same things a creation does", async () => {
    const cookie = await adminCookie()
    await create(cookie)
    // The file's row only exists once it has been reconciled in; without this
    // the refusal below is `CLIENT_NOT_FOUND`, which proves nothing about
    // whether the file marker is honoured.
    await reconcileClients({
      config: ctx.config,
      database: ctx.database,
      locking: ctx.database,
    })

    const cases: [Record<string, unknown>, number, string][] = [
      // The file's row is not this endpoint's to touch, for D50's reason: the
      // next restart would silently undo it.
      [{ clientId: "file-app" }, 400, "CLIENT_MANAGED_BY_FILE"],
      [{ clientId: "never-registered" }, 404, "CLIENT_NOT_FOUND"],
      [
        { redirectUris: ["https://app.example.com/*"] },
        400,
        "INVALID_CLIENT_DEFINITION",
      ],
      [{ scopes: ["openid", "billing"] }, 400, "SCOPE_NOT_ALLOWED"],
    ]
    for (const [overrides, status, code] of cases) {
      const response = await update(cookie, overrides)
      expect(response.status, JSON.stringify(overrides)).toBe(status)
      expect(((await response.json()) as { code?: string }).code).toBe(code)
    }
  })

  it("answers nothing useful to a caller who is not an administrator", async () => {
    const cookie = await adminCookie()
    await create(cookie)

    for (const path of ["/idp/update-client", "/idp/rotate-client-secret"]) {
      const response = await post(path, { ...NEW_CLIENT }, undefined)
      expect([401, 403], `${path} answered ${response.status}`).toContain(
        response.status
      )
    }
    expect((await rowFor("registered-app"))!.name).toBe("Registered App")
  })
})

describe("rotating a client secret (D72)", () => {
  it("replaces the secret, once, and leaves the refresh tokens alone", async () => {
    const cookie = await adminCookie()
    const created = (await (await create(cookie)).json()) as {
      clientSecret: string
    }

    const context = await ctx.auth.$context
    const user = await createUserWithoutRequest(
      context,
      {
        email: "rotate-holder@example.com",
        name: "Holder",
        emailVerified: true,
        status: "active",
      },
      { method: "admin" }
    )
    await ctx.database.db.insert(ctx.database.schema.oauthRefreshToken).values({
      id: crypto.randomUUID(),
      token: "survives-a-rotation",
      clientId: "registered-app",
      userId: user.id,
      scopes: ["openid"],
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    })

    const response = await rotate(cookie)
    const body = (await response.json()) as { clientSecret: string }
    expect(response.status).toBe(200)
    expect(body.clientSecret).toHaveLength(64)
    expect(body.clientSecret).not.toBe(created.clientSecret)

    // The old one stops working immediately — no grace window in v1, which is
    // what the confirmation dialog says before it is confirmed.
    expect(await authenticates(created.clientSecret)).toBe(false)
    expect(await authenticates(body.clientSecret)).toBe(true)

    // Rotation is hygiene, not incident response: the client is still the
    // client, so what it holds stays valid. Disable and Remove are the ones
    // that revoke.
    const [refresh] = await ctx.database.db
      .select()
      .from(ctx.database.schema.oauthRefreshToken)
      .where(
        eq(ctx.database.schema.oauthRefreshToken.clientId, "registered-app")
      )
    expect(refresh!.revoked ?? null).toBeNull()
  })

  it("refuses a public client rather than quietly minting one a secret", async () => {
    const cookie = await adminCookie()
    await create(cookie, { type: "spa" })

    const response = await rotate(cookie)
    expect(response.status).toBe(400)
    expect(((await response.json()) as { code?: string }).code).toBe(
      "CLIENT_HAS_NO_SECRET"
    )
    expect((await rowFor("registered-app"))!.clientSecret).toBeNull()
  })

  it("refuses a file-managed client", async () => {
    const cookie = await adminCookie()
    await reconcileClients({
      config: ctx.config,
      database: ctx.database,
      locking: ctx.database,
    })

    const before = await rowFor("file-app")
    const response = await rotate(cookie, "file-app")
    expect(response.status).toBe(400)
    expect(((await response.json()) as { code?: string }).code).toBe(
      "CLIENT_MANAGED_BY_FILE"
    )
    expect((await rowFor("file-app"))!.clientSecret).toBe(before!.clientSecret)
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

  it("survives a reconcile after it has been edited (D72)", async () => {
    // The regression this exists for: `toClientRow` defaults `userId` to
    // `null`, so an update that did not write the owner back would hand the
    // row to the orphan sweep — and the application would keep working until
    // the next restart, which is the worst possible time to find out.
    const cookie = await adminCookie()
    await create(cookie)
    expect((await update(cookie, { name: "Edited" })).status).toBe(200)

    await reconcileClients({
      config: ctx.config,
      database: ctx.database,
      locking: ctx.database,
    })

    const row = await rowFor("registered-app")
    expect(row, "the edited client is still there").toBeDefined()
    expect(row!.userId, "and still owned").not.toBeNull()
    expect(row!.disabled, "and still enabled").toBe(false)
    expect(row!.name).toBe("Edited")
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
    // D72: an edit and a rotation are separate events on purpose — only one
    // of them explains a client that stopped authenticating this morning.
    await update(cookie, { name: "Audited" })
    await rotate(cookie)
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
    expect(actions).toContain("client.updated")
    expect(actions).toContain("client.secret_rotated")
    expect(actions).toContain("client.disabled")
    expect(actions).toContain("client.deleted")
    // SEC-6, SEC-10: ids and outcomes, never a secret.
    expect(JSON.stringify(rows)).not.toMatch(/[A-Za-z0-9_-]{64}/)
  })
})
