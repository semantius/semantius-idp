import { describe, expect, it } from "vitest"

import { parseBasePath } from "@/server/config/derive"
import { getCatalog } from "@/server/i18n"
import { createBasePaths, discoveryUrls } from "@/server/oidc/base-path"

/**
 * The well-known URLs the admin system page lists (**D55**, FR-ADMIN-2).
 *
 * The sub-path shape is the whole reason this exists. Two metadata URLs are
 * correct for an issuer with a path and neither is guessable from the issuer:
 * OpenID Discovery appends its well-known segment, RFC 8414 §3.1 puts it in
 * front of the path. An operator assembling these by hand gets one of them
 * wrong, which is what the card on the page is for.
 */

function urls(baseUrl: string): string[] {
  return discoveryUrls(createBasePaths(parseBasePath(baseUrl))).map(
    (entry) => entry.url
  )
}

describe("discoveryUrls", () => {
  it("lists exactly what a host-root deployment answers on", () => {
    expect(urls("https://idp.example.com")).toEqual([
      "https://idp.example.com/.well-known/openid-configuration",
      "https://idp.example.com/.well-known/oauth-authorization-server",
      "https://idp.example.com/.well-known/jwks.json",
      "https://idp.example.com/.well-known/change-password",
    ])
  })

  it("adds both origin-root forms under a sub-path, and only there", () => {
    const subPath = urls("https://apps.example.com/idp")
    // Each metadata document keeps its issuer-relative form…
    expect(subPath).toContain(
      "https://apps.example.com/idp/.well-known/oauth-authorization-server"
    )
    expect(subPath).toContain(
      "https://apps.example.com/idp/.well-known/openid-configuration"
    )
    // …and gains an origin-root one, with the well-known segment in front of
    // the path. `Caddyfile.subpath` rewrites exactly these two, which is why
    // both are listed: an operator running a different proxy needs the pair,
    // not half of it.
    expect(
      subPath.filter((url) => !url.startsWith("https://apps.example.com/idp/"))
    ).toEqual([
      "https://apps.example.com/.well-known/oauth-authorization-server/idp",
      "https://apps.example.com/.well-known/openid-configuration/idp",
    ])
  })

  it("names security.txt only when there is one", () => {
    const base = createBasePaths(parseBasePath("https://idp.example.com"))
    expect(discoveryUrls(base).map((entry) => entry.key)).not.toContain(
      "securityTxt"
    )
    expect(
      discoveryUrls(base, { securityTxt: true }).map((entry) => entry.key)
    ).toContain("securityTxt")
  })

  it("emits no key the catalog cannot label", () => {
    // The page falls back to the raw key, which is a bad label and a fine
    // outcome; this is what keeps that fallback from being the normal case.
    const labels: Record<string, string> =
      getCatalog("en-US").admin.system.discoveryUrls
    for (const entry of discoveryUrls(
      createBasePaths(parseBasePath("https://apps.example.com/idp")),
      { securityTxt: true }
    )) {
      expect(labels[entry.key], entry.key).toBeTruthy()
    }
  })

  it("carries a key for every entry, because the label is translated", () => {
    for (const entry of discoveryUrls(
      createBasePaths(parseBasePath("https://apps.example.com/idp")),
      { securityTxt: true }
    )) {
      expect(entry.key).not.toBe("")
      expect(entry.url.startsWith("https://")).toBe(true)
    }
  })
})
