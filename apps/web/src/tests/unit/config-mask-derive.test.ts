import { describe, expect, it } from "vitest"

import { deriveConfig, parseBasePath } from "@/server/config/derive"
import { maskConfig, maskConnectionString } from "@/server/config/mask"
import { configFileSchema } from "@/server/config/schema/config-schema"
import { BUILT_IN_ROLES } from "@/server/config/schema/roles-schema"
import { baseConfig, VALID_SECRET } from "@/tests/fixtures/config-files"

const parse = (overrides: Record<string, unknown> = {}) =>
  configFileSchema.parse({ ...baseConfig(), ...overrides })

describe("mask.ts (CFG-5, SEC-5)", () => {
  it("masks every secret-bearing pointer", () => {
    const masked = maskConfig({
      secret: VALID_SECRET,
      site: { name: "IdP" },
      email: { resend: { apiKey: "re_live_abc" } },
      social: {
        github: { clientId: "public-id", clientSecret: "very-secret" },
      },
      admin: { bootstrap: { email: "admin@example.com", password: "hunter2" } },
      clients: [{ clientId: "web", clientSecret: "s".repeat(40) }],
    })
    expect(masked).toEqual({
      secret: "***",
      site: { name: "IdP" },
      email: { resend: { apiKey: "***" } },
      social: { github: { clientId: "public-id", clientSecret: "***" } },
      admin: { bootstrap: { email: "admin@example.com", password: "***" } },
      clients: [{ clientId: "web", clientSecret: "***" }],
    })
  })

  it("keeps a connection string readable but removes the password", () => {
    expect(
      maskConnectionString(
        "postgres://idp:hunter2@db.example.com:5432/idp?sslmode=require"
      )
    ).toBe("postgres://idp:***@db.example.com:5432/idp?sslmode=require")
    expect(maskConnectionString("not a url")).toBe("***")
  })

  it("masks database.url in place", () => {
    const masked = maskConfig({
      database: { url: "postgres://u:p@h/db", schema: "idp" },
    })
    expect(masked.database.url).toBe("postgres://u:***@h/db")
    expect(masked.database.schema).toBe("idp")
  })
})

describe("derive.ts", () => {
  it("parses a host-root base URL", () => {
    expect(parseBasePath("https://idp.example.com")).toEqual({
      origin: "https://idp.example.com",
      basePath: "",
      cookiePath: "/",
      secure: true,
    })
  })

  it("parses a sub-path base URL (OPS-10)", () => {
    expect(parseBasePath("https://apps.example.com/idp")).toEqual({
      origin: "https://apps.example.com",
      basePath: "/idp",
      cookiePath: "/idp",
      secure: true,
    })
  })

  it("forces email verification off in degraded mode (FR-MAIL-2)", () => {
    const config = deriveConfig(
      parse({ auth: { requireEmailVerification: true } }),
      [],
      BUILT_IN_ROLES
    )
    expect(config.emailEnabled).toBe(false)
    expect(config.requireEmailVerification).toBe(false)
  })

  it("keeps email verification on when a transport is configured", () => {
    const config = deriveConfig(
      parse({
        email: { resend: { apiKey: "re_test" }, from: "idp@example.com" },
      }),
      [],
      BUILT_IN_ROLES
    )
    expect(config.requireEmailVerification).toBe(true)
  })

  it("defaults the TOTP issuer to site.name", () => {
    expect(deriveConfig(parse(), [], BUILT_IN_ROLES).twoFactorIssuer).toBe(
      "Test IdP"
    )
    expect(
      deriveConfig(parse({ twoFactor: { issuer: "Acme" } }), [], BUILT_IN_ROLES)
        .twoFactorIssuer
    ).toBe("Acme")
  })

  it("defaults the JWKS grace period to the longest token lifetime + 1 h (FR-OIDC-16)", () => {
    // refreshTokenMaxLifetime 90d is the longest default lifetime.
    expect(
      deriveConfig(parse(), [], BUILT_IN_ROLES).jwksGracePeriodSeconds
    ).toBe(90 * 86_400 + 3600)
    expect(
      deriveConfig(
        parse({
          jwt: { audience: "http://localhost:3000", gracePeriod: "2h" },
        }),
        [],
        BUILT_IN_ROLES
      ).jwksGracePeriodSeconds
    ).toBe(7200)
  })

  it("selects user claims per includeUserData / userClaims (FR-OIDC-7)", () => {
    expect(deriveConfig(parse(), [], BUILT_IN_ROLES).userClaims).toEqual([
      "email",
      "name",
      "given_name",
      "family_name",
      "roles",
    ])
    expect(
      deriveConfig(
        parse({
          jwt: { audience: "http://localhost:3000", includeUserData: false },
        }),
        [],
        BUILT_IN_ROLES
      ).userClaims
    ).toEqual([])
    expect(
      deriveConfig(
        parse({
          jwt: {
            audience: "http://localhost:3000",
            userClaims: ["email", "roles"],
          },
        }),
        [],
        BUILT_IN_ROLES
      ).userClaims
    ).toEqual(["email", "roles"])
  })

  it("normalises a single or multi-valued default audience", () => {
    expect(deriveConfig(parse(), [], BUILT_IN_ROLES).defaultAudience).toEqual([
      "http://localhost:3000",
    ])
    expect(
      deriveConfig(
        parse({
          jwt: { audience: ["https://a.example.com", "https://b.example.com"] },
        }),
        [],
        BUILT_IN_ROLES
      ).defaultAudience
    ).toEqual(["https://a.example.com", "https://b.example.com"])
  })

  it("defaults database.ssl from the database host, not the issuer", () => {
    expect(deriveConfig(parse(), [], BUILT_IN_ROLES).databaseSsl).toBe(
      "disable"
    )
    expect(
      deriveConfig(
        parse({ database: { url: "postgres://u:p@db.neon.tech/idp" } }),
        [],
        BUILT_IN_ROLES
      ).databaseSsl
    ).toBe("require")
  })
})
