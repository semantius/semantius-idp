/**
 * Query parameters as the router actually delivers them.
 *
 * Every case here was reachable in the shipped app: the router parses each
 * value with `JSON.parse`, so `?forced=1` arrived as the number `1` and
 * `search.forced === "1"` was false — which is why the FR-AUTH-4 forced page
 * rendered the ordinary change-password screen and dropped the `forced` marker
 * from the form it posted.
 */

import { describe, expect, it } from "vitest"

import {
  hrefWithoutParam,
  searchFlag,
  searchString,
} from "@/lib/search-params"

describe("searchString", () => {
  it("passes a string through", () => {
    expect(searchString("invalid_credentials")).toBe("invalid_credentials")
    expect(searchString("")).toBe("")
  })

  it("recovers a value the parser turned into a number or boolean", () => {
    // `?token=12345`, `?sent=1`, `?forced=true`.
    expect(searchString(12345)).toBe("12345")
    expect(searchString(1)).toBe("1")
    expect(searchString(true)).toBe("true")
  })

  it("is undefined for anything absent", () => {
    expect(searchString(undefined)).toBeUndefined()
    expect(searchString(null)).toBeUndefined()
  })

  it("refuses structured values outright", () => {
    // `?returnTo[]=/a` and friends: never something this app asked for, and
    // letting one through would put an object where a path is expected.
    expect(searchString(["/a"])).toBeUndefined()
    expect(searchString({ a: 1 })).toBeUndefined()
  })
})

describe("searchFlag", () => {
  it("accepts both spellings of yes, whatever the parser did to them", () => {
    expect(searchFlag("1")).toBe(true)
    expect(searchFlag(1)).toBe(true)
    expect(searchFlag("true")).toBe(true)
    expect(searchFlag(true)).toBe(true)
  })

  it("is false for no, for zero, and for absent", () => {
    expect(searchFlag("0")).toBe(false)
    expect(searchFlag(0)).toBe(false)
    expect(searchFlag("false")).toBe(false)
    expect(searchFlag(false)).toBe(false)
    expect(searchFlag(undefined)).toBe(false)
  })

  it("is false for a bare parameter with no value", () => {
    // `?forced` parses to an empty string; every link the app emits supplies
    // a value, so a missing one means the URL was edited by hand.
    expect(searchFlag("")).toBe(false)
  })
})

describe("hrefWithoutParam (D71)", () => {
  it("removes the named parameter and leaves the rest of the URL alone", () => {
    expect(
      hrefWithoutParam("http://idp.test/admin/users?notice=created", "notice")
    ).toBe("/admin/users")
  })

  it("keeps every sibling parameter, because each has its own consumer", () => {
    // `error`, `draft` and `created` all travel on these URLs and are claimed
    // by something else; a strip that took the whole query string would spend
    // a one-shot handle the page has not read yet.
    expect(
      hrefWithoutParam(
        "http://idp.test/admin/users?q=ada&notice=created&pageSize=50",
        "notice"
      )
    ).toBe("/admin/users?q=ada&pageSize=50")
    expect(
      hrefWithoutParam(
        "http://idp.test/admin/clients?notice=clientCreated&created=abc123",
        "notice"
      )
    ).toBe("/admin/clients?created=abc123")
  })

  it("strips whichever parameter it is told to", () => {
    // `/admin/system` names its confirmation `rotated`, because it carries the
    // successor key id rather than a code.
    expect(
      hrefWithoutParam("http://idp.test/admin/system?rotated=kid-2", "rotated")
    ).toBe("/admin/system")
  })

  it("returns the input untouched when the parameter is not there", () => {
    // The ordinary case: every page mounts the toast, and almost none of them
    // is showing one. Identity in, identity out — no history entry is
    // rewritten for nothing.
    const href = "http://idp.test/account?error=server_error"
    expect(hrefWithoutParam(href, "notice")).toBe(href)
  })

  it("keeps the path and the fragment", () => {
    expect(
      hrefWithoutParam(
        "http://idp.test/idp/account/security?notice=twofactor_on#backup",
        "notice"
      )
    ).toBe("/idp/account/security#backup")
  })

  it("removes every repetition of the parameter", () => {
    // A hand-edited URL, or a redirect chain that appended twice. Leaving one
    // behind would re-announce the notice on the next paint.
    expect(
      hrefWithoutParam("http://idp.test/account?notice=a&notice=b", "notice")
    ).toBe("/account")
  })
})
