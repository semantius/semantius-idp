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

function load(
  options: Parameters<typeof makeConfigFolder>[0] = {},
  env: Record<string, string | undefined> = {}
) {
  const folder = makeConfigFolder(options)
  return loadConfig({
    dir: options.dir ?? "/config",
    env,
    readFile: folder.readFile,
  })
}

function expectIssues(
  options: Parameters<typeof makeConfigFolder>[0] = {},
  env: Record<string, string | undefined> = {}
) {
  try {
    load(options, env)
  } catch (error) {
    if (error instanceof ConfigError) return error.issues
    throw error
  }
  throw new Error("expected loadConfig to throw a ConfigError")
}

describe("config loader", () => {
  it("loads a minimal valid folder and derives defaults", () => {
    const { config, warnings } = load()
    expect(config.file.server.port).toBe(3000)
    expect(config.file.signUp.enabled).toBe(false)
    expect(config.file.signUp.requireApproval).toBe(true)
    expect(config.file.jwt.algorithm).toBe("ES256")
    expect(config.defaultRole).toBe("user")
    expect(config.adminRoles).toEqual(["admin"])
    expect(config.trustedOrigins).toEqual(["http://localhost:3000"])
    // No e-mail transport ⇒ degraded mode (FR-MAIL-2).
    expect(config.emailEnabled).toBe(false)
    expect(config.requireEmailVerification).toBe(false)
    expect(warnings.map((w) => w.code)).toContain("email.degraded")
  })

  it("falls back to the built-in role catalog when roles.json is absent", () => {
    const { config } = load({ roles: null })
    expect(config.roles.map((role) => role.name)).toEqual(["admin", "user"])
    expect(config.defaultRole).toBe("user")
  })

  it("loads no clients when oauth_clients.json is absent", () => {
    expect(load({ clients: null }).config.clients).toEqual([])
  })

  it("reports a missing config.json rather than crashing", () => {
    const folder = makeConfigFolder()
    expect(() =>
      loadConfig({ dir: "/elsewhere", env: {}, readFile: folder.readFile })
    ).toThrow(/Required file not found/)
  })

  it("reports every problem in one pass (CFG-5)", () => {
    const issues = expectIssues({
      config: {
        ...baseConfig(),
        secret: "short",
        site: {},
        unknownTopLevel: 1,
      },
    })
    const messages = issues.map((issue) => issue.message).join("\n")
    expect(issues.length).toBeGreaterThan(1)
    expect(messages).toContain("Unknown key")
    expect(issues.some((issue) => issue.pointer === "/site/name")).toBe(true)
  })

  it("rejects unknown keys with a pointer", () => {
    const issues = expectIssues({
      config: {
        ...baseConfig(),
        session: { expiresIn: "7d", slidingWindow: true },
      },
    })
    const issue = issues.find((candidate) => candidate.pointer === "/session")
    expect(issue?.message).toContain("`slidingWindow`")
  })

  it("honours the $schema key without complaining about it", () => {
    const { config } = load({
      config: { $schema: "./config.schema.json", ...baseConfig() },
    })
    expect(config.file.site.name).toBe("Test IdP")
  })

  describe("CFG-3 precedence", () => {
    it("uses a fallback env var only when the key is absent from the file", () => {
      const withoutSecret = { ...baseConfig() }
      delete (withoutSecret as Record<string, unknown>).secret
      const { config } = load(
        { config: withoutSecret },
        { BETTER_AUTH_SECRET: VALID_SECRET }
      )
      expect(config.file.secret).toBe(VALID_SECRET)
    })

    it("does not let the env override a value present in the file", () => {
      const { config } = load(
        {},
        { BETTER_AUTH_SECRET: "env-secret-that-should-not-win-0000000" }
      )
      expect(config.file.secret).toBe(VALID_SECRET)
    })

    it("falls back to DATABASE_URL and BETTER_AUTH_URL", () => {
      const stripped = { ...baseConfig(), database: {}, server: {} }
      const { config } = load(
        { config: stripped },
        {
          DATABASE_URL: "postgres://x@db/idp",
          BETTER_AUTH_URL: "http://localhost:3000",
        }
      )
      expect(config.file.database.url).toBe("postgres://x@db/idp")
      expect(config.file.server.baseUrl).toBe("http://localhost:3000")
    })

    it("falls back to the env-only bootstrap variables", () => {
      const { config } = load(
        {},
        {
          PORT: "4000",
          HOST: "127.0.0.1",
          LOG_LEVEL: "debug",
          LOG_FORMAT: "pretty",
        }
      )
      expect(config.file.server.port).toBe(4000)
      expect(config.file.server.host).toBe("127.0.0.1")
      expect(config.file.logging.level).toBe("debug")
      expect(config.file.logging.format).toBe("pretty")
    })
  })

  describe("placeholder coercion to the schema type", () => {
    it("coerces booleans, integers, arrays and durations", () => {
      const config = {
        ...baseConfig(),
        server: { baseUrl: "http://localhost:3000", port: "${env:IDP_PORT}" },
        signUp: {
          enabled: "${env:IDP_SIGNUP}",
          allowedEmailDomains: "${env:IDP_DOMAINS}",
        },
        session: { expiresIn: "${env:IDP_SESSION}" },
      }
      const { config: loaded } = load(
        { config },
        {
          IDP_PORT: "8080",
          IDP_SIGNUP: "true",
          IDP_DOMAINS: '["example.com"]',
          IDP_SESSION: "2d",
        }
      )
      expect(loaded.file.server.port).toBe(8080)
      expect(loaded.file.signUp.enabled).toBe(true)
      expect(loaded.file.signUp.allowedEmailDomains).toEqual(["example.com"])
      expect(loaded.file.session.expiresIn).toBe(172_800)
    })
  })

  describe("clients", () => {
    it("accepts a valid confidential and public client", () => {
      const { config } = load({
        clients: { clients: [webClient(), spaClient()] },
      })
      expect(config.clients.map((client) => client.clientId)).toEqual([
        "web-app",
        "spa-app",
      ])
      expect(config.clients[0]!.skipConsent).toBe(true)
      expect(config.clients[1]!.requirePKCE).toBe(true)
    })

    it("seeds the resource registry from jwt.audience, oauth.resources and per-client audiences", () => {
      const { config } = load({
        config: {
          ...baseConfig(),
          oauth: {
            resources: [
              { identifier: "https://api.example.com", accessTokenTtl: "5m" },
            ],
          },
        },
        clients: {
          clients: [webClient({ audience: "https://reports.example.com" })],
        },
      })
      expect(config.resources.map((resource) => resource.identifier)).toEqual([
        "https://api.example.com",
        "http://localhost:3000",
        "https://reports.example.com",
      ])
      expect(config.resources[0]!.accessTokenTtl).toBe(300)
    })
  })
})
