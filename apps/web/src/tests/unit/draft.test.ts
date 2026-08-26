import { describe, expect, it } from "vitest"

import { draftFields, parseDraft, withDraft } from "@/server/http/draft"

/**
 * The draft carrier (**D62**), asserted without a database.
 *
 * The one guarantee worth a test of its own is the negative: **no password
 * ever reaches the store**. It is a `verification` row, and a mistyped form is
 * not a reason to write a credential into one — so the rule is enforced by the
 * helper rather than by every caller remembering.
 */
describe("draftFields", () => {
  it("keeps ordinary fields", () => {
    expect(
      draftFields({ clientId: "example-web", name: "Example" })
    ).toEqual({ clientId: "example-web", name: "Example" })
  })

  it("never keeps anything password- or secret-shaped", () => {
    expect(
      draftFields({
        email: "someone@example.com",
        password: "hunter2",
        confirmPassword: "hunter2",
        currentPassword: "hunter2",
        newPassword: "hunter2",
        clientSecret: "s".repeat(40),
        token: "t".repeat(40),
      })
    ).toEqual({ email: "someone@example.com" })
  })

  it("flattens a repeated field one per line", () => {
    expect(draftFields({ scopes: ["openid", "profile"] })?.scopes).toBe(
      "openid\nprofile"
    )
  })

  it("answers undefined when nothing is left to keep", () => {
    expect(draftFields({ password: "hunter2", name: "" })).toBeUndefined()
    expect(draftFields({})).toBeUndefined()
  })

  it("refuses a form larger than the cap", () => {
    expect(draftFields({ notes: "x".repeat(20_000) })).toBeUndefined()
  })
})

describe("parseDraft", () => {
  it("round-trips what draftFields produced", () => {
    const kept = draftFields({ name: "Example", scopes: ["openid"] })!
    expect(parseDraft(JSON.stringify(kept))).toEqual(kept)
  })

  it("answers undefined for anything that is not an object of strings", () => {
    expect(parseDraft("not json")).toBeUndefined()
    expect(parseDraft("[1,2]")).toBeUndefined()
    expect(parseDraft("null")).toBeUndefined()
    // A stray non-string value is dropped rather than failing the whole draft.
    expect(parseDraft('{"a":"x","b":2}')).toEqual({ a: "x" })
  })
})

describe("withDraft", () => {
  it("adds the handle beside an existing query", () => {
    expect(withDraft("/admin/clients?error=x", "h")).toBe(
      "/admin/clients?error=x&draft=h"
    )
  })

  it("leaves the path alone when there is no handle", () => {
    expect(withDraft("/admin/clients", undefined)).toBe("/admin/clients")
  })
})
