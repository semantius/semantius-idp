/**
 * What a client discovers, and what it is allowed to do with it
 * (FR-OIDC-4/15/16/17).
 *
 * Discovery is the one document every client reads before it can do anything,
 * and the URLs in it get cached and hard-coded. So these assertions are about
 * the *contract*: the issuer is byte-equal to `server.baseUrl`, every endpoint
 * sits at the issuer root rather than under `/api/auth`, and the same holds
 * when the deployment is mounted at a sub-path.
 *
 * The proxy is exercised directly rather than through the route layer: the
 * routes are three lines each and the interesting behavior — rewriting,
 * caching, the RFC 7009 normalization — all lives here.
 */

import { describe, expect, it } from "vitest"

import { createLogger } from "@/server/logger"
import { reconcileClients } from "@/server/oidc/reconcile"
import { forwardDiscovery, forwardToAuth } from "@/server/oidc/protocol-proxy"
import type { Runtime } from "@/server/runtime"
import type { TestContext } from "./harness"
import { createTestContext } from "./harness"

const SECRET = "discovery-client-secret-of-at-least-32-ch"

const CLIENT = {
  clientId: "discovery-app",
  type: "web",
  clientSecret: SECRET,
  redirectUris: ["https://app.example.com/callback"],
  enableEndSession: false,
}

/** A context whose clients are in the database, as a real boot would leave them. */
async function contextWithClient(label: string): Promise<TestContext> {
  const context = await createTestContext(label, { clients: [CLIENT] })
  await reconcileClients({
    config: context.config,
    database: context.database,
    locking: context.database,
  })
  return context
}

/**
 * The proxy reads three things off the runtime; building the whole IdP to
 * supply them would build a second Better Auth instance.
 */
function runtimeFor(context: TestContext): Runtime {
  return {
    config: context.config,
    auth: context.auth,
    logger: createLogger({ level: "error", write: () => {} }),
  } as unknown as Runtime
}

async function discoveryFor(
  context: TestContext,
  path = "/.well-known/openid-configuration"
): Promise<Record<string, unknown>> {
  const issuer = context.config.base.origin + context.config.base.basePath
  const response = await forwardDiscovery(
    runtimeFor(context),
    new Request(`${issuer}${path}`),
    path
  )
  expect(response.status, await response.clone().text()).toBe(200)
  return (await response.json()) as Record<string, unknown>
}

