import { describe, expect, it } from "vitest"

import { deriveConfig, parseBasePath } from "@/server/config/derive"
import {
  maskConfig,
  maskConnectionString,
  maskGatewayTarget,
} from "@/server/config/mask"
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
      clients: [{ clientId: "web", clientSecret: "s".repeat(40) }],
    })
    expect(masked).toEqual({
      secret: "***",
      site: { name: "IdP" },
      email: { resend: { apiKey: "***" } },
      social: { github: { clientId: "public-id", clientSecret: "***" } },
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

  it("also removes a password that travels in the query string", () => {
    // libpq's URI form accepts `password` and `sslpassword` as parameters, so
    // a connection string with no `:pw@` in it can still carry one.
    const masked = maskConnectionString(
      "postgres://idp@db.example.com/idp?sslmode=verify-full&password=hunter2&sslpassword=hunter3"
    )
    expect(masked).not.toContain("hunter2")
    expect(masked).not.toContain("hunter3")
    // …and the operationally useful parts survive.
    expect(masked).toContain("db.example.com")
    expect(masked).toContain("sslmode=verify-full")
  })

  /**
   * The bug this function exists for (**D93**). `maskConnectionString` ends in
   * `url.toString()`, and `URL` supplies the empty path — so every bare-origin
   * gateway target came back with a trailing slash, `checkGatewayUrl` answered
   * `trailing_slash`, and the edit form refused a save that changed only a
   * checkbox.
   */
  it("returns a gateway target byte for byte", () => {
    for (const target of [
      "https://api.example.com",
      "http://upstream.internal:9999",
      "https://api.example.com/v1",
      "https://api.example.com/v1/deep",
    ]) {
      expect(maskGatewayTarget(target)).toEqual({ url: target, masked: false })
    }
  })

  it("masks a gateway target that carries a password, and says it did", () => {
    // Only reachable for a row written by hand: `checkGatewayUrl` refuses
    // userinfo on every write path. The flag is what stops the edit page
    // prefilling a lossy value into a full-replace endpoint.
    const masked = maskGatewayTarget("https://svc:hunter2@api.example.com")
    expect(masked.masked).toBe(true)
    expect(masked.url).not.toContain("hunter2")
    expect(masked.url).toContain("api.example.com")

    // A username alone is not a secret and is left where it is — but the
    // string still round-trips unchanged, which is the property that matters.
    expect(maskGatewayTarget("https://svc@api.example.com")).toEqual({
      url: "https://svc@api.example.com",
      masked: false,
    })
  })

  it("refuses to promise anything about a target it cannot parse", () => {
    expect(maskGatewayTarget("not a url")).toEqual({
      url: "***",
      masked: true,
    })
  })

  it("masks database.url in place", () => {
    const masked = maskConfig({
      database: { url: "postgres://u:p@h/db", schema: "idp" },
    })
    expect(masked.database.url).toBe("postgres://u:***@h/db")
    expect(masked.database.schema).toBe("idp")
  })

  // directUrl (D27) shipped unmasked: it was in neither the pointer list nor
  // the connection-string branch, which was a literal `=== "/database/url"`.
  it("masks database.directUrl the same way as database.url", () => {
    const masked = maskConfig({
      database: {
        url: "postgres://u:p@pooler.example.com/db",
        directUrl:
          "postgres://u:hunter2@direct.example.com:5432/db?sslmode=require",
        schema: "idp",
      },
    })
    expect(masked.database.directUrl).toBe(
      "postgres://u:***@direct.example.com:5432/db?sslmode=require"
    )
    expect(JSON.stringify(masked)).not.toContain("hunter2")
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
    // The cookie no longer follows the mount (**D97**) — `/idp` mounts the app,
    // `/` scopes the session.
    expect(parseBasePath("https://apps.example.com/idp")).toEqual({
      origin: "https://apps.example.com",
      basePath: "/idp",
      cookiePath: "/",
      secure: true,
    })
  })

  it("takes the cookie path and domain from configuration (**D97**)", () => {
    expect(
      parseBasePath("https://apps.example.com/idp", {
        path: "/idp",
        domain: "example.com",
      })
    ).toEqual({
      origin: "https://apps.example.com",
      basePath: "/idp",
      cookiePath: "/idp",
      cookieDomain: "example.com",
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

  it("normalizes a single or multi-valued default audience", () => {
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

  describe("database.ssl and what the connection string says", () => {
    const sslFor = (url: string, ssl?: string) =>
      deriveConfig(
        parse({ database: ssl ? { url, ssl } : { url } }),
        [],
        BUILT_IN_ROLES
      ).databaseSsl

    it("honors an explicit sslmode over the host heuristic", () => {
      // The reference compose deployment: the host is `postgres` on a private
      // network, so the heuristic says "require" and Postgres has no TLS. The
      // failure is `Client network socket disconnected before secure TLS
      // connection was established`, which names nothing an operator can act
      // on — and the URL had said `sslmode=disable` all along.
      expect(sslFor("postgres://idp:p@postgres:5432/idp?sslmode=disable")).toBe(
        "disable"
      )
      expect(
        sslFor("postgres://idp:p@localhost:5432/idp?sslmode=require")
      ).toBe("require")
      expect(
        sslFor("postgres://idp:p@localhost:5432/idp?sslmode=verify-full")
      ).toBe("verify-full")
    })

    it("maps verify-ca onto verify-full", () => {
      // libpq separates them by whether the hostname is checked. Skipping that
      // check is not worth a spelling of its own.
      expect(
        sslFor("postgres://u:p@db.example.com/idp?sslmode=verify-ca")
      ).toBe("verify-full")
    })

    it("ignores the ambiguous modes and falls back to the host", () => {
      // `prefer` and `allow` mean "try, then downgrade". Reading either as
      // "disable" would silently drop TLS on a hosted database because a URL
      // was copied from somewhere.
      expect(sslFor("postgres://u:p@db.neon.tech/idp?sslmode=prefer")).toBe(
        "require"
      )
      expect(sslFor("postgres://u:p@db.neon.tech/idp?sslmode=allow")).toBe(
        "require"
      )
      expect(sslFor("postgres://u:p@db.neon.tech/idp?sslmode=nonsense")).toBe(
        "require"
      )
    })

    it("lets the config file override the connection string", () => {
      expect(
        sslFor("postgres://u:p@db.example.com/idp?sslmode=disable", "require")
      ).toBe("require")
    })
  })
})
