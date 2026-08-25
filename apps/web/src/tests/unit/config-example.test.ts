import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { loadConfig } from "@/server/config/loader"

const EXAMPLE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "..",
  "config.example"
)

/**
 * The shipped `config.example/` folder is documentation that has to keep
 * working: DOC-1's quick start copies it. Loading it here means a renamed or
 * removed key breaks the build rather than a first-time operator's evening.
 */
describe("config.example/", () => {
  const env = {
    IDP_BASE_URL: "https://apps.example.com/idp",
    IDP_ORIGIN: "https://apps.example.com",
    IDP_SECRET: "0123456789abcdef0123456789abcdef0123456789",
    DATABASE_URL: "postgres://idp:idp@db:5432/idp",
    RESEND_API_KEY: "re_example",
    EXAMPLE_WEB_CLIENT_SECRET: "w".repeat(40),
    EXAMPLE_FIRSTPARTY_CLIENT_SECRET: "f".repeat(40),
  }

  it("validates as a production deployment", () => {
    const { config, warnings } = loadConfig({
      dir: EXAMPLE_DIR,
      env,
      readFile: (path) => readFileSync(path, "utf8"),
    })

    expect(config.file.site.name).toBe("Example IdP")
    expect(config.isProduction).toBe(true)
    expect(config.emailEnabled).toBe(true)
    expect(config.clients.map((client) => client.clientId)).toEqual([
      "example-web",
      "example-spa",
      "example-mobile",
      "example-firstparty",
    ])
    expect(config.roles.map((role) => role.name)).toEqual(["admin", "user"])
    expect(config.defaultRole).toBe("user")
    // No literal-secret complaints: every secret in the example comes from a
    // placeholder. And no administrator warning either — there is nothing to
    // configure any more (D52).
    expect(warnings.map((warning) => warning.code)).toEqual([])
  })

  it("exercises the sub-path deployment shape (OPS-10)", () => {
    const { config } = loadConfig({
      dir: EXAMPLE_DIR,
      env,
      readFile: (path) => readFileSync(path, "utf8"),
    })
    expect(config.base).toEqual({
      origin: "https://apps.example.com",
      basePath: "/idp",
      cookiePath: "/idp",
      secure: true,
    })
    const firstParty = config.clients.find((client) => client.firstParty)!
    expect(firstParty.redirectUris).toEqual([
      "https://apps.example.com/dashboard/callback",
    ])
  })

  it("still validates with only the variables that have no default set", () => {
    const minimal = {
      IDP_SECRET: env.IDP_SECRET,
      DATABASE_URL: env.DATABASE_URL,
      EXAMPLE_WEB_CLIENT_SECRET: env.EXAMPLE_WEB_CLIENT_SECRET,
      EXAMPLE_FIRSTPARTY_CLIENT_SECRET: env.EXAMPLE_FIRSTPARTY_CLIENT_SECRET,
    }
    const { config, warnings } = loadConfig({
      dir: EXAMPLE_DIR,
      env: minimal,
      readFile: (path) => readFileSync(path, "utf8"),
    })
    // Falls back to the http://localhost:3000 default, so it is not production
    // and the literal-secret rule does not apply.
    expect(config.base.origin).toBe("http://localhost:3000")
    expect(config.emailEnabled).toBe(false)
    // Only the degraded-mail one. A deployment with no users is not
    // misconfigured, so there is no bootstrap warning any more (D52).
    expect(warnings.map((warning) => warning.code).sort()).toEqual([
      "email.degraded",
    ])
  })

  it("fails loudly when a required secret is missing", () => {
    expect(() =>
      loadConfig({
        dir: EXAMPLE_DIR,
        env: {},
        readFile: (path) => readFileSync(path, "utf8"),
      })
    ).toThrow(/IDP_SECRET/)
  })
})
