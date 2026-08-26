import { ConfirmedPasswordFields } from "./confirmed-password"
import { PasswordField } from "./form-parts"

import type { Catalog } from "@/server/i18n"

/**
 * Current password, new password, confirmation — the three fields both places
 * that change a password ask for.
 *
 * `/change-password` is still a page, because it is also the forced-change
 * page (FR-AUTH-4) and the target `/.well-known/change-password` redirects to.
 * `/account/security` asks in a dialog, like every other action on that page.
 * Sharing the fields is what keeps the two from drifting into different
 * `autocomplete` tokens and different hints, which is exactly how a password
 * manager starts offering the wrong value.
 */
export function ChangePasswordFields({
  t,
  minLength,
  confirmError,
  autoFocus,
}: {
  t: Catalog
  /** `ui.passwordMinLength`. */
  minLength: number
  /** The mismatch, from `usePasswordConfirm` (**D62**). */
  confirmError?: string
  autoFocus?: boolean
}) {
  return (
    <>
      <PasswordField
        name="currentPassword"
        label={t.common.currentPassword}
        autoComplete="current-password"
        showLabel={t.common.showPassword}
        hideLabel={t.common.hidePassword}
        autoFocus={autoFocus}
      />
      <ConfirmedPasswordFields
        t={t}
        minLength={minLength}
        error={confirmError}
      />
    </>
  )
}
