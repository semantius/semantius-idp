/**
 * What configuration turns into for a social provider (FR-SOC-1/3/4).
 *
 * The interesting parts are the two that were silently wrong: `syncProfile`
 * had no effect at all because nothing mapped it onto Better Auth's
 * `overrideUserInfoOnSignIn`, and the per-provider domain list existed in the
 * schema with nothing reading it.
 */

import { describe, expect, it } from "vitest"

import { deriveConfig } from "@/server/config/derive"
import type { IdpConfig } from "@/server/config/derive"
import { configFileSchema } from "@/server/config/schema/config-schema"
import { BUILT_IN_ROLES } from "@/server/config/schema/roles-schema"
import { buildSocialProviders } from "@/server/auth/options/social"
import { isSocialEmailAllowed } from "@/server/auth/options/social-sync"

function configWith(overrides: Record<string, unknown>): IdpConfig {
  const file = configFileSchema.parse({
    server: { baseUrl: "http://localhost:3000" },
    secret: "0123456789abcdef0123456789abcdef0123456789",
    database: { url: "postgres://idp:idp@localhost:5432/idp" },
    site: { name: "Test IdP" },
    jwt: { audience: "http://localhost:3000" },
    ...overrides,
  })
  return deriveConfig(file, [], BUILT_IN_ROLES)
}

const GOOGLE = {
  enabled: true,
  clientId: "client",
  clientSecret: "secret",
}

describe("buildSocialProviders", () => {
  it("registers nothing when no provider is configured (FR-SOC-1)", () => {
    expect(buildSocialProviders(configWith({}))).toBeUndefined()
  })

  it("maps syncProfile onto overrideUserInfoOnSignIn (FR-SOC-4)", () => {
    const on = buildSocialProviders(
      configWith({ social: { google: { ...GOOGLE, syncProfile: true } } })
    )
    expect(on?.google?.overrideUserInfoOnSignIn).toBe(true)

    const off = buildSocialProviders(
      configWith({ social: { google: { ...GOOGLE, syncProfile: false } } })
    )
    expect(off?.google?.overrideUserInfoOnSignIn).toBe(false)
  })

  it("keeps the IdP's own knobs out of the provider options", () => {
    const providers = buildSocialProviders(
      configWith({
        social: {
          google: {
            ...GOOGLE,
            allowedEmailDomains: ["example.com"],
            prompt: "consent",
          },
        },
      })
    )
    // `enabled`, `syncProfile` and `allowedEmailDomains` are ours; anything
    // else the operator wrote belongs to the provider (FR-SOC-1).
    expect(providers?.google).not.toHaveProperty("enabled")
    expect(providers?.google).not.toHaveProperty("allowedEmailDomains")
    expect(providers?.google?.prompt).toBe("consent")
  })

  it("refuses implicit registration when sign-up is off (FR-SIGNUP-1)", () => {
    const closed = buildSocialProviders(
      configWith({
        signUp: { enabled: false },
        social: { google: GOOGLE },
      })
    )
    expect(closed?.google?.disableImplicitSignUp).toBe(true)

    const open = buildSocialProviders(
      configWith({ signUp: { enabled: true }, social: { google: GOOGLE } })
    )
    expect(open?.google).not.toHaveProperty("disableImplicitSignUp")
  })
})

describe("isSocialEmailAllowed", () => {
  const provider = (allowedEmailDomains: string[]) =>
    ({ allowedEmailDomains }) as never

  it("allows anything when neither list is set", () => {
    const config = configWith({})
    expect(isSocialEmailAllowed(config, provider([]), "a@anywhere.test")).toBe(
      true
    )
  })

  it("applies the global sign-up list (FR-SIGNUP-3)", () => {
    const config = configWith({
      signUp: { allowedEmailDomains: ["example.com"] },
    })
    expect(isSocialEmailAllowed(config, provider([]), "a@example.com")).toBe(
      true
    )
    expect(isSocialEmailAllowed(config, provider([]), "a@other.test")).toBe(
      false
    )
  })

  it("narrows further per provider, never widens (FR-SOC-3)", () => {
    const config = configWith({
      signUp: { allowedEmailDomains: ["example.com", "partner.test"] },
    })
    // The provider list is an additional gate, so an address the global list
    // allows can still be refused here...
    expect(
      isSocialEmailAllowed(config, provider(["example.com"]), "a@partner.test")
    ).toBe(false)
    // ...and one the global list refuses is not rescued by naming it.
    expect(
      isSocialEmailAllowed(config, provider(["outside.test"]), "a@outside.test")
    ).toBe(false)
    expect(
      isSocialEmailAllowed(config, provider(["example.com"]), "a@example.com")
    ).toBe(true)
  })

  it("matches the domain case-insensitively and only after the last @", () => {
    const config = configWith({})
    expect(
      isSocialEmailAllowed(config, provider(["Example.COM"]), "a@example.com")
    ).toBe(true)
    // An address that merely *contains* an allowed domain is not in it.
    expect(
      isSocialEmailAllowed(
        config,
        provider(["example.com"]),
        "example.com@evil.test"
      )
    ).toBe(false)
  })

  it("treats a missing provider entry as no extra restriction", () => {
    const config = configWith({})
    expect(isSocialEmailAllowed(config, undefined, "a@anywhere.test")).toBe(
      true
    )
  })
})
