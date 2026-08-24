import type { Catalog } from "@/server/i18n"

/**
 * Turns the error code a redirect carries into a catalog string.
 *
 * Codes travel in the query string; wording never does. That keeps user input
 * out of URLs, keeps every message translatable (FR-I18N-1), and means a
 * message cannot be forged by editing the address bar into something that
 * looks like it came from us.
 */
export function messageForErrorCode(
  code: string | undefined,
  t: Catalog
): string | undefined {
  if (!code) return undefined

  switch (code) {
    case "invalid_credentials":
      // SEC-7: identical for a wrong password and an unknown address.
      return t.auth.signIn.failed
    case "unavailable":
      return t.auth.signIn.unavailable
    case "email_not_verified":
      return t.auth.verifyEmail.pending("your address")
    case "domain_not_allowed":
      return t.auth.signUp.domainNotAllowed
    case "password_length":
      return t.auth.signUp.passwordHint(12)
    case "password_mismatch":
      return t.auth.resetPassword.mismatch
    case "wrong_current_password":
      return t.auth.changePassword.wrongCurrent
    case "token_expired":
      return t.auth.resetPassword.expired
    case "token_used":
      return t.auth.resetPassword.used
    case "token_invalid":
      return t.auth.resetPassword.invalid
    case "signup_failed":
      // SEC-7: never confirms whether the address was already taken.
      return t.auth.signUp.done
    case "rate_limited":
      return t.errors.rateLimited.description
    case "server_error":
      return t.errors.serverError.description
    default:
      return t.errors.serverError.description
  }
}

/**
 * Codes that are good news rather than failures, shown in a neutral alert.
 *
 * Kept in step with the switch below by a unit test, because the two used to
 * disagree: `/signup` and `/logout` both redirect carrying a notice, and
 * neither code was handled — so completing a sign-up or signing out landed on
 * `/login` with a query parameter and a blank page where the confirmation
 * should have been.
 */
export const NOTICE_CODES = new Set([
  "reset_sent",
  "verification_sent",
  "password_changed",
  "account_created",
  "signed_out",
])

export function messageForNoticeCode(
  code: string | undefined,
  t: Catalog
): string | undefined {
  switch (code) {
    case "reset_sent":
      return t.auth.forgotPassword.done
    case "verification_sent":
      return t.auth.verifyEmail.resent
    case "password_changed":
      return t.auth.changePassword.success
    case "account_created":
      // Only reachable with approval *and* verification off; both gates have
      // a page of their own, and this is the path where neither applies.
      return t.auth.signUp.done
    case "signed_out":
      return t.auth.signOut.description
    default:
      return undefined
  }
}