describe("discovery at the host root", () => {
  it("advertises the issuer byte-equal to server.baseUrl (FR-OIDC-15)", async () => {
    const context = await createTestContext("discovery_root")
    try {
      const document = await discoveryFor(context)
      // Every verifier compares `iss` as a string. A trailing slash or an
      // `/api/auth` suffix is a hard failure with an unhelpful message.
      expect(document.issuer).toBe("http://localhost:3000")
    } finally {
      await context.teardown()
    }
  })

  it("puts every endpoint at the issuer root, not under /api/auth", async () => {
    const context = await createTestContext("discovery_endpoints")
    try {
      const document = await discoveryFor(context)
      for (const key of [
        "authorization_endpoint",
        "token_endpoint",
        "userinfo_endpoint",
        "jwks_uri",
      ]) {
        const value = String(document[key])
        expect(value, `${key} = ${value}`).toMatch(/^http:\/\/localhost:3000\//)
        expect(value, `${key} leaks the auth mount`).not.toContain("/api/auth")
      }
    } finally {
      await context.teardown()
    }
  })

  it("advertises S256 and only the two v1 grants (D26, SEC-2)", async () => {
    const context = await createTestContext("discovery_grants")
    try {
      const document = await discoveryFor(context)
      expect(document.code_challenge_methods_supported).toEqual(["S256"])
      expect(document.grant_types_supported).toEqual(
        expect.arrayContaining(["authorization_code", "refresh_token"])
      )
      // D26: no machine-to-machine grant, so it must not be advertised.
      expect(document.grant_types_supported).not.toContain("client_credentials")
      expect(document.response_types_supported).toEqual(["code"])
    } finally {
      await context.teardown()
    }
  })

  it("advertises the signing algorithm the deployment actually uses", async () => {
    const context = await createTestContext("discovery_alg")
    try {
      const document = await discoveryFor(context)
      expect(document.id_token_signing_alg_values_supported).toContain("ES256")
    } finally {
      await context.teardown()
    }
  })

  it("advertises the endpoints that exist, and the scopes it will honor", async () => {
    const context = await createTestContext("discovery_surface")
    try {
      const document = await discoveryFor(context)
      expect(document.revocation_endpoint).toBeTruthy()
      expect(document.introspection_endpoint).toBeTruthy()
      expect(document.scopes_supported).toEqual(
        expect.arrayContaining(["openid", "profile", "email"])
      )
      // `none` is what a public client uses; 1.7.1 omits it and advertises
      // `private_key_jwt`, which §1.3 does not implement.
      expect(document.token_endpoint_auth_methods_supported).toEqual([
        "client_secret_basic",
        "client_secret_post",
        "none",
      ])
      expect(document.claims_supported).toEqual(
        expect.arrayContaining(["sub", "iss", "email", "roles"])
      )
      // Advertised as unsupported rather than omitted: an absent field lets a
      // client assume either answer.
      expect(document.request_parameter_supported).toBe(false)
      expect(document.request_uri_parameter_supported).toBe(false)
      expect(document.claims_parameter_supported).toBe(false)
      expect(document.ui_locales_supported).toEqual(["en-US"])
    } finally {
      await context.teardown()
    }
  })

  it("serves the RFC 8414 document from the same source", async () => {
    const context = await createTestContext("discovery_rfc8414")
    try {
      const oidc = await discoveryFor(context)
      const oauth = await discoveryFor(
        context,
        "/.well-known/oauth-authorization-server"
      )
      // Some clients read only one of the two; they must not disagree about
      // where the token endpoint is.
      expect(oauth.issuer).toBe(oidc.issuer)
      expect(oauth.token_endpoint).toBe(oidc.token_endpoint)
    } finally {
      await context.teardown()
    }
  })
})

describe("discovery under a sub-path (OPS-10)", () => {
  it("keeps the issuer and every endpoint inside the mount", async () => {
    const context = await createTestContext("discovery_subpath", {
      config: {
        server: { baseUrl: "http://localhost:3000/idp" },
        jwt: { audience: "http://localhost:3000/idp" },
      },
    })
    try {
      const document = await discoveryFor(context)
      expect(document.issuer).toBe("http://localhost:3000/idp")
      expect(String(document.token_endpoint)).toBe(
        "http://localhost:3000/idp/oauth2/token"
      )
      expect(String(document.jwks_uri)).toBe(
        "http://localhost:3000/idp/.well-known/jwks.json"
      )
    } finally {
      await context.teardown()
    }
  })
})

describe("the key set (FR-OIDC-16)", () => {
  it("is byte-identical to the canonical endpoint, and cacheable", async () => {
    const context = await createTestContext("discovery_jwks")
    try {
      const runtime = runtimeFor(context)
      const wellKnown = await forwardToAuth(
        runtime,
        new Request("http://localhost:3000/.well-known/jwks.json"),
        { providerPath: "/jwks" }
      )
      const canonical = await context.auth.handler(
        new Request("http://localhost:3000/api/auth/jwks")
      )

      expect(await wellKnown.clone().text()).toBe(await canonical.text())
      // A verifier that refetches the key set per request turns key
      // distribution into a load-bearing dependency.
      expect(wellKnown.headers.get("cache-control")).toContain("max-age=300")
      expect(wellKnown.headers.get("etag")).toBeTruthy()
    } finally {
      await context.teardown()
    }
  })
})

describe("cache headers on credentialed endpoints", () => {
  it("marks the token endpoint no-store", async () => {
    const context = await contextWithClient("discovery_nostore")
    try {
      const response = await forwardToAuth(
        runtimeFor(context),
        new Request("http://localhost:3000/oauth2/token", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: "http://localhost:3000",
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
          }).toString(),
        }),
        { providerPath: "/oauth2/token" }
      )
      // Whatever the outcome: a token response must never be cached, and a
      // *failed* one must not be cached either.
      expect(response.headers.get("cache-control")).toBe("no-store")
    } finally {
      await context.teardown()
    }
  })
})

