/**
 * `server.allowedHosts` under `server.dynamicIssuer`.
 *
 * The flag makes the issuer follow the request host; the list says which hosts
 * are allowed to be followed. A host outside it is not a refusal — the request
 * is answered as the boot issuer, exactly as a request with no usable host is —
 * because the sibling deployment turns the flag on before it knows its host at
 * all, and a boot refusal or a 4xx there would be a regression for it.
 *
 * Every arm of the matcher is exercised here on purpose: `src/server/oidc/**`
 * carries an 85 % branch gate and `request-issuer.test.ts` is deliberately
 * unchanged, so this file is where the new arms are covered.
 */

import { describe, expect, it } from "vitest"

import { parseBasePath } from "@/server/config/derive"
import { hostAllowed, resolveRequestIssuer } from "@/server/oidc/request-issuer"

const on = parseBasePath("https://canonical.example.com/idp", {
  dynamicIssuer: true,
})

function requestWith(host: string): Request {
  return new Request("https://canonical.example.com/idp/x", {
    headers: { host },
  })
}

describe("hostAllowed", () => {
  it("is unrestricted when no list is configured", () => {
    expect(hostAllowed("anything.example", undefined)).toBe(true)
  })

  it("matches an exact host, case-insensitively", () => {
    expect(hostAllowed("idp.example.com", ["idp.example.com"])).toBe(true)
    expect(hostAllowed("IdP.Example.com", ["idp.example.com"])).toBe(true)
    expect(hostAllowed("idp.example.org", ["idp.example.com"])).toBe(false)
  })

  it("matches a *.suffix pattern against subdomains at any depth, never the bare domain", () => {
    expect(hostAllowed("a.example.com", ["*.example.com"])).toBe(true)
    expect(hostAllowed("a.b.example.com", ["*.example.com"])).toBe(true)
    expect(hostAllowed("example.com", ["*.example.com"])).toBe(false)
    // A suffix match is a label boundary, not a string suffix.
    expect(hostAllowed("notexample.com", ["*.example.com"])).toBe(false)
  })

  it("ignores the port unless the entry names one", () => {
    expect(hostAllowed("idp.example.com:8443", ["idp.example.com"])).toBe(true)
    expect(hostAllowed("idp.example.com:8443", ["idp.example.com:8443"])).toBe(
      true
    )
    expect(hostAllowed("idp.example.com:8443", ["idp.example.com:443"])).toBe(
      false
    )
    expect(hostAllowed("idp.example.com", ["idp.example.com:443"])).toBe(false)
    expect(hostAllowed("a.example.com:8443", ["*.example.com"])).toBe(true)
  })

  it("takes the first entry that matches from a mixed list", () => {
    const list = ["idp.example.com", "*.example.net"]
    expect(hostAllowed("idp.example.com", list)).toBe(true)
    expect(hostAllowed("x.example.net", list)).toBe(true)
    expect(hostAllowed("x.example.org", list)).toBe(false)
  })
})

describe("resolveRequestIssuer with allowedHosts", () => {
  it("follows a host on the list", () => {
    expect(
      resolveRequestIssuer(on, requestWith("b.example.com"), {
        trustProxy: true,
        allowedHosts: ["*.example.com"],
      })
    ).toBe("https://b.example.com/idp")
  })

  it("answers with the boot issuer for a host off the list, never a refusal", () => {
    expect(
      resolveRequestIssuer(on, requestWith("evil.example.org"), {
        trustProxy: true,
        allowedHosts: ["*.example.com"],
      })
    ).toBe("https://canonical.example.com/idp")
  })

  it("keeps following every host when no list is configured", () => {
    expect(
      resolveRequestIssuer(on, requestWith("anything.example.org"), {
        trustProxy: true,
      })
    ).toBe("https://anything.example.org/idp")
  })

  it("never consults the list with the flag off", () => {
    const off = parseBasePath("https://canonical.example.com/idp")
    expect(
      resolveRequestIssuer(off, requestWith("b.example.com"), {
        trustProxy: true,
        allowedHosts: ["b.example.com"],
      })
    ).toBe("https://canonical.example.com/idp")
  })
})
