/**
 * The discovery rewrite and the CORS matrix (FR-OIDC-15/17).
 *
 * Both are pure decisions with expensive consequences: a discovery URL that
 * still points at `/api/auth` locks every client that reads it to an internal
 * detail of the auth library, and a CORS header on the wrong endpoint is the
 * difference between "cookies are same-origin" and "any page can spend this
 * user's session".
 */

import { describe, expect, it } from "vitest"

import { clientOrigins, corsFor } from "@/server/http/cors"
import { withRequestContext } from "@/server/http/request-log"
import { forwardToAuth, rewriteDiscovery } from "@/server/oidc/protocol-proxy"
import { deriveConfig, parseBasePath } from "@/server/config/derive"
import type { IdpConfig } from "@/server/config/derive"
import type { Runtime } from "@/server/runtime"
import { clientSchema } from "@/server/config/schema/clients-schema"
import { configFileSchema } from "@/server/config/schema/config-schema"
import { BUILT_IN_ROLES } from "@/server/config/schema/roles-schema"

const ISSUER = "https://idp.example.com"
const AUTH_BASE = `${ISSUER}/api/auth`

function configWith(clients: Record<string, unknown>[] = []): IdpConfig {
  const file = configFileSchema.parse({
    server: { baseUrl: ISSUER },
    secret: "0123456789abcdef0123456789abcdef0123456789",
    database: { url: "postgres://idp:idp@localhost:5432/idp" },
    site: { name: "Test IdP" },
    jwt: { audience: ISSUER },
  })
  return deriveConfig(
    file,
    clients.map((client) => clientSchema.parse(client)),
    BUILT_IN_ROLES
  )
}

describe("rewriteDiscovery", () => {
  it("moves every endpoint to the issuer root", () => {
    const document = rewriteDiscovery(
      {
        issuer: AUTH_BASE,
        authorization_endpoint: `${AUTH_BASE}/oauth2/authorize`,
        token_endpoint: `${AUTH_BASE}/oauth2/token`,
        userinfo_endpoint: `${AUTH_BASE}/oauth2/userinfo`,
        revocation_endpoint: `${AUTH_BASE}/oauth2/revoke`,
        introspection_endpoint: `${AUTH_BASE}/oauth2/introspect`,
        end_session_endpoint: `${AUTH_BASE}/oauth2/end-session`,
      },
      ISSUER,
      AUTH_BASE
    )

    expect(document.issuer).toBe(ISSUER)
    expect(document.authorization_endpoint).toBe(`${ISSUER}/oauth2/authorize`)
    expect(document.token_endpoint).toBe(`${ISSUER}/oauth2/token`)
    expect(document.userinfo_endpoint).toBe(`${ISSUER}/oauth2/userinfo`)
    expect(document.revocation_endpoint).toBe(`${ISSUER}/oauth2/revoke`)
    expect(document.introspection_endpoint).toBe(`${ISSUER}/oauth2/introspect`)
    expect(document.end_session_endpoint).toBe(`${ISSUER}/oauth2/end-session`)
  })

  it("corrects what the provider says it supports (FR-OIDC-15)", () => {
    const document = rewriteDiscovery(
      {
        token_endpoint_auth_methods_supported: [
          "client_secret_basic",
          "private_key_jwt",
        ],
      },
      ISSUER,
      AUTH_BASE,
      { uiLocale: "en-US" }
    )
    // `private_key_jwt` is advertised by 1.7.1 and deliberately unused here
    // (§1.3); `none` is what every public client needs and is omitted.
    expect(document.token_endpoint_auth_methods_supported).toEqual([
      "client_secret_basic",
      "client_secret_post",
      "none",
    ])
    expect(document.request_parameter_supported).toBe(false)
    expect(document.request_uri_parameter_supported).toBe(false)
    expect(document.claims_parameter_supported).toBe(false)
    expect(document.ui_locales_supported).toEqual(["en-US"])
  })

  it("pins jwks_uri to the well-known path", () => {
    // A verifier caches `jwks_uri` for as long as the response allows, so
    // moving it later is a breaking change for everything holding a token.
    const document = rewriteDiscovery({}, ISSUER, AUTH_BASE)
    expect(document.jwks_uri).toBe(`${ISSUER}/.well-known/jwks.json`)
  })

  it("leaves values that are not our URLs alone", () => {
    const document = rewriteDiscovery(
      {
        scopes_supported: ["openid", "profile"],
        code_challenge_methods_supported: ["S256"],
        service_documentation: "https://example.com/docs",
        response_modes_supported: [`${AUTH_BASE}/x`, "query"],
      },
      ISSUER,
      AUTH_BASE
    )
    expect(document.scopes_supported).toEqual(["openid", "profile"])
    expect(document.code_challenge_methods_supported).toEqual(["S256"])
    expect(document.service_documentation).toBe("https://example.com/docs")
    // Arrays are rewritten element-wise, not skipped.
    expect(document.response_modes_supported).toEqual([`${ISSUER}/x`, "query"])
  })

  it("works for a sub-path issuer (OPS-10)", () => {
    const subIssuer = "https://apps.example.com/idp"
    const subAuth = `${subIssuer}/api/auth`
    const document = rewriteDiscovery(
      { token_endpoint: `${subAuth}/oauth2/token` },
      subIssuer,
      subAuth
    )
    expect(document.issuer).toBe(subIssuer)
    expect(document.token_endpoint).toBe(`${subIssuer}/oauth2/token`)
  })
})