describe("revocation (RFC 7009 §2.2)", () => {
  it("answers 200 for a token that does not exist", async () => {
    const context = await contextWithClient("discovery_revoke")
    try {
      const response = await forwardToAuth(
        runtimeFor(context),
        new Request("http://localhost:3000/oauth2/revoke", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: "http://localhost:3000",
            authorization: `Basic ${Buffer.from(`${CLIENT.clientId}:${SECRET}`).toString("base64")}`,
          },
          body: new URLSearchParams({ token: "not-a-token" }).toString(),
        }),
        { providerPath: "/oauth2/revoke" }
      )
      // The provider answers 400; normalizing it is what stops the endpoint
      // being an oracle for which tokens exist.
      expect(response.status).toBe(200)
    } finally {
      await context.teardown()
    }
  })

  it("still refuses an unauthenticated caller", async () => {
    const context = await contextWithClient("discovery_revoke_authz")
    try {
      const response = await forwardToAuth(
        runtimeFor(context),
        new Request("http://localhost:3000/oauth2/revoke", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: "http://localhost:3000",
          },
          body: new URLSearchParams({ token: "not-a-token" }).toString(),
        }),
        { providerPath: "/oauth2/revoke" }
      )
      // Only "token not found" is normalized. A missing client is the
      // caller's mistake and hiding it helps nobody.
      expect(response.status).toBeGreaterThanOrEqual(400)
    } finally {
      await context.teardown()
    }
  })
})

describe("authorize errors (SEC-3)", () => {
  it("never redirects to an unregistered redirect_uri", async () => {
    const context = await contextWithClient("discovery_authorize_error")
    try {
      const query = new URLSearchParams({
        response_type: "code",
        client_id: CLIENT.clientId,
        redirect_uri: "https://evil.example/steal",
        scope: "openid",
      })
      const response = await forwardToAuth(
        runtimeFor(context),
        new Request(
          `http://localhost:3000/oauth2/authorize?${query.toString()}`,
          { redirect: "manual" }
        ),
        { providerPath: "/oauth2/authorize" }
      )

      // The whole point: an unvalidated redirect URI must never be redirected
      // to, because that is how an authorization code is stolen.
      // The provider redirects to its *own* error surface rather than to the
      // caller's URI, which is the property that matters: an unvalidated
      // redirect URI is how an authorization code is stolen. M9 replaces the
      // target with this app's own `/error` page.
      const location = response.headers.get("location") ?? ""
      expect(location).not.toContain("evil.example")
      expect(location).toContain("error")
    } finally {
      await context.teardown()
    }
  })

  it("refuses an unknown client the same way", async () => {
    const context = await contextWithClient("discovery_authorize_unknown")
    try {
      const query = new URLSearchParams({
        response_type: "code",
        client_id: "no-such-client",
        redirect_uri: "https://app.example.com/callback",
        scope: "openid",
      })
      const response = await forwardToAuth(
        runtimeFor(context),
        new Request(
          `http://localhost:3000/oauth2/authorize?${query.toString()}`,
          { redirect: "manual" }
        ),
        { providerPath: "/oauth2/authorize" }
      )
      const location = response.headers.get("location") ?? ""
      expect(location).not.toContain("app.example.com")
      expect(location).toContain("error")
    } finally {
      await context.teardown()
    }
  })
})
