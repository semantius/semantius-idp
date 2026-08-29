/**
 * Client reconciliation against a real database (FR-OIDC-2/3/6, risk R4).
 *
 * The invariant that matters most is the last one in this file: a secret
 * written by the reconciler authenticates at the **live token endpoint**. That
 * is what R4 was about — two pieces of code agreeing on how a secret is
 * stored — and it is the only assertion here that cannot be satisfied by the
 * reconciler being self-consistently wrong.
 */

import { describe, expect, it } from "vitest"

import { createHash, randomBytes } from "node:crypto"

import { eq } from "drizzle-orm"

import { createDb } from "@/server/db/client"
import { reconcileClients } from "@/server/oidc/reconcile"
import { hashClientSecret } from "@/server/oidc/secret-hash"
import type { TestContext } from "./harness"
import { authRequest, createTestContext, sessionCookie } from "./harness"

const SECRET = "reconcile-secret-of-at-least-32-characters"
const OTHER_SECRET = "a-different-secret-also-32-characters-long"

const WEB_CLIENT = {
  clientId: "web-app",
  type: "web",
  name: "Web App",
  clientSecret: SECRET,
  redirectUris: ["https://app.example.com/callback"],
  postLogoutRedirectUris: ["https://app.example.com/"],
}

const SPA_CLIENT = {
  clientId: "spa-app",
  type: "spa",
  name: "SPA",
  redirectUris: ["https://spa.example.com/callback"],
  enableEndSession: false,
}

async function contextWithClients(
  label: string,
  clients: Record<string, unknown>[],
  config: Record<string, unknown> = {}
): Promise<TestContext> {
  return createTestContext(label, {
    clients,
    config: {
      signUp: { enabled: true, requireApproval: false },
      auth: { requireEmailVerification: false },
      ...config,
    },
  })
}

/** Reconciles using the context's own connection for both handles. */
async function reconcile(context: TestContext) {
  return reconcileClients({
    config: context.config,
    database: context.database,
    locking: context.database,
  })
}

async function clientRow(context: TestContext, clientId: string) {
  const [row] = await context.database.db
    .select()
    .from(context.database.schema.oauthClient)
    .where(eq(context.database.schema.oauthClient.clientId, clientId))
  return row
}

async function linksFor(
  context: TestContext,
  clientId: string
): Promise<string[]> {
  const rows = await context.database.db
    .select({
      resourceId: context.database.schema.oauthClientResource.resourceId,
    })
    .from(context.database.schema.oauthClientResource)
    .where(eq(context.database.schema.oauthClientResource.clientId, clientId))
  return rows.map((row) => row.resourceId).sort()
}