const WEB_CLIENT = {
  clientId: "app",
  type: "web",
  clientSecret: "a-client-secret-of-at-least-32-characters",
  redirectUris: ["https://app.example.com/callback"],
  postLogoutRedirectUris: ["https://after.example.com/"],
}

const NATIVE_CLIENT = {
  clientId: "mobile",
  type: "native",
  redirectUris: ["com.example.app:/callback"],
  enableEndSession: false,
}

describe("clientOrigins", () => {
  it("collects the origin of every registered URI", () => {
    // Origins, not URIs: a browser sends `Origin: https://app.example.com`
    // for a page at any path, so matching whole URIs would allow nothing.
    expect([...clientOrigins(configWith([WEB_CLIENT]))].sort()).toEqual([
      "https://after.example.com",
      "https://app.example.com",
    ])
  })

  it("ignores private-use schemes, which have no browser origin", () => {
    expect([...clientOrigins(configWith([NATIVE_CLIENT]))]).toEqual([])
  })
})

describe("corsFor", () => {
  const request = (origin?: string, method = "POST") =>
    new Request("https://idp.example.com/oauth2/token", {
      method,
      ...(origin ? { headers: { origin } } : {}),
    })

  it("opens discovery and JWKS to everyone", () => {
    const decision = corsFor(request(undefined, "GET"), configWith(), "public")
    expect(decision.headers["access-control-allow-origin"]).toBe("*")
    // Public documents are not credentialed, so no allow-credentials.
    expect(decision.headers).not.toHaveProperty(
      "access-control-allow-credentials"
    )
  })

  it("allows a registered client origin on the token endpoint", () => {
    const decision = corsFor(
      request("https://app.example.com"),
      configWith([WEB_CLIENT]),
      "clients"
    )
    expect(decision.headers["access-control-allow-origin"]).toBe(
      "https://app.example.com"
    )
    expect(decision.headers.vary).toBe("Origin")
  })

  it("says nothing at all to an origin it does not know", () => {
    // Not a refusal: the browser turns a missing header into the same error,
    // and silence avoids confirming which origins are registered.
    const decision = corsFor(
      request("https://evil.example"),
      configWith([WEB_CLIENT]),
      "clients"
    )
    expect(decision.headers).not.toHaveProperty("access-control-allow-origin")
    expect(decision.headers.vary).toBe("Origin")
  })

  it("gives introspection no CORS headers whatsoever", () => {
    // It is a server-to-server endpoint; a header here would only help an
    // attacker who had already got a client secret into a page.
    const decision = corsFor(
      request("https://app.example.com"),
      configWith([WEB_CLIENT]),
      "none"
    )
    expect(decision.headers).toEqual({})
  })

  it("recognizes a preflight", () => {
    expect(
      corsFor(request(undefined, "OPTIONS"), configWith(), "public").preflight
    ).toBe(true)
    expect(corsFor(request(), configWith(), "public").preflight).toBe(false)
  })
})

