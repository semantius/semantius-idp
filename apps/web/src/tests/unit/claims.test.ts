/**
 * The claims builder and the default-resource injection (FR-OIDC-6/7,
 * FR-ROLE-2, risk R1).
 *
 * Both are pure, and both decide something a resource server will act on: what
 * a token says about a user, and whether the token is a JWT at all.
 */

import { describe, expect, it } from "vitest"

import { buildUserClaims } from "@/server/claims/build-claims"
import { deriveConfig } from "@/server/config/derive"
import type { IdpConfig } from "@/server/config/derive"
import { clientSchema } from "@/server/config/schema/clients-schema"
import { configFileSchema } from "@/server/config/schema/config-schema"
import { BUILT_IN_ROLES } from "@/server/config/schema/roles-schema"
import {
  defaultResourceFor,
  injectDefaultResource,
} from "@/server/auth/options/hooks"

const USER = {
  email: "user@example.com",
  name: "Ada Lovelace",
  firstName: "Ada",
  lastName: "Lovelace",
  role: "admin,user",
}

function configWith(
  overrides: Record<string, unknown> = {},
  clients: Record<string, unknown>[] = []
): IdpConfig {
  const { jwt, ...rest } = overrides
  const file = configFileSchema.parse({
    server: { baseUrl: "https://idp.example.com" },
    secret: "0123456789abcdef0123456789abcdef0123456789",
    database: { url: "postgres://idp:idp@localhost:5432/idp" },
    site: { name: "Test IdP" },
    ...rest,
    jwt: {
      audience: "https://idp.example.com",
      ...((jwt as Record<string, unknown> | undefined) ?? {}),
    },
  })
  return deriveConfig(
    file,
    clients.map((client) => clientSchema.parse(client)),
    BUILT_IN_ROLES
  )
}

describe("buildUserClaims", () => {
  it("emits the whole default set", () => {
    expect(buildUserClaims(USER, configWith())).toEqual({
      email: "user@example.com",
      name: "Ada Lovelace",
      given_name: "Ada",
      family_name: "Lovelace",
      roles: ["admin", "user"],
    })
  })

  it("emits only the claims the deployment asked for", () => {
    expect(
      buildUserClaims(USER, configWith({ jwt: { userClaims: ["email"] } }))
    ).toEqual({ email: "user@example.com" })
  })

  it("emits nothing about the user when includeUserData is off", () => {
    // Not even `roles`: a deployment that says "no user data in tokens" means
    // it, and a role list is user data.
    expect(
      buildUserClaims(USER, configWith({ jwt: { includeUserData: false } }))
    ).toEqual({})
  })

  it("merges static claims, which cannot be shadowed by a user claim", () => {
    const config = configWith({
      jwt: { claims: { role: "authenticated", email: "constant" } },
    })
    const claims = buildUserClaims(USER, config)
    expect(claims.role).toBe("authenticated")
    // The user's own address wins over a constant of the same name: a static
    // claim is a default for the deployment, not an override of identity.
    expect(claims.email).toBe("user@example.com")
  })

  it("keeps the static claims when there is no user at all", () => {
    const config = configWith({ jwt: { claims: { role: "authenticated" } } })
    expect(buildUserClaims(null, config)).toEqual({ role: "authenticated" })
    expect(buildUserClaims(undefined, config)).toEqual({
      role: "authenticated",
    })
  })

  it("drops a role that is no longer in the catalog (FR-ROLE-2)", () => {
    // The column still says `legacy`; the catalog does not. A resource server
    // authorizing on a role this deployment no longer defines is exactly what
    // the catalog exists to prevent.
    const claims = buildUserClaims(
      { ...USER, role: "admin,legacy" },
      configWith()
    )
    expect(claims.roles).toEqual(["admin"])
  })

  it("emits an empty roles array rather than omitting it", () => {
    // So a reader can tell "this user has no roles" from "this IdP does not
    // send roles" without consulting the configuration.
    expect(buildUserClaims({ ...USER, role: "" }, configWith()).roles).toEqual(
      []
    )
  })

  it("omits absent fields instead of emitting empty strings", () => {
    const claims = buildUserClaims(
      { email: "user@example.com", role: "user" },
      configWith()
    )
    expect(claims).not.toHaveProperty("name")
    expect(claims).not.toHaveProperty("given_name")
    expect(claims).not.toHaveProperty("family_name")
  })

  it("ignores values that are not strings", () => {
    const claims = buildUserClaims(
      { email: 42, name: null, role: undefined },
      configWith()
    )
    expect(claims).toEqual({ roles: [] })
  })
})

