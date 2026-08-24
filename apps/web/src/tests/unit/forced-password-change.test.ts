import { describe, expect, it } from "vitest"

import {
  endsForcedPasswordChange,
  writesPassword,
} from "@/server/auth/options/database-hooks"

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
    expect(endsForcedPasswordChange("credential", "/change-password")).toBe(
      true
    )
    expect(endsForcedPasswordChange("credential", "/reset-password")).toBe(true)
  })

  it("does not end it when somebody else set the password", () => {
    // M10's temporary-password flow, and anything else administrative.
    expect(
      endsForcedPasswordChange("credential", "/admin/set-user-password")
    ).toBe(false)
    expect(endsForcedPasswordChange("credential", "/admin/update-user")).toBe(
      false
    )
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

/**
 * FR-AUTH-3 / FR-OIDC-12: which writes revoke the user's OAuth tokens.
 *
 * A wider set than the one above, and deliberately so — an administrator
 * assigning a temporary password does *not* end a forced change, but it does
 * mean the old password no longer reaches the account, so anything minted with
 * it has to go.
 */
describe("writesPassword", () => {
  it("covers every endpoint that sets a credential password", () => {
    expect(writesPassword("credential", "/change-password")).toBe(true)
    expect(writesPassword("credential", "/reset-password")).toBe(true)
    expect(writesPassword("credential", "/admin/set-user-password")).toBe(true)
  })

  it("ignores account updates that are not password writes", () => {
    // `account.update.after` also fires when a social provider's stored
    // tokens are refreshed, and the hook sees the whole row rather than the
    // columns that changed — so the endpoint is the only signal.
    expect(writesPassword("google", "/callback/google")).toBe(false)
    expect(writesPassword("credential", "/update-user")).toBe(false)
    expect(writesPassword(undefined, "/change-password")).toBe(false)
  })

  it("ignores writes with no request behind them", () => {
    expect(writesPassword("credential", undefined)).toBe(false)
  })
})
