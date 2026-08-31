import { describe, expect, it } from "vitest"

import {
  checkRedirectUri,
  isValidClientId,
  skipConsentFromForm,
  uriLines,
  validateClientForm,
} from "@/lib/client-rules"
import type { ClientFormValues } from "@/lib/client-rules"

/**
 * The rules `/admin/clients` and `oauth_clients.jsonc` both apply (**D62**).
 *
 * `config-clients.test.ts` asserts the schema's behavior through zod; this
 * asserts the shared decision underneath both, which is the thing that must
 * not drift — a form that accepted something the schema refuses is a
 * guaranteed rejection with the dialog closed and the fields emptied, which is
 * exactly the finding this module exists to close.
 */
describe("redirect URI rules", () => {
  it("accepts https anywhere", () => {
    expect(checkRedirectUri("https://app.example.com/cb", "spa")).toBeUndefined()
  })

  it("accepts plain http only on loopback", () => {
    expect(checkRedirectUri("http://localhost:3000/cb", "spa")).toBeUndefined()
    expect(checkRedirectUri("http://127.0.0.1:3000/cb", "spa")).toBeUndefined()
    expect(checkRedirectUri("http://app.example.com/cb", "spa")).toBe(
      "http_not_loopback"
    )
  })

  it("refuses wildcards, fragments and relative URIs", () => {
    expect(checkRedirectUri("https://*.example.com/cb", "spa")).toBe("wildcard")
    expect(checkRedirectUri("https://app.example.com/cb#x", "spa")).toBe(
      "fragment"
    )
    // `URL` drops an empty trailing fragment, so the raw string is checked too.
    expect(checkRedirectUri("https://app.example.com/cb#", "spa")).toBe(
      "fragment"
    )
    expect(checkRedirectUri("/callback", "spa")).toBe("not_absolute")
  })

  it("allows a private-use scheme only for a native client", () => {
    expect(
      checkRedirectUri("com.example.app:/callback", "native")
    ).toBeUndefined()
    expect(checkRedirectUri("com.example.app:/callback", "spa")).toBe(
      "private_scheme"
    )
  })

  it("accepts {host} as the whole host of an https URI", () => {
    expect(
      checkRedirectUri("https://{host}/oauth2_callback", "spa")
    ).toBeUndefined()
    expect(checkRedirectUri("https://{host}", "spa")).toBeUndefined()
  })

  it("refuses {host} anywhere but the whole-host position, exactly once", () => {
    // Part of a host, a path segment, a userinfo block, twice, its own port.
    expect(checkRedirectUri("https://{host}.example.com/cb", "spa")).toBe(
      "host_template"
    )
    expect(checkRedirectUri("https://evil.example/{host}", "spa")).toBe(
      "host_template"
    )
    expect(checkRedirectUri("https://user@{host}/cb", "spa")).toBe(
      "host_template"
    )
    expect(checkRedirectUri("https://{host}/x/{host}", "spa")).toBe(
      "host_template"
    )
    expect(checkRedirectUri("https://{host}:8443/cb", "spa")).toBe(
      "host_template"
    )
  })

  it("keeps refusing a wildcard beside a template — {host} is not one", () => {
    expect(checkRedirectUri("https://{host}/cb/*", "spa")).toBe("wildcard")
  })

  it("keeps a templated URI on https", () => {
    expect(checkRedirectUri("http://{host}/cb", "spa")).toBe(
      "http_not_loopback"
    )
  })
})

describe("clientId", () => {
  it("accepts letters, digits and `. _ ~ -`", () => {
    expect(isValidClientId("example-web_2.0~x")).toBe(true)
  })

  it("refuses empty, spaced and over-long ids", () => {
    expect(isValidClientId("")).toBe(false)
    expect(isValidClientId("has space")).toBe(false)
    expect(isValidClientId("a".repeat(129))).toBe(false)
    // **D93**: legal characters, unusable as a path segment. The id is part
    // of the row's own address (`/admin/clients/<id>/edit`) and a browser
    // resolves `..` away before the request leaves it.
    expect(isValidClientId(".")).toBe(false)
    expect(isValidClientId("..")).toBe(false)
    // …and dots in general are still fine: this is two exact values, not a
    // rule about dots. `com.example.app` is an ordinary client id.
    expect(isValidClientId("com.example.app")).toBe(true)
    expect(isValidClientId("...")).toBe(true)
  })
})

describe("uriLines", () => {
  it("splits, trims and drops blanks", () => {
    expect(uriLines("  a \r\n\n b\n")).toEqual(["a", "b"])
  })
})

describe("validateClientForm", () => {
  const values = (over: Partial<ClientFormValues> = {}): ClientFormValues => ({
    clientId: "example-web",
    name: "Example",
    type: "spa",
    redirectUris: "https://app.example.com/cb",
    postLogoutRedirectUris: "",
    enableEndSession: false,
    ...over,
  })

  it("passes a well-formed registration", () => {
    expect(validateClientForm(values())).toEqual({})
  })

  it("requires at least one redirect URI", () => {
    expect(validateClientForm(values({ redirectUris: "  \n" }))).toEqual({
      redirectUris: "required",
    })
  })

  it("names the offending URI in the code", () => {
    expect(
      validateClientForm(values({ redirectUris: "https://a/*" })).redirectUris
    ).toBe("uri:wildcard:https://a/*")
  })

  it("refuses end-session with no post-logout URI", () => {
    expect(
      validateClientForm(values({ enableEndSession: true }))
        .postLogoutRedirectUris
    ).toBe("endSessionNeedsUri")
  })

  it("judges a private-use scheme by the selected type", () => {
    const uri = "com.example.app:/cb"
    expect(validateClientForm(values({ redirectUris: uri })).redirectUris).toBe(
      `uri:private_scheme:${uri}`
    )
    expect(
      validateClientForm(values({ redirectUris: uri, type: "native" }))
        .redirectUris
    ).toBeUndefined()
  })

  it("falls back to the strictest type when the select carries nonsense", () => {
    // A hand-crafted POST, or a `<select>` somebody edited. `spa` is the
    // stricter reading, so nothing is waved through by mistyping the type.
    expect(
      validateClientForm(
        values({ type: "service", redirectUris: "com.example.app:/cb" })
      ).redirectUris
    ).toBe("uri:private_scheme:com.example.app:/cb")
  })
})

/**
 * The one inversion in the codebase, pinned (round 3, finding 10).
 *
 * The form asks "Require consent" and the wire field is `skipConsent`, which
 * is a triple negative waiting to happen — so it is one function with a test
 * on it rather than a `!` somewhere in a handler. Getting it backwards would
 * make every application registered here ask for consent, or none of them,
 * and nothing else would notice.
 */
describe("skipConsentFromForm", () => {
  it("ticked means the user is asked", () => {
    expect(skipConsentFromForm("on")).toBe(false)
  })

  it("absent means the user is not asked, which is FR-OIDC-3's default", () => {
    // A checkbox sends nothing at all when it is unticked, so `undefined` is
    // the ordinary case rather than an edge one.
    expect(skipConsentFromForm(undefined)).toBe(true)
    expect(skipConsentFromForm("")).toBe(true)
  })
})
