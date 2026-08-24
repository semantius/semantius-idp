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
import { rewriteDiscovery } from "@/server/oidc/protocol-proxy"
import { deriveConfig } from "@/server/config/derive"
import type { IdpConfig } from "@/server/config/derive"
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

  it("recognises a preflight", () => {
    expect(
      corsFor(request(undefined, "OPTIONS"), configWith(), "public").preflight
    ).toBe(true)
    expect(corsFor(request(), configWith(), "public").preflight).toBe(false)
  })
})
