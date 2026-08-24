import { describe, expect, it } from "vitest"

import { deriveConfig } from "@/server/config/derive"
import { configFileSchema } from "@/server/config/schema/config-schema"
import { BUILT_IN_ROLES } from "@/server/config/schema/roles-schema"
import { resolveSignInDestination } from "@/server/http/post-login"
import { baseConfig } from "@/tests/fixtures/config-files"

/**
 * FR-AUTH-1 / D28 — the post-sign-in precedence, as a matrix.
 *
 * The whole reason this lives in its own module is that three call sites have
 * to agree on it (sign-in, the 2FA challenge, and the far end of a forced
 * password change), so the matrix is asserted once, here.
 */

function configWith(overrides: Record<string, unknown> = {}) {
  return deriveConfig(
    configFileSchema.parse({ ...baseConfig(), ...overrides }),
    [],
    BUILT_IN_ROLES
  )
}

const atRoot = (auth: Record<string, unknown> = {}) => configWith({ auth })
const atSubPath = (auth: Record<string, unknown> = {}) =>
  configWith({ server: { baseUrl: "https://apps.example.com/idp" }, auth })

describe("resolveSignInDestination — precedence", () => {
  it("sends an unqualified sign-in to the configured default", () => {
    expect(resolveSignInDestination({ config: atRoot() })).toBe("/account")
  })

  it("prefers a validated returnTo over the default", () => {
    expect(
      resolveSignInDestination({
        config: atRoot({ defaultRedirect: "https://apps.example.com/" }),
        returnTo: "/account/security",
      })
    ).toBe("/account/security")
  })

  it("lets a pending OAuth continuation beat everything", () => {
    expect(
      resolveSignInDestination({
        config: atRoot({ defaultRedirect: "https://apps.example.com/" }),
        returnTo: "/account/security",
        pendingContinuation: "/oauth2/authorize?client_id=web&state=abc",
      })
    ).toBe("/oauth2/authorize?client_id=web&state=abc")
  })
})

describe("resolveSignInDestination — the configured default", () => {
  it("passes an absolute URL through untouched, base path and all", () => {
    // Not prefixed: it is on somebody else's origin, where our mount path
    // means nothing.
    for (const config of [
      atRoot({ defaultRedirect: "https://apps.example.com/" }),
      atSubPath({ defaultRedirect: "https://apps.example.com/" }),
    ]) {
      expect(resolveSignInDestination({ config })).toBe(
        "https://apps.example.com/"
      )
    }
  })

  it("prefixes a relative default with the mount path", () => {
    expect(resolveSignInDestination({ config: atSubPath() })).toBe(
      "/idp/account"
    )
    expect(
      resolveSignInDestination({
        config: atSubPath({ defaultRedirect: "/welcome" }),
      })
    ).toBe("/idp/welcome")
  })

  it("falls back to /account when the key is somehow absent", () => {
    // Unreachable through the schema; asserted so a hand-built config in a
    // later test cannot turn a missing key into a crash.
    const config = atSubPath()
    const withoutKey = {
      ...config,
      file: {
        ...config.file,
        auth: { ...config.file.auth, defaultRedirect: undefined },
      },
    } as unknown as typeof config
    expect(resolveSignInDestination({ config: withoutKey })).toBe("/idp/account")
  })
})

describe("resolveSignInDestination — returnTo stays hostile-input (SEC-3)", () => {
  const config = atSubPath()

  it.each([
    ["https://evil.example/", "absolute"],
    ["//evil.example/", "protocol-relative"],
    ["/\\evil.example/", "backslash-smuggled"],
    ["javascript:alert(1)", "scheme"],
    ["account", "no leading slash"],
    ["", "empty"],
    ["   ", "whitespace"],
  ])("discards %s (%s) and uses the default instead", (returnTo) => {
    expect(resolveSignInDestination({ config, returnTo })).toBe("/idp/account")
  })

  it("keeps a legitimate relative returnTo, query and all", () => {
    expect(
      resolveSignInDestination({ config, returnTo: "/account?tab=sessions" })
    ).toBe("/idp/account?tab=sessions")
  })

  it("treats null and undefined as absent", () => {
    expect(resolveSignInDestination({ config, returnTo: null })).toBe(
      "/idp/account"
    )
    expect(resolveSignInDestination({ config, returnTo: undefined })).toBe(
      "/idp/account"
    )
  })
})