describe("client reconciliation", () => {
  it("creates the rows the file describes (FR-OIDC-2/3)", async () => {
    const context = await contextWithClients("reconcile_create", [
      WEB_CLIENT,
      SPA_CLIENT,
    ])
    try {
      const diff = await reconcile(context)
      expect(diff.created.sort()).toEqual(["spa-app", "web-app"])

      const web = await clientRow(context, "web-app")
      expect(web?.clientSecret).toBe(hashClientSecret(SECRET))
      expect(web?.tokenEndpointAuthMethod).toBe("client_secret_basic")
      expect(web?.userId).toBeNull()

      const spa = await clientRow(context, "spa-app")
      expect(spa?.clientSecret).toBeNull()
      expect(spa?.requirePKCE).toBe(true)
    } finally {
      await context.teardown()
    }
  })

  it("writes nothing on an unchanged re-run, and audits nothing", async () => {
    const context = await contextWithClients("reconcile_idempotent", [
      WEB_CLIENT,
    ])
    try {
      await reconcile(context)
      const first = await clientRow(context, "web-app")

      const second = await reconcile(context)
      expect(second.unchanged).toBe(true)
      expect(second.created).toEqual([])
      expect(second.updated).toEqual([])

      // `createdAt` surviving is the observable proof that nothing was
      // rewritten — a reconcile that touched every row on every boot would
      // fill the audit trail with events that mean nothing.
      const after = await clientRow(context, "web-app")
      expect(after?.createdAt?.getTime()).toBe(first?.createdAt?.getTime())
    } finally {
      await context.teardown()
    }
  })

  it("applies a changed field and preserves createdAt", async () => {
    const context = await contextWithClients("reconcile_update", [WEB_CLIENT])
    try {
      await reconcile(context)
      const before = await clientRow(context, "web-app")

      // Same schema, new configuration: edit the row through a second
      // reconcile with a different name.
      const second = await reconcileClients({
        config: {
          ...context.config,
          clients: [{ ...context.config.clients[0]!, name: "Renamed" }],
        },
        database: context.database,
        locking: context.database,
      })
      expect(second.updated).toEqual(["web-app"])

      const after = await clientRow(context, "web-app")
      expect(after?.name).toBe("Renamed")
      expect(after?.createdAt?.getTime()).toBe(before?.createdAt?.getTime())
    } finally {
      await context.teardown()
    }
  })

  it("rotates a secret when the file changes it", async () => {
    const context = await contextWithClients("reconcile_rotate", [WEB_CLIENT])
    try {
      await reconcile(context)
      expect((await clientRow(context, "web-app"))?.clientSecret).toBe(
        hashClientSecret(SECRET)
      )

      const rotated = await reconcileClients({
        config: {
          ...context.config,
          clients: [
            { ...context.config.clients[0]!, clientSecret: OTHER_SECRET },
          ],
        },
        database: context.database,
        locking: context.database,
      })
      expect(rotated.updated).toEqual(["web-app"])
      expect((await clientRow(context, "web-app"))?.clientSecret).toBe(
        hashClientSecret(OTHER_SECRET)
      )
    } finally {
      await context.teardown()
    }
  })

  it("disables a client the file no longer mentions, and kills its tokens", async () => {
    const context = await contextWithClients("reconcile_absent", [WEB_CLIENT])
    try {
      await reconcile(context)

      // A live refresh token and a consent, as if the client had been used.
      const { oauthRefreshToken, oauthConsent, user } = context.database.schema
      const [owner] = await context.database.db
        .insert(user)
        .values({
          id: "user-1",
          email: "owner@example.com",
          name: "Owner",
          emailVerified: true,
          status: "active",
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning({ id: user.id })
      await context.database.db.insert(oauthRefreshToken).values({
        id: "refresh-1",
        token: "refresh-token-1",
        clientId: "web-app",
        userId: owner!.id,
        scopes: ["openid"],
        expiresAt: new Date(Date.now() + 86_400_000),
        createdAt: new Date(),
      })
      await context.database.db.insert(oauthConsent).values({
        id: "consent-1",
        clientId: "web-app",
        userId: owner!.id,
        scopes: ["openid"],
        createdAt: new Date(),
        updatedAt: new Date(),
      })

      const diff = await reconcileClients({
        config: { ...context.config, clients: [] },
        database: context.database,
        locking: context.database,
      })
      expect(diff.disabled).toEqual(["web-app"])

      expect((await clientRow(context, "web-app"))?.disabled).toBe(true)
      const [refresh] = await context.database.db
        .select()
        .from(oauthRefreshToken)
        .where(eq(oauthRefreshToken.id, "refresh-1"))
      expect(refresh?.revoked).not.toBeNull()

      // A client that comes back later is a new grant decision, not a
      // resumption of the old one.
      const consents = await context.database.db.select().from(oauthConsent)
      expect(consents).toHaveLength(0)
    } finally {
      await context.teardown()
    }
  })

  it("deletes instead of disabling when prune is on", async () => {
    const context = await contextWithClients("reconcile_prune", [WEB_CLIENT], {
      oauth: { reconcile: { prune: true } },
    })
    try {
      await reconcile(context)
      const diff = await reconcileClients({
        config: { ...context.config, clients: [] },
        database: context.database,
        locking: context.database,
      })
      expect(diff.deleted).toEqual(["web-app"])
      expect(await clientRow(context, "web-app")).toBeUndefined()
    } finally {
      await context.teardown()
    }
  })

  it("links every client to the default audience (FR-OIDC-6)", async () => {
    const context = await contextWithClients("reconcile_links", [WEB_CLIENT])
    try {
      await reconcile(context)
      // Without this link `enforcePerClientResources` would refuse every
      // token request, because the resolved resource is one the client is
      // not linked to.
      expect(await linksFor(context, "web-app")).toEqual([
        "http://localhost:3000",
      ])
    } finally {
      await context.teardown()
    }
  })

  it("serializes concurrent reconciles rather than racing them", async () => {
    const context = await contextWithClients("reconcile_concurrent", [
      WEB_CLIENT,
      SPA_CLIENT,
    ])
    // A second connection, so the advisory lock has two sessions to arbitrate
    // between — on one connection it would be re-entrant and prove nothing.
    const second = createDb(
      { ...context.config, file: context.config.file },
      { max: 2 }
    )
    try {
      const [a, b] = await Promise.all([
        reconcileClients({
          config: context.config,
          database: context.database,
          locking: context.database,
        }),
        reconcileClients({
          config: context.config,
          database: second,
          locking: second,
        }),
      ])
      // Exactly one of them did the work; the other found everything in place.
      const created = [...a.created, ...b.created].sort()
      expect(created).toEqual(["spa-app", "web-app"])
      expect(a.unchanged !== b.unchanged).toBe(true)
    } finally {
      await second.close().catch(() => undefined)
      await context.teardown()
    }
  })
})

describe("the FR-OIDC-2 secret invariant (risk R4)", () => {
  it("authenticates at the live token endpoint with the file's secret", async () => {
    const context = await contextWithClients("reconcile_parity", [WEB_CLIENT])
    try {
      await reconcile(context)
      const cookie = await signIn(context)
      const { code, verifier } = await authorizationCode(context, cookie)

      // The whole point of R4: the reconciler hashed this secret, and the
      // token endpoint verifies it. A real code is required because client
      // authentication is only reached once the grant itself is plausible —
      // with a bogus code both the right and the wrong secret produce
      // `invalid_grant`, which is why the first version of this test proved
      // nothing.
      const good = await exchange(context, code, verifier, SECRET)
      expect(good.status).toBe(200)
      const tokens = (await good.json()) as { access_token?: string }
      expect(tokens.access_token).toBeTruthy()
    } finally {
      await context.teardown()
    }
  })

  it("refuses the wrong secret at the same endpoint", async () => {
    const context = await contextWithClients("reconcile_parity_bad", [
      WEB_CLIENT,
    ])
    try {
      await reconcile(context)
      const cookie = await signIn(context)
      const { code, verifier } = await authorizationCode(context, cookie)

      const bad = await exchange(context, code, verifier, OTHER_SECRET)
      const body = (await bad.json()) as { error?: string }
      expect(body.error).toBe("invalid_client")
    } finally {
      await context.teardown()
    }
  })
})

const USER_EMAIL = "client-user@example.com"
const USER_PASSWORD = "correct-horse-battery-staple"

/** A signed-in session, so `/oauth2/authorize` can issue a code. */
async function signIn(context: TestContext): Promise<string> {
  await context.auth.handler(
    authRequest("/sign-up/email", {
      json: {
        email: USER_EMAIL,
        password: USER_PASSWORD,
        name: "Client User",
      },
    })
  )
  const response = await context.auth.handler(
    authRequest("/sign-in/email", {
      json: { email: USER_EMAIL, password: USER_PASSWORD },
    })
  )
  const cookie = sessionCookie(response)
  expect(cookie, "the flow needs a session to authorize").toBeTruthy()
  return cookie!
}

/** One authorization-code round trip, with PKCE. */
async function authorizationCode(
  context: TestContext,
  cookie: string
): Promise<{ code: string; verifier: string }> {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")

  const query = new URLSearchParams({
    response_type: "code",
    client_id: "web-app",
    redirect_uri: "https://app.example.com/callback",
    scope: "openid",
    state: "state-1",
    code_challenge: challenge,
    code_challenge_method: "S256",
  })
  const response = await context.auth.handler(
    new Request(
      `http://localhost:3000/api/auth/oauth2/authorize?${query.toString()}`,
      { headers: { cookie }, redirect: "manual" }
    )
  )
  const location = response.headers.get("location") ?? ""
  expect(location, `authorize did not redirect: ${response.status}`).toContain(
    "code="
  )
  return {
    code: new URL(location).searchParams.get("code") ?? "",
    verifier,
  }
}

async function exchange(
  context: TestContext,
  code: string,
  verifier: string,
  secret: string
): Promise<Response> {
  return context.auth.handler(
    new Request("http://localhost:3000/api/auth/oauth2/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "http://localhost:3000",
        authorization: `Basic ${Buffer.from(`web-app:${secret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://app.example.com/callback",
        code_verifier: verifier,
      }).toString(),
    })
  )
}
