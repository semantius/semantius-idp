import { describe, expect, it } from "vitest"

import {
  checkRedirectUri,
  isValidClientId,
  uriLines,
  validateClientForm,
} from "@/lib/client-rules"
import type { ClientFormValues } from "@/lib/client-rules"

/**
 * The rules `/admin/clients` and `oauth_clients.jsonc` both apply (**D62**).
 *
 * `config-clients.test.ts` asserts the schema's behaviour through zod; this
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
})

describe("clientId", () => {
  it("accepts letters, digits and `. _ ~ -`", () => {
    expect(isValidClientId("example-web_2.0~x")).toBe(true)
  })

  it("refuses empty, spaced and over-long ids", () => {
    expect(isValidClientId("")).toBe(false)
    expect(isValidClientId("has space")).toBe(false)
    expect(isValidClientId("a".repeat(129))).toBe(false)
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
