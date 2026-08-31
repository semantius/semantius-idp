import { describe, expect, it } from "vitest"

import { ConfigError } from "@/server/config/errors"
import { loadConfig } from "@/server/config/loader"
import {
  baseConfig,
  makeConfigFolder,
  spaClient,
  VALID_SECRET,
  webClient,
} from "@/tests/fixtures/config-files"

type Folder = Parameters<typeof makeConfigFolder>[0]

function load(
  options: Folder = {},
  env: Record<string, string | undefined> = {}
) {
  const folder = makeConfigFolder(options)
  return loadConfig({ dir: "/config", env, readFile: folder.readFile })
}

function issuesOf(
  options: Folder = {},
  env: Record<string, string | undefined> = {}
) {
  try {
    load(options, env)
  } catch (error) {
    if (error instanceof ConfigError) return error.issues
    throw error
  }
  return []
}

function messages(
  options: Folder = {},
  env: Record<string, string | undefined> = {}
) {
  return issuesOf(options, env)
    .map((issue) => `${issue.pointer} ${issue.message}`)
    .join("\n")
}

const prodConfig = (extra: Record<string, unknown> = {}) => ({
  ...baseConfig(),
  server: { baseUrl: "https://idp.example.com" },
  jwt: { audience: "https://idp.example.com" },
  secret: "${env:IDP_SECRET}",
  ...extra,
})

