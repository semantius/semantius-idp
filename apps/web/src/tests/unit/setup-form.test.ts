/**
 * What `/setup` refuses (FR-ADMIN-1, **D54**).
 *
 * The wizard runs exactly once per deployment and closes behind itself, so
 * every one of these refusals is the difference between a working deployment
 * and one that has to be recovered with SQL.
 */

import { describe, expect, it } from "vitest"

import { validateSetupForm } from "@/server/admin/setup-form"

const POLICY = { minLength: 10, maxLength: 128 }

const GOOD = {
  email: "First.Admin@Example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  password: "a-perfectly-fine-passphrase",
  confirmPassword: "a-perfectly-fine-passphrase",
}

function code(form: Record<string, string | undefined>): string | undefined {
  const result = validateSetupForm(form, POLICY)
  return result.ok ? undefined : result.code
}

describe("validateSetupForm", () => {
  it("accepts a complete form and lower-cases the address", () => {
    const result = validateSetupForm(GOOD, POLICY)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.values.email).toBe("first.admin@example.com")
    expect(result.values.firstName).toBe("Ada")
  })

  it("rejects an address that is not one", () => {
    expect(code({ ...GOOD, email: "not-an-address" })).toBe("invalid_email")
  })

  it("trims the address before judging its shape", () => {
    // A pasted address arrives with a space more often than not, and the shape
    // check rejects any whitespace — so untrimmed this reads as malformed.
    const result = validateSetupForm(
      { ...GOOD, email: "  Ada@Example.com  " },
      POLICY
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.values.email).toBe("ada@example.com")
  })

  it("requires both names, whitespace not counting as one", () => {
    expect(code({ ...GOOD, firstName: "" })).toBe("missing_name")
    expect(code({ ...GOOD, lastName: "   " })).toBe("missing_name")
    expect(code({ ...GOOD, firstName: undefined })).toBe("missing_name")
  })

  it("trims the names it does accept", () => {
    const result = validateSetupForm(
      { ...GOOD, firstName: "  Ada  ", lastName: " Lovelace " },
      POLICY
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.values).toMatchObject({
      firstName: "Ada",
      lastName: "Lovelace",
    })
  })

  it("holds the configured length policy at both ends", () => {
    expect(code({ ...GOOD, password: "short", confirmPassword: "short" })).toBe(
      "password_length"
    )
    const long = "x".repeat(POLICY.maxLength + 1)
    expect(code({ ...GOOD, password: long, confirmPassword: long })).toBe(
      "password_length"
    )
  })

  it("rejects a password that was not repeated correctly", () => {
    expect(code({ ...GOOD, confirmPassword: "something-else-entirely" })).toBe(
      "password_mismatch"
    )
    // Missing entirely is the same answer: a form posted by a script that
    // predates D54 must not create an account whose password nobody confirmed.
    expect(code({ ...GOOD, confirmPassword: undefined })).toBe(
      "password_mismatch"
    )
  })

  it("checks the length before the repeat, so the hint is the useful one", () => {
    // Both are wrong here. Telling someone their two short passwords do not
    // match sends them to fix the wrong thing.
    expect(code({ ...GOOD, password: "short", confirmPassword: "nope" })).toBe(
      "password_length"
    )
  })
})
