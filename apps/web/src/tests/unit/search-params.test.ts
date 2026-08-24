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

import { searchFlag, searchString } from "@/lib/search-params"

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