/**
 * A host-scoped access token presented on another host (`server.dynamicIssuer`).
 *
 * The provider verifies a JWT access token against the issuer the *current*
 * request resolved to, so a token minted on host A fails jose's `iss` check on
 * host B — and that shape matches none of the provider's handled errors, so it
 * surfaces as a bare 500 that reads as our outage. The mapping is deliberately
 * narrow, and the narrowness is the part worth testing: everything that is not
 * exactly this shape has to keep the answer the provider gave.
 */

function claimError(claim: string): Error {
  // jose's shape, as `onAPIError.onError` stashes it — not an instance of the
  // real class, because what the mapping keys on is the name and the claim.
  const error = new Error("unexpected \"iss\" claim value")
  error.name = "JWTClaimValidationFailed"
  return Object.assign(error, { claim })
}

function runtimeAnswering(response: Response): Runtime {
  return {
    config: { base: parseBasePath(ISSUER) },
    auth: { handler: () => Promise.resolve(response) },
  } as unknown as Runtime
}

async function forwardWith(
  response: Response,
  error: unknown,
  providerPath = "/oauth2/userinfo"
): Promise<Response> {
  return withRequestContext(
    { requestId: "test", ...(error === undefined ? {} : { authApiError: error }) },
    () =>
      forwardToAuth(
        runtimeAnswering(response),
        new Request(`${ISSUER}${providerPath}`, {
          method: "POST",
          body: "token=x",
        }),
        { providerPath }
      )
  )
}

describe("mapCrossHostTokenError", () => {
  const bare500 = () => new Response("", { status: 500 })

  it("turns the 500 into a 401 invalid_token on userinfo", async () => {
    const response = await forwardWith(bare500(), claimError("iss"))
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: "invalid_token" })
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer error="invalid_token"'
    )
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  it("does the same on introspection and on revocation", async () => {
    for (const path of ["/oauth2/introspect", "/oauth2/revoke"]) {
      const response = await forwardWith(bare500(), claimError("iss"), path)
      expect(response.status, path).toBe(401)
    }
  })

  it("leaves the 500 alone when nothing was stashed", async () => {
    expect((await forwardWith(bare500(), undefined)).status).toBe(500)
  })

  it("leaves the 500 alone when the stashed value is not an Error", async () => {
    expect(
      (await forwardWith(bare500(), { name: "JWTClaimValidationFailed" })).status
    ).toBe(500)
  })

  it("leaves the 500 alone for another error name", async () => {
    const other = Object.assign(new Error("boom"), { claim: "iss" })
    expect((await forwardWith(bare500(), other)).status).toBe(500)
  })

  it("leaves the 500 alone for a claim that is not iss", async () => {
    // An `aud` or `exp` failure is the caller's ordinary expired-token case
    // and has nothing to do with which host it arrived on.
    expect((await forwardWith(bare500(), claimError("aud"))).status).toBe(500)
  })

  it("never touches a status that is not 500", async () => {
    // The provider's own 401 for a token it rejected properly, and the
    // ordinary success both keep their answer even with the error stashed.
    const unauthorized = await forwardWith(
      new Response('{"error":"invalid_token"}', { status: 401 }),
      claimError("iss")
    )
    expect(unauthorized.status).toBe(401)
    const ok = await forwardWith(
      new Response('{"sub":"u1"}', { status: 200 }),
      claimError("iss")
    )
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ sub: "u1" })
  })

  it("is not applied to the token endpoint", async () => {
    // `/oauth2/token` authenticates a client, not a bearer token; a 500 there
    // is never this shape and must not be relabeled as a token problem.
    expect(
      (await forwardWith(bare500(), claimError("iss"), "/oauth2/token")).status
    ).toBe(500)
  })
})
