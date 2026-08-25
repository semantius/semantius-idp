import { describe, expect, it } from "vitest"

import { configFileSchema } from "@/server/config/schema/config-schema"
import { baseConfig } from "@/tests/fixtures/config-files"

/**
 * Locks the whole CFG-4 default table in one snapshot-style assertion.
 *
 * A nested `.default({})` that is not re-parsed, or a duration default left as
 * a string, silently produces the wrong effective value everywhere; this test
 * is the one place that would notice.
 */
describe("CFG-4 defaults", () => {
  const parsed = configFileSchema.parse(baseConfig())

  it("resolves every documented default", () => {
    expect(parsed).toEqual({
      server: {
        baseUrl: "http://localhost:3000",
        host: "0.0.0.0",
        port: 3000,
        trustProxy: false,
        allowInsecureHttp: false,
        shutdownTimeoutSeconds: 10,
      },
      secret: expect.any(String),
      database: {
        url: "postgres://idp:idp@localhost:5432/idp",
        schema: "idp",
        poolMax: 10,
        connectTimeoutSeconds: 30,
        migrateOnBoot: true,
      },
      site: {
        name: "Test IdP",
        theme: "system",
        defaultLocale: "en-US",
        nameFormat: "first-last",
      },
      email: { resend: {} },
      signUp: {
        enabled: false,
        requireApproval: true,
        allowedEmailDomains: [],
      },
      auth: {
        defaultRedirect: "/account",
        requireEmailVerification: true,
        password: { minLength: 12, maxLength: 128, breachCheck: false },
        passwordReset: { tokenTtlMinutes: 60 },
      },
      session: {
        expiresIn: 7 * 86_400,
        updateAge: 86_400,
        cookieCacheMinutes: 5,
        freshAgeMinutes: 15,
        revokeOAuthTokensOnLogout: false,
      },
      social: {},
      twoFactor: { enabled: true, trustDeviceDays: 30 },
      apiKeys: {
        enabled: true,
        defaultExpiresIn: 365 * 86_400,
        maxExpiresIn: 730 * 86_400,
        tokenClientId: "idp",
        tokenTtl: 3600,
      },
      jwt: {
        algorithm: "ES256",
        audience: "http://localhost:3000",
        includeUserData: true,
        claims: {},
        claimsInIdToken: false,
        rotationInterval: 90 * 86_400,
        sessionToken: { ttl: 3600 },
      },
      oauth: {
        accessTokenTtl: 15 * 60,
        idTokenTtl: 3600,
        codeTtl: 60,
        refreshTokenTtl: 30 * 86_400,
        refreshTokenMaxLifetime: 90 * 86_400,
        scopes: ["openid", "profile", "email", "offline_access"],
        resources: [],
        reconcile: { prune: false },
      },
      admin: { adminRoles: ["admin"], allowImpersonation: false },
      rateLimit: { enabled: true, storage: "database" },
      logging: { level: "info", format: "json" },
      cleanup: { intervalMinutes: 60 },
      audit: { retentionDays: 90 },
    })
  })

  it("expresses every duration in seconds", () => {
    const durations = [
      parsed.session.expiresIn,
      parsed.session.updateAge,
      parsed.apiKeys.defaultExpiresIn,
      parsed.apiKeys.maxExpiresIn,
      parsed.apiKeys.tokenTtl,
      parsed.jwt.rotationInterval,
      parsed.jwt.sessionToken.ttl,
      parsed.oauth.accessTokenTtl,
      parsed.oauth.idTokenTtl,
      parsed.oauth.codeTtl,
      parsed.oauth.refreshTokenTtl,
      parsed.oauth.refreshTokenMaxLifetime,
    ]
    for (const value of durations) {
      expect(typeof value).toBe("number")
      expect(Number.isFinite(value)).toBe(true)
    }
  })

  it("accepts durations written with a unit suffix or as plain seconds", () => {
    expect(
      configFileSchema.parse({ ...baseConfig(), session: { expiresIn: "48h" } })
        .session.expiresIn
    ).toBe(172_800)
    expect(
      configFileSchema.parse({ ...baseConfig(), session: { expiresIn: 900 } })
        .session.expiresIn
    ).toBe(900)
    expect(
      configFileSchema.safeParse({
        ...baseConfig(),
        session: { expiresIn: "7 fortnights" },
      }).success
    ).toBe(false)
  })
})

describe("auth.defaultRedirect (D28)", () => {
  const parseRedirect = (defaultRedirect: unknown) =>
    configFileSchema.safeParse({ ...baseConfig(), auth: { defaultRedirect } })

  it.each([
    "/account",
    "/",
    "/products/dashboard?tab=1",
    "https://apps.example.com/",
    "https://apps.example.com/app#section",
    "http://localhost:5173/",
  ])("accepts %s", (value) => {
    expect(parseRedirect(value).success).toBe(true)
  })

  it.each([
    // The trap this key exists to catch: neither a path nor a URL, and
    // resolving it as a path would send everyone to `/example.com`.
    ["example.com", "bare hostname"],
    ["//evil.example/", "protocol-relative"],
    ["/\\evil.example/", "backslash-smuggled"],
    ["/redirect?to=https://evil.example", "scheme inside a path"],
    ["javascript:alert(1)", "javascript scheme"],
    ["data:text/html,<script>", "data scheme"],
    ["", "empty"],
    ["account", "relative without a leading slash"],
  ])("rejects %s (%s)", (value) => {
    expect(parseRedirect(value).success).toBe(false)
  })

  it("leaves SEC-3 alone — this is config, `returnTo` is not", () => {
    // Cross-origin is legitimate *here* because it comes from the operator's
    // file. The runtime parameter is validated by `safeReturnTo` and is
    // covered by its own tests.
    expect(parseRedirect("https://elsewhere.example/app").success).toBe(true)
  })
})
