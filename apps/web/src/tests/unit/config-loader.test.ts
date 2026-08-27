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

  it("reports a missing config file rather than crashing", () => {
    const folder = makeConfigFolder()
    expect(() =>
      loadConfig({ dir: "/elsewhere", env: {}, readFile: folder.readFile })
    ).toThrow(/Required file not found/)
  })

  /**
   * D60: `.jsonc` is the canonical spelling and `.json` is still read. Every
   * other test in this file writes `.json`, so the fallback is covered by all
   * of them; what needs its own coverage is the preferred spelling, the
   * refusal when both are there, and the fact that a message names the file
   * the operator can actually open.
   */
  describe("file resolution (D60)", () => {
    it("reads the .jsonc spelling", () => {
      const { config } = load({ extension: "jsonc" })
      expect(config.file.site.name).toBe("Test IdP")
      expect(config.roles.map((role) => role.name)).toEqual(["admin", "user"])
    })

    it("refuses a folder holding both spellings of the same file", () => {
      const jsonc = makeConfigFolder({ extension: "jsonc" })
      const json = makeConfigFolder()
      const files = { ...jsonc.files, ...json.files }
      const issues = (() => {
        try {
          loadConfig({
            dir: "/config",
            env: {},
            readFile: (path: string) => {
              const content = files[path.replace(/\\/g, "/")]
              if (content === undefined) throw new Error(`ENOENT: ${path}`)
              return content
            },
          })
        } catch (error) {
          if (error instanceof ConfigError) return error.issues
          throw error
        }
        throw new Error("expected loadConfig to throw a ConfigError")
      })()
      const message = issues.map((issue) => issue.message).join("\n")
      expect(message).toContain("config.jsonc")
      expect(message).toContain("config.json")
      // All three files are ambiguous, and CFG-5 reports them together.
      expect(issues).toHaveLength(3)
    })

    it("names the canonical spelling when the required file is absent", () => {
      const folder = makeConfigFolder()
      try {
        loadConfig({ dir: "/elsewhere", env: {}, readFile: folder.readFile })
      } catch (error) {
        // The path separator is the platform's, so match on the name alone.
        expect((error as Error).message).toContain("elsewhere")
        expect((error as Error).message).toContain("config.jsonc")
        expect((error as Error).message).toContain("config.json is read too")
        return
      }
      throw new Error("expected loadConfig to throw")
    })

    it("formats issues against the name the file was read under", () => {
      const broken = { ...baseConfig(), site: {} }
      const jsonc = makeConfigFolder({ config: broken, extension: "jsonc" })
      const json = makeConfigFolder({ config: broken })
      const message = (folder: typeof jsonc) => {
        try {
          loadConfig({ dir: "/config", env: {}, readFile: folder.readFile })
        } catch (error) {
          return (error as Error).message
        }
        throw new Error("expected loadConfig to throw")
      }
      expect(message(jsonc)).toContain("config.jsonc/site/name")
      expect(message(json)).toContain("config.json/site/name")
    })
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

    // D74. Before it, `database.url` was the required key and an operator
    // holding only the direct endpoint — the one that must work, the one every
    // lock-taking step needs — was refused for a configuration that is
    // perfectly serviceable.
    describe("the two connection strings (D74)", () => {
      it("accepts directUrl alone and uses it for regular access too", () => {
        const stripped = {
          ...baseConfig(),
          database: { directUrl: "postgres://admin@db/idp" },
        }
        const { config } = load({ config: stripped })
        expect(config.databaseDirectUrl).toBe("postgres://admin@db/idp")
        expect(config.databaseUrl).toBe("postgres://admin@db/idp")
      })

      it("accepts DATABASE_URL_ADMIN alone, with no DATABASE_URL", () => {
        const stripped = { ...baseConfig(), database: {} }
        const { config } = load(
          { config: stripped },
          { DATABASE_URL_ADMIN: "postgres://admin@db/idp" }
        )
        expect(config.databaseUrl).toBe("postgres://admin@db/idp")
        expect(config.databaseDirectUrl).toBe("postgres://admin@db/idp")
      })

      it("accepts url alone and uses it for lock-taking steps too", () => {
        const { config } = load()
        expect(config.databaseUrl).toBe(config.databaseDirectUrl)
      })

      it("keeps the two apart when both are given", () => {
        const stripped = {
          ...baseConfig(),
          database: {
            url: "postgres://app@db-pooler/idp",
            directUrl: "postgres://admin@db/idp",
          },
        }
        const { config } = load({ config: stripped })
        expect(config.databaseUrl).toBe("postgres://app@db-pooler/idp")
        expect(config.databaseDirectUrl).toBe("postgres://admin@db/idp")
      })

      it("refuses a database block with neither", () => {
        const stripped = { ...baseConfig(), database: {} }
        const issues = expectIssues({ config: stripped })
        expect(
          issues.some((issue) => issue.message.includes("at least one"))
        ).toBe(true)
      })
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
