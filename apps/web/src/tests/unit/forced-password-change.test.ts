import { describe, expect, it } from "vitest"

import { endsForcedPasswordChange } from "@/server/auth/options/database-hooks"

/**
 * FR-AUTH-4: which password writes end a forced change, and which must not.
 *
 * The distinction is not cosmetic. An administrator assigning a temporary
 * password (FR-ADMIN-2, M10) writes a credential password *and* raises the
 * same flag, so a rule of "any credential password write clears it" would race
 * that and hand the user an unforced sign-in.
 */
describe("endsForcedPasswordChange", () => {
  it("ends it when the user set their own password", () => {
    expect(endsForcedPasswordChange("credential", "/change-password")).toBe(true)
    expect(endsForcedPasswordChange("credential", "/reset-password")).toBe(true)
  })

  it("does not end it when somebody else set the password", () => {
    // M10's temporary-password flow, and anything else administrative.
    expect(endsForcedPasswordChange("credential", "/admin/set-user-password")).toBe(false)
    expect(endsForcedPasswordChange("credential", "/admin/update-user")).toBe(false)
  })

  it("does not end it when there is no request behind the write", () => {
    // The bootstrap step, the CLI, and Better Auth's own
    // `internalAdapter.updateAccount` all reach the hook with no path.
    expect(endsForcedPasswordChange("credential", undefined)).toBe(false)
  })

  it("ignores accounts that are not local credentials", () => {
    // A social token refresh updates an account row too.
    expect(endsForcedPasswordChange("google", "/change-password")).toBe(false)
    expect(endsForcedPasswordChange(undefined, "/change-password")).toBe(false)
  })
})
