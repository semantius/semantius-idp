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
    case "invalid_email":
      return t.setup.invalidEmail
    case "password_mismatch":
      return t.auth.resetPassword.mismatch
    case "wrong_current_password":
      return t.auth.changePassword.wrongCurrent
    case "two_factor_invalid":
      return t.auth.twoFactor.invalid
    case "two_factor_locked":
      return t.auth.twoFactor.lockedOut
    case "two_factor_expired":
      return t.auth.twoFactor.expired
    case "not_found":
      // The thing being acted on is not there, or is not yours. SEC-7: the
      // two cases must not be distinguishable.
      return t.errors.notFound.description
    case "expiry_out_of_range":
      return t.account.apiKeys.outOfRange
    case "token_expired":
      return t.auth.resetPassword.expired
    case "token_used":
      return t.auth.resetPassword.used
    case "token_invalid":
      return t.auth.resetPassword.invalid
    case "signup_failed":
      // SEC-7: never confirms whether the address was already taken.
      return t.auth.signUp.done
    case "admin_cannot_change_own_roles":
      return t.admin.refusals.ownRoles
    case "admin_cannot_ban_self":
      return t.admin.refusals.selfBan
    case "admin_cannot_delete_self":
      return t.admin.refusals.selfDelete
    case "admin_cannot_impersonate_self":
      return t.admin.refusals.selfImpersonate
    case "last_admin_protected":
      return t.admin.refusals.lastAdmin
    case "only_admins_grant_admin_roles":
      return t.admin.refusals.notAnAdmin
    case "impersonation_disabled":
      return t.admin.actions.impersonateDisabled
    case "email_disabled":
      return t.admin.refusals.emailDisabled
    case "client_already_exists":
      return t.admin.refusals.clientExists
    case "client_managed_by_file":
      return t.admin.refusals.clientFromFile
    case "client_not_found":
      return t.errors.notFound.description
    case "invalid_client_definition":
    case "scope_not_allowed":
      return t.admin.refusals.clientInvalid
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
  "reauth",
  "signin_required",
  "profile_saved",
  "email_change_sent",
  "session_revoked",
  "apikey_revoked",
  "consent_revoked",
  "twofactor_on",
  "twofactor_off",
  "already_setup",
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
    case "reauth":
      // FR-AUTH-5: the session was real, only too old for what was asked.
      return t.auth.signIn.reauth
    case "signin_required":
      return t.auth.signIn.required
    case "profile_saved":
      return t.account.profile.saved
    case "email_change_sent":
      return t.account.changeEmail.sent
    case "session_revoked":
      return t.account.sessions.revoked
    case "apikey_revoked":
      return t.account.apiKeys.revoked
    case "consent_revoked":
      return t.account.consents.revoked
    case "twofactor_on":
      return t.account.twoFactor.turnedOn
    case "twofactor_off":
      return t.account.twoFactor.turnedOff
    case "already_setup":
      // D52: the loser of a concurrent first-run POST, and anyone who kept the
      // `/setup` bookmark. Neutral either way.
      return t.setup.alreadyDone
    default:
      // The admin pages name their notices after the catalog key directly:
      // there are a dozen of them, they are all one-line confirmations, and a
      // second switch listing each one would say nothing the key does not.
      return (t.admin.notices as Record<string, string | undefined>)[code ?? ""]
  }
}