describe("CFG-5 cross-checks", () => {
  it("rejects a secret shorter than 32 characters", () => {
    expect(
      messages({ config: { ...baseConfig(), secret: "too-short" } })
    ).toContain("at least 32 characters")
  })

  it("rejects a non-https baseUrl outside localhost unless allowInsecureHttp is set", () => {
    const config = {
      ...baseConfig(),
      server: { baseUrl: "http://idp.example.com" },
      jwt: { audience: "http://idp.example.com" },
    }
    expect(messages({ config })).toContain(
      "non-https baseUrl outside localhost"
    )

    const allowed = {
      ...config,
      server: { ...config.server, allowInsecureHttp: true },
    }
    expect(issuesOf({ config: allowed })).toEqual([])
  })

  it("rejects a trailing slash on the issuer", () => {
    const config = {
      ...baseConfig(),
      server: { baseUrl: "http://localhost:3000/" },
    }
    expect(messages({ config })).toContain("trailing slash")
  })

  it("rejects reserved names in jwt.claims", () => {
    const config = {
      ...baseConfig(),
      jwt: { audience: "http://localhost:3000", claims: { roles: "x" } },
    }
    expect(messages({ config })).toContain("reserved claim")
  })

  it("accepts a static role claim, which is the Neon/PostgREST case", () => {
    const config = {
      ...baseConfig(),
      jwt: {
        audience: "http://localhost:3000",
        claims: { role: "authenticated" },
      },
    }
    expect(issuesOf({ config })).toEqual([])
  })

  it("requires openid in oauth.scopes", () => {
    const config = { ...baseConfig(), oauth: { scopes: ["profile", "email"] } }
    expect(messages({ config })).toContain("must include `openid`")
  })

  it("rejects a refresh TTL above the absolute maximum", () => {
    const config = {
      ...baseConfig(),
      oauth: { refreshTokenTtl: "120d", refreshTokenMaxLifetime: "90d" },
    }
    expect(messages({ config })).toContain("cannot exceed")
  })

  it("rejects a resource whose allowedScopes are not declared", () => {
    const config = {
      ...baseConfig(),
      oauth: {
        resources: [
          { identifier: "https://api.example.com", allowedScopes: ["admin"] },
        ],
      },
    }
    expect(messages({ config })).toContain("undeclared scope `admin`")
  })

  it("rejects a client scope that is not in oauth.scopes", () => {
    expect(
      messages({
        clients: { clients: [webClient({ scopes: ["openid", "billing"] })] },
      })
    ).toContain("undeclared scope `billing`")
  })

  it("rejects duplicate client ids", () => {
    const clients = {
      clients: [
        webClient(),
        webClient({ redirectUris: ["https://other.example.com/cb"] }),
      ],
    }
    expect(messages({ clients })).toContain("Duplicate clientId `web-app`")
  })

  it("rejects a first-party client that is not on the issuer origin", () => {
    expect(
      messages({ clients: { clients: [webClient({ firstParty: true })] } })
    ).toContain("requires every redirect URI to be on the issuer origin")
  })

  it("accepts a first-party client on the issuer origin", () => {
    const clients = {
      clients: [
        webClient({
          firstParty: true,
          redirectUris: ["http://localhost:3000/app/callback"],
          postLogoutRedirectUris: ["http://localhost:3000/app"],
        }),
      ],
    }
    expect(issuesOf({ clients })).toEqual([])
  })

  describe("FR-ROLE-1 catalog", () => {
    it("rejects duplicate role names", () => {
      const roles = {
        roles: [{ name: "user", default: true }, { name: "user" }],
      }
      expect(messages({ roles })).toContain("Duplicate role `user`")
    })

    it("requires exactly one default role", () => {
      expect(messages({ roles: { roles: [{ name: "user" }] } })).toContain(
        "Exactly one role must set"
      )
      expect(
        messages({
          roles: {
            roles: [
              { name: "user", default: true },
              { name: "guest", default: true },
            ],
          },
        })
      ).toContain("Exactly one role may set")
    })

    it("rejects a role name with a comma", () => {
      expect(
        messages({ roles: { roles: [{ name: "a,b", default: true }] } })
      ).toContain("Role names must match")
    })

    it("rejects an adminRoles entry missing from the catalog", () => {
      const config = { ...baseConfig(), admin: { adminRoles: ["superuser"] } }
      expect(messages({ config })).toContain(
        "`superuser` is not in the role catalog"
      )
    })
  })

  describe("FR-SOC-5 Entra tenant lock", () => {
    const withMicrosoft = (microsoft: Record<string, unknown>) => ({
      ...baseConfig(),
      social: {
        microsoft: { clientId: "id", clientSecret: "secret", ...microsoft },
      },
    })

    it("rejects common, organizations and consumers", () => {
      for (const tenantId of [
        "common",
        "organizations",
        "consumers",
        "COMMON",
      ]) {
        expect(messages({ config: withMicrosoft({ tenantId }) })).toContain(
          "is not a tenant"
        )
      }
    })

    it("requires a tenantId at all", () => {
      expect(messages({ config: withMicrosoft({}) })).toContain(
        "`social.microsoft.tenantId` is required"
      )
    })

    it("accepts a tenant GUID", () => {
      expect(
        issuesOf({
          config: withMicrosoft({
            tenantId: "8f9c1d10-3a2b-4c5d-9e6f-0a1b2c3d4e5f",
          }),
        })
      ).toEqual([])
    })
  })

  describe("production literal secrets", () => {
    const env = {
      IDP_SECRET: VALID_SECRET,
      IDP_CLIENT_SECRET: "c".repeat(40),
      IDP_RESEND: "re_live_x",
    }

    it("accepts placeholder-supplied secrets", () => {
      const config = prodConfig({
        email: {
          resend: { apiKey: "${env:IDP_RESEND}" },
          from: "idp@example.com",
        },
      })
      const clients = {
        clients: [webClient({ clientSecret: "${env:IDP_CLIENT_SECRET}" })],
      }
      expect(issuesOf({ config, clients }, env)).toEqual([])
    })

    it("rejects a literal top-level secret", () => {
      expect(
        messages({ config: prodConfig({ secret: VALID_SECRET }) }, env)
      ).toContain("`secret` is a literal value in a production deployment")
    })

    it("rejects a literal client secret", () => {
      const clients = { clients: [webClient({ clientSecret: "c".repeat(40) })] }
      expect(messages({ config: prodConfig(), clients }, env)).toContain(
        "client secret of `web-app` is a literal value"
      )
    })

    it("rejects a literal social secret and Resend key", () => {
      const config = prodConfig({
        email: {
          resend: { apiKey: "re_live_literal" },
          from: "idp@example.com",
        },
        social: { github: { clientId: "id", clientSecret: "literal-secret" } },
      })
      const text = messages({ config }, env)
      expect(text).toContain("Resend API key is a literal value")
      expect(text).toContain("`github` client secret is a literal value")
    })

    it("allows literal secrets in a non-production (http localhost) deployment", () => {
      const clients = { clients: [webClient({ clientSecret: "c".repeat(40) })] }
      expect(issuesOf({ clients })).toEqual([])
    })

    it("rejects a secret smuggled in as a placeholder's inline default", () => {
      const config = prodConfig({
        secret: "${env:UNSET_SECRET:-" + VALID_SECRET + "}",
      })
      expect(messages({ config }, env)).toContain(
        "`secret` is a literal value in a production deployment"
      )
    })
  })

  describe("warnings", () => {
    it("warns when `*` switches the origin check off (D68)", () => {
      const config = {
        ...baseConfig(),
        server: { baseUrl: "http://localhost:3000", trustedOrigins: ["*"] },
      }
      const { warnings } = load({ config })
      expect(warnings.map((warning) => warning.code)).toContain(
        "server.origin_check_disabled"
      )
    })

    it("does not warn for the default, which still checks (D68)", () => {
      const { warnings } = load({})
      expect(warnings.map((warning) => warning.code)).not.toContain(
        "server.origin_check_disabled"
      )
    })

    it("warns about unverified open registration", () => {
      const config = {
        ...baseConfig(),
        signUp: { enabled: true, requireApproval: false },
      }
      const { warnings } = load({ config })
      expect(warnings.map((warning) => warning.code)).toContain(
        "signup.unverified_open_registration"
      )
    })

    it("does not warn when a social provider is enabled while sign-up is off (D25)", () => {
      const config = {
        ...baseConfig(),
        signUp: { enabled: false },
        social: { github: { clientId: "id", clientSecret: "secret" } },
      }
      const { warnings } = load({ config })
      expect(warnings.map((warning) => warning.code)).not.toContain(
        "signup.social_without_signup"
      )
      expect(
        warnings.map((warning) => warning.message).join("\n")
      ).not.toContain("pre-existing social")
    })

    it("says nothing about administrators on a fresh deployment (D52)", () => {
      // The bootstrap warning is gone with the bootstrap. A database with no
      // users is the ordinary state of a new deployment, and the IdP announces
      // it by serving `/setup` rather than by warning about configuration.
      expect(load().warnings.map((warning) => warning.code)).not.toContain(
        "admin.bootstrap_skipped"
      )
    })

    it("rejects `admin.bootstrap`, which no longer exists (D52)", () => {
      const config = {
        ...baseConfig(),
        admin: {
          bootstrap: {
            email: "admin@example.com",
            password: "correct horse battery staple",
          },
        },
      }
      // A clean break, not an ignored key: an operator upgrading with the old
      // block still in place is told, rather than quietly getting no admin.
      expect(messages({ config })).toContain("`bootstrap`")
    })
  })

  it("rejects an e-mail transport without a from address", () => {
    const config = { ...baseConfig(), email: { resend: { apiKey: "re_test" } } }
    expect(messages({ config })).toContain("`email.from` is required")
  })

  it("keeps a public client's PKCE requirement", () => {
    expect(
      messages({ clients: { clients: [spaClient({ requirePKCE: false })] } })
    ).toContain("PKCE is mandatory")
  })

  describe("server.dynamicIssuer contradictions", () => {
    const dynamicConfig = (server: Record<string, unknown> = {}) => ({
      ...baseConfig(),
      server: {
        baseUrl: "http://localhost:3000",
        dynamicIssuer: true,
        trustProxy: true,
        ...server,
      },
    })

    it("refuses dynamicIssuer with trustProxy off", () => {
      expect(
        messages({ config: dynamicConfig({ trustProxy: false }) })
      ).toContain("requires `server.trustProxy`")
    })

    it("refuses dynamicIssuer with a domain-wide session cookie", () => {
      const config = {
        ...baseConfig(),
        server: {
          baseUrl: "https://apps.example.com/idp",
          dynamicIssuer: true,
          trustProxy: true,
          cookieDomain: "example.com",
        },
      }
      expect(messages({ config })).toContain("`server.cookieDomain`")
    })

    it("refuses a {host} redirect URI while dynamicIssuer is off", () => {
      expect(
        messages({
          clients: {
            clients: [
              spaClient({ redirectUris: ["https://{host}/oauth2_callback"] }),
            ],
          },
        })
      ).toContain("`{host}` template")
    })

    it("accepts a {host} redirect URI with dynamicIssuer on", () => {
      const { warnings } = load({
        config: dynamicConfig(),
        clients: {
          clients: [
            spaClient({ redirectUris: ["https://{host}/oauth2_callback"] }),
          ],
        },
      })
      expect(warnings).toBeDefined()
    })

    it("lets a {host} URI satisfy the firstParty same-origin rule", () => {
      const { warnings } = load({
        config: dynamicConfig(),
        clients: {
          clients: [
            spaClient({
              firstParty: true,
              redirectUris: ["https://{host}/oauth2_callback"],
            }),
          ],
        },
      })
      expect(warnings).toBeDefined()
    })

    it("warns that social callbacks stay on the canonical host", () => {
      const { warnings } = load({
        config: {
          ...dynamicConfig(),
          social: { github: { clientId: "id", clientSecret: "secret" } },
        },
      })
      expect(warnings.map((warning) => warning.code)).toContain(
        "social.canonical_host_only"
      )
    })
  })

  describe("shipped default secrets are detectable (warnings, never refusals)", () => {
    it("warns about the shipped dev `secret`, which passes every shape check", () => {
      const config = {
        ...baseConfig(),
        secret: "dev-only-idp-secret-change-me-0123456789abcdef",
      }
      const { warnings } = load({ config })
      expect(warnings.map((warning) => warning.code)).toContain(
        "secret.shipped_default"
      )
    })

    it("warns about a shipped default database password", () => {
      const config = {
        ...baseConfig(),
        database: { url: "postgres://postgres:postgres@localhost:5432/db" },
      }
      const { warnings } = load({ config })
      expect(warnings.map((warning) => warning.code)).toContain(
        "database.shipped_default_password"
      )
    })

    it("stays a warning on an https deployment — a refusal would demand a key rotation", () => {
      // `isProduction` flips the moment the baseUrl becomes https; the remedy
      // for a shipped secret at that point (rotating it) logs everyone out
      // and makes the stored signing keys undecryptable. So: loud, not fatal.
      const config = {
        ...prodConfig(),
        secret: "${env:IDP_SECRET}",
      }
      const { warnings } = load(
        { config },
        { IDP_SECRET: "dev-only-idp-secret-change-me-0123456789abcdef" }
      )
      expect(warnings.map((warning) => warning.code)).toContain(
        "secret.shipped_default"
      )
    })

    it("does not warn about a real secret and real credentials", () => {
      const { warnings } = load({})
      const codes = warnings.map((warning) => warning.code)
      expect(codes).not.toContain("secret.shipped_default")
      expect(codes).not.toContain("database.shipped_default_password")
    })
  })
})
