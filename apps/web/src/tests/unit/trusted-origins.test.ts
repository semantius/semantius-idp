/**
 * What `server.trustedOrigins` turns into (SEC-3, **D68**).
 *
 * The key has two shapes and the difference is a security posture, so both are
 * asserted here rather than left to the e2e suite: configured means *only*
 * what is configured, and unconfigured means the address the request arrived
 * on — never the other way round.
 */

import { describe, expect, it } from "vitest"

import { createAuthOptions } from "@/server/auth/instance"
import { deriveConfig } from "@/server/config/derive"
import type { IdpConfig } from "@/server/config/derive"
import { configFileSchema } from "@/server/config/schema/config-schema"
import { BUILT_IN_ROLES } from "@/server/config/schema/roles-schema"

function configWith(server: Record<string, unknown>): IdpConfig {
  const file = configFileSchema.parse({
    server: { baseUrl: "http://localhost:3000", ...server },
    secret: "0123456789abcdef0123456789abcdef0123456789",
    database: { url: "postgres://idp:idp@localhost:5432/idp" },
    site: { name: "Test IdP" },
    jwt: { audience: "http://localhost:3000" },
  })
  return deriveConfig(file, [], BUILT_IN_ROLES)
}

/** What Better Auth would be handed for a request from behind a proxy. */
function originsFor(config: IdpConfig): readonly string[] {
  const option = createAuthOptions({ config, forSchema: true }).trustedOrigins
  if (typeof option !== "function") return option ?? []
  const result = option(
    new Request("http://internal.svc:3000/api/auth/sign-in/email", {
      method: "POST",
      headers: { host: "idp.example.com" },
    })
  )
  // The signature allows a promise; this one never returns one, and a test
  // that awaited it would hide the day it started to.
  expect(result).toBeInstanceOf(Array)
  return result as string[]
}

describe("server.trustedOrigins", () => {
  it("follows the request when nothing is configured", () => {
    const config = configWith({})
    expect(config.trustRequestOrigin).toBe(true)
    expect(originsFor(config)).toEqual([
      "http://localhost:3000",
      "https://idp.example.com",
      "http://idp.example.com",
    ])
  })

  it("treats an empty list as nothing configured", () => {
    // `[]` is what a generated or templated config leaves behind. Reading it
    // as "trust the issuer alone" would be a stricter rule than the operator
    // could have meant to write.
    expect(configWith({ trustedOrigins: [] }).trustRequestOrigin).toBe(true)
  })

  it("pins the check to what it lists, plus the issuer", () => {
    const config = configWith({
      trustedOrigins: ["https://apps.example.com"],
    })
    expect(config.trustRequestOrigin).toBe(false)
    // A static list: the request's own host is not consulted at all, which is
    // the whole point of having configured one.
    expect(originsFor(config)).toEqual([
      "http://localhost:3000",
      "https://apps.example.com",
    ])
  })

  it("accepts the wildcard patterns Better Auth matches", () => {
    // `*` is the documented way to turn the check off; the subdomain form is
    // Better Auth's own pattern syntax and `URL` parses it, so it needs no
    // special case beyond not being rejected.
    expect(originsFor(configWith({ trustedOrigins: ["*"] }))).toEqual([
      "http://localhost:3000",
      "*",
    ])
    expect(
      originsFor(configWith({ trustedOrigins: ["https://*.example.com"] }))
    ).toEqual(["http://localhost:3000", "https://*.example.com"])
  })

  it("rejects an entry that is neither a URL nor a pattern", () => {
    expect(() => configWith({ trustedOrigins: ["apps.example.com"] })).toThrow(
      /not an absolute URL/
    )
  })
})
