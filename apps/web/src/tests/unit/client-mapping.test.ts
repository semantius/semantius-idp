/**
 * `oauth_clients.jsonc` → `oauth_client` (FR-OIDC-2/3).
 *
 * The mapping is where a configuration file becomes an authorization
 * decision, so each assertion here is a rule with a consequence: a public
 * client that kept a secret would be a client whose "secret" is in every
 * user's browser, and a `userId` that was not null would make a config-synced
 * client indistinguishable from one a user registered.
 */

import { describe, expect, it } from "vitest"

import { deriveConfig } from "@/server/config/derive"
import type { IdpConfig } from "@/server/config/derive"
import { configFileSchema } from "@/server/config/schema/config-schema"
import { clientSchema } from "@/server/config/schema/clients-schema"
import type { ClientEntry } from "@/server/config/schema/clients-schema"
import { BUILT_IN_ROLES } from "@/server/config/schema/roles-schema"
import {
  authMethodFor,
  isPublic,
  resourceLinksFor,
  toClientRow,
} from "@/server/oidc/client-mapping"
import { hashClientSecret, verifyClientSecret } from "@/server/oidc/secret-hash"

const SECRET = "a-client-secret-of-at-least-32-characters"

function entry(overrides: Record<string, unknown>): ClientEntry {
  return clientSchema.parse({
    clientId: "app",
    type: "web",
    clientSecret: SECRET,
    redirectUris: ["https://app.example.com/callback"],
    // The schema refuses `enableEndSession` without somewhere to come back
    // to; turning it off keeps these cases about the mapping.
    enableEndSession: false,
    ...overrides,
  })
}

function configWith(overrides: Record<string, unknown> = {}): IdpConfig {
  const file = configFileSchema.parse({
    server: { baseUrl: "https://idp.example.com" },
    secret: "0123456789abcdef0123456789abcdef0123456789",
    database: { url: "postgres://idp:idp@localhost:5432/idp" },
    site: { name: "Test IdP" },
    jwt: { audience: "https://idp.example.com" },
    ...overrides,
  })
  return deriveConfig(file, [], BUILT_IN_ROLES)
}

describe("toClientRow", () => {
  it("never claims a config client belongs to a user (FR-OIDC-2)", () => {
    expect(toClientRow(entry({})).userId).toBeNull()
  })

  it("stores the hash it is given, for a confidential client", () => {
    const row = toClientRow(entry({}), { hashedSecret: "deadbeef" })
    expect(row.clientSecret).toBe("deadbeef")
    expect(row.tokenEndpointAuthMethod).toBe("client_secret_basic")
  })

  it("refuses to store a secret for a public client", () => {
    const spa = entry({ type: "spa", clientSecret: undefined })
    // Even handed one, which the schema already prevents: a public client's
    // "secret" would be sitting in every browser that runs it.
    const row = toClientRow(spa, { hashedSecret: "deadbeef" })
    expect(row.clientSecret).toBeNull()
    expect(row.tokenEndpointAuthMethod).toBe("none")
    expect(row.requirePKCE).toBe(true)
  })

  it("marks a native client as such, and nothing else", () => {
    const native = toClientRow(
      entry({
        type: "native",
        clientSecret: undefined,
        redirectUris: ["com.example.app:/callback"],
      })
    )
    expect(native.applicationType).toBe("native")
    expect(toClientRow(entry({})).applicationType).toBeNull()
    expect(
      toClientRow(entry({ type: "spa", clientSecret: undefined }))
        .applicationType
    ).toBeNull()
  })

  it("defaults to the two v1 grants and the code response type (D26)", () => {
    const row = toClientRow(entry({}))
    expect(row.grantTypes).toEqual(["authorization_code", "refresh_token"])
    expect(row.responseTypes).toEqual(["code"])
  })

  it("distinguishes 'no scopes declared' from 'no scopes allowed'", () => {
    // `null` means the deployment's own list applies; `[]` would mean this
    // client may ask for nothing at all.
    expect(toClientRow(entry({})).scopes).toBeNull()
    expect(toClientRow(entry({ scopes: ["openid"] })).scopes).toEqual([
      "openid",
    ])
  })

  it("mirrors the flags that have no column into metadata (S5)", () => {
    const row = toClientRow(
      entry({ resourceServer: true, firstParty: true, metadata: { team: "x" } })
    )
    expect(row.metadata).toEqual({
      team: "x",
      resourceServer: true,
      firstParty: true,
    })
    // Nothing to mirror and nothing declared: the column stays empty rather
    // than holding `{}`.
    expect(toClientRow(entry({})).metadata).toBeNull()
  })
})