const CLIENT = {
  clientId: "app",
  type: "web",
  clientSecret: "a-client-secret-of-at-least-32-characters",
  redirectUris: ["https://app.example.com/callback"],
  enableEndSession: false,
}

describe("injectDefaultResource (risk R1)", () => {
  it("supplies the default audience when authorize names none", () => {
    // Without a resource the provider issues an *opaque* token, which is the
    // failure FR-OIDC-5/6 exists to prevent.
    const query: Record<string, unknown> = { client_id: "app" }
    injectDefaultResource({ path: "/oauth2/authorize", query }, configWith())
    expect(query.resource).toBe("https://idp.example.com")
  })

  it("supplies it on the token endpoint too", () => {
    // Covers a refresh token minted before this hook existed, and a client
    // that never went through `/oauth2/authorize`.
    const body: Record<string, unknown> = { client_id: "app" }
    injectDefaultResource({ path: "/oauth2/token", body }, configWith())
    expect(body.resource).toBe("https://idp.example.com")
  })

  it("does not second-guess a client that named its own", () => {
    const query: Record<string, unknown> = {
      client_id: "app",
      resource: "https://api.example.com",
    }
    injectDefaultResource({ path: "/oauth2/authorize", query }, configWith())
    expect(query.resource).toBe("https://api.example.com")
  })

  it("treats an empty resource as absent", () => {
    const query: Record<string, unknown> = { client_id: "app", resource: "" }
    injectDefaultResource({ path: "/oauth2/authorize", query }, configWith())
    expect(query.resource).toBe("https://idp.example.com")

    const list: Record<string, unknown> = { client_id: "app", resource: [] }
    injectDefaultResource(
      { path: "/oauth2/authorize", query: list },
      configWith()
    )
    expect(list.resource).toBe("https://idp.example.com")
  })

  it("leaves every other endpoint alone", () => {
    const body: Record<string, unknown> = { client_id: "app" }
    injectDefaultResource({ path: "/sign-in/email", body }, configWith())
    expect(body).not.toHaveProperty("resource")
  })

  it("prefers the client's own audience over the deployment default", () => {
    const config = configWith(
      {
        oauth: {
          resources: [{ identifier: "https://api.example.com", name: "API" }],
        },
      },
      [{ ...CLIENT, audience: "https://api.example.com" }]
    )
    const query: Record<string, unknown> = { client_id: "app" }
    injectDefaultResource({ path: "/oauth2/authorize", query }, config)
    expect(query.resource).toBe("https://api.example.com")
  })

  it("passes several audiences through as a list", () => {
    const config = configWith(
      {
        oauth: {
          resources: [
            { identifier: "https://api.example.com", name: "API" },
            { identifier: "https://reports.example.com", name: "Reports" },
          ],
        },
      },
      [
        {
          ...CLIENT,
          audience: ["https://api.example.com", "https://reports.example.com"],
        },
      ]
    )
    const query: Record<string, unknown> = { client_id: "app" }
    injectDefaultResource({ path: "/oauth2/authorize", query }, config)
    expect(query.resource).toEqual([
      "https://api.example.com",
      "https://reports.example.com",
    ])
  })

  it("falls back to the deployment default for an unknown client", () => {
    expect(defaultResourceFor("no-such-client", configWith())).toEqual([
      "https://idp.example.com",
    ])
    expect(defaultResourceFor(undefined, configWith())).toEqual([
      "https://idp.example.com",
    ])
  })
})
