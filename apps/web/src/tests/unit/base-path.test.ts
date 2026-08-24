import { describe, expect, it } from "vitest"

import { parseBasePath } from "@/server/config/derive"
import { AUTH_BASE_PATH, createBasePaths } from "@/server/oidc/base-path"

/**
 * OPS-10 / SEC-1 — every path and absolute URL comes from `server.baseUrl`.
 *
 * The sub-path case is the one that breaks quietly: at the host root a missing
 * prefix is invisible, and behind Caddy at `/idp` the same code 404s. So each
 * assertion is made twice, once per mount.
 */
const root = createBasePaths(parseBasePath("http://localhost:3000"))
const subPath = createBasePaths(parseBasePath("https://apps.example.com/idp"))

describe("createBasePaths", () => {
  it("derives the issuer byte-for-byte from baseUrl", () => {
    expect(root.issuer).toBe("http://localhost:3000")
    expect(subPath.issuer).toBe("https://apps.example.com/idp")
  })

  it("prefixes an app-relative path with the mount", () => {
    expect(root.path("/login")).toBe("/login")
    expect(subPath.path("/login")).toBe("/idp/login")
  })

  it("resolves the mount itself for an empty or bare-slash path", () => {
    // `/idp` and not `/idp/`: the issuer has no trailing slash, and neither
    // may anything derived from it.
    expect(root.path("")).toBe("/")
    expect(root.path("/")).toBe("/")
    expect(subPath.path("")).toBe("/idp")
    expect(subPath.path("/")).toBe("/idp")
  })

  it("tolerates a path written without its leading slash", () => {
    expect(root.path("login")).toBe("/login")
    expect(subPath.path("login")).toBe("/idp/login")
  })

  it("builds absolute URLs on the issuer's own origin", () => {
    expect(root.url("/login")).toBe("http://localhost:3000/login")
    expect(subPath.url("/login")).toBe("https://apps.example.com/idp/login")
  })

  it("scopes cookies to the mount and secures them by the issuer scheme", () => {
    expect(root.cookiePath).toBe("/")
    expect(root.secureCookies).toBe(false)
    expect(subPath.cookiePath).toBe("/idp")
    // https issuer means Secure cookies whatever the internal scheme is.
    expect(subPath.secureCookies).toBe(true)
  })

  it("puts Better Auth's own mount under the same prefix", () => {
    expect(root.authBasePath).toBe(AUTH_BASE_PATH)
    expect(root.authBaseUrl).toBe(`http://localhost:3000${AUTH_BASE_PATH}`)
    expect(subPath.authBasePath).toBe(`/idp${AUTH_BASE_PATH}`)
    expect(subPath.authBaseUrl).toBe(
      `https://apps.example.com/idp${AUTH_BASE_PATH}`
    )
  })
})