describe("authMethodFor", () => {
  it("honors an explicit method", () => {
    expect(
      authMethodFor(entry({ tokenEndpointAuthMethod: "client_secret_post" }))
    ).toBe("client_secret_post")
  })

  it("defaults by client type", () => {
    expect(authMethodFor(entry({}))).toBe("client_secret_basic")
    expect(authMethodFor(entry({ type: "spa", clientSecret: undefined }))).toBe(
      "none"
    )
  })
})

describe("isPublic", () => {
  it("is the confidential/public split, not the client id", () => {
    expect(isPublic(entry({}))).toBe(false)
    expect(isPublic(entry({ type: "spa", clientSecret: undefined }))).toBe(true)
    expect(
      isPublic(
        entry({
          type: "native",
          clientSecret: undefined,
          redirectUris: ["com.example.app:/callback"],
        })
      )
    ).toBe(true)
  })
})

describe("resourceLinksFor", () => {
  it("always includes the default audience (FR-OIDC-6)", () => {
    // Without this link a client could never obtain a JWT access token, since
    // `enforcePerClientResources` refuses a resource the client is not
    // linked to.
    expect(resourceLinksFor(entry({}), configWith())).toEqual([
      "https://idp.example.com",
    ])
  })

  it("adds what the client declares, without duplicating", () => {
    const config = configWith({
      oauth: {
        resources: [{ identifier: "https://api.example.com", name: "API" }],
      },
    })
    expect(
      resourceLinksFor(
        entry({
          audience: ["https://api.example.com", "https://idp.example.com"],
        }),
        config
      )
    ).toEqual(["https://idp.example.com", "https://api.example.com"])
  })

  it("accepts a single audience as well as a list", () => {
    const config = configWith({
      oauth: {
        resources: [{ identifier: "https://api.example.com", name: "API" }],
      },
    })
    expect(
      resourceLinksFor(entry({ audience: "https://api.example.com" }), config)
    ).toEqual(["https://idp.example.com", "https://api.example.com"])
  })

  it("links a resource server to the whole registry (FR-OIDC-4)", () => {
    const config = configWith({
      oauth: {
        resources: [
          { identifier: "https://api.example.com", name: "API" },
          { identifier: "https://reports.example.com", name: "Reports" },
        ],
      },
    })
    // That is what makes it able to introspect tokens it is an audience for
    // rather than only the ones it was issued. Order is not meaningful — the
    // links are a set — so this asserts membership, not the registry's order.
    expect(
      [...resourceLinksFor(entry({ resourceServer: true }), config)].sort()
    ).toEqual([
      "https://api.example.com",
      "https://idp.example.com",
      "https://reports.example.com",
    ])
  })
})

describe("client secret hashing (risk R4)", () => {
  it("is deterministic, so an unchanged file writes nothing", () => {
    expect(hashClientSecret(SECRET)).toBe(hashClientSecret(SECRET))
  })

  it("verifies the secret it hashed, and nothing else", () => {
    const stored = hashClientSecret(SECRET)
    expect(verifyClientSecret(SECRET, stored)).toBe(true)
    expect(verifyClientSecret(`${SECRET}x`, stored)).toBe(false)
    expect(verifyClientSecret("", stored)).toBe(false)
  })

  it("refuses a stored value that is not a hash at all", () => {
    // An empty or malformed column must not compare equal to anything — the
    // constant-time comparison throws on mismatched lengths, so this is the
    // branch that has to be handled rather than crashed on.
    expect(verifyClientSecret(SECRET, "")).toBe(false)
    expect(verifyClientSecret(SECRET, "not-hex")).toBe(false)
  })

  it("produces a hex digest of the expected width", () => {
    expect(hashClientSecret(SECRET)).toMatch(/^[0-9a-f]{64}$/)
  })
})
