import { describe, expect, it } from "vitest"

import { displayName } from "@/server/display-name"

/**
 * The derived display name (FR-SIGNUP-5, **D49**).
 *
 * A four-line function with six callers — sign-up, first-run setup, admin
 * create, admin edit, the account page and the social profile mapping — which
 * is exactly why it is worth pinning here rather than in six places. The cases
 * that matter are the ones with a part missing: "Smith, " with nothing after
 * the comma is worse than "Smith", and a blank name renders as an empty cell
 * in every admin table.
 */
describe("displayName (D49)", () => {
  it("composes both parts in the configured order", () => {
    expect(displayName("Jane", "Smith", "first-last")).toBe("Jane Smith")
    expect(displayName("Jane", "Smith", "last-first")).toBe("Smith, Jane")
  })

  it("defaults to first-last", () => {
    expect(displayName("Jane", "Smith")).toBe("Jane Smith")
  })

  it("collapses rather than leaving punctuation behind", () => {
    for (const format of ["first-last", "last-first"] as const) {
      expect(displayName("Jane", "", format), format).toBe("Jane")
      expect(displayName("", "Smith", format), format).toBe("Smith")
    }
  })

  it("trims, so a stray space does not become a name", () => {
    expect(displayName("  Jane ", "  Smith  ")).toBe("Jane Smith")
    expect(displayName("Jane", "   ")).toBe("Jane")
  })

  it("answers empty when there is nothing to compose, and lets the caller decide", () => {
    // Every caller falls back to the e-mail address: it is the one thing an
    // account is guaranteed to have, and a blank cell is not an answer.
    expect(displayName("", "")).toBe("")
    expect(displayName(null, undefined)).toBe("")
  })
})
