import { useCallback, useState } from "react"
import type { ComponentProps } from "react"

import { PasswordField } from "./form-parts"

import type { Catalog } from "@/server/i18n"

/**
 * "Type it twice", checked before the form is posted (**D62**).
 *
 * Three forms ask for a new password and a confirmation — `/setup`,
 * `/reset-password` and `/change-password` — and until now all three learned
 * about a typo the same way: a POST, a 303 and a page that came back empty,
 * with the mismatch announced at the top as if it were a server refusal. The
 * one thing the browser could have answered on its own was the one thing it
 * waited on the network for.
 *
 * **The server checks stay exactly as they are.** This is the earlier of two
 * gates, not a replacement for one: the handler still compares the two values
 * and still redirects with `password_mismatch`, because a form is whatever the
 * caller posts and a check that lives only in the browser is not a check.
 * Requiring JavaScript for the *convenience* is sanctioned by D31.
 *
 * Interception has to happen at the `PendingForm`'s own `onSubmit` — that is
 * the only handler in the chain, and it already calls the prop first and
 * respects `preventDefault()` — so the shape is a hook that owns the error
 * state and a presentational component that renders the pair. A page wires the
 * two together and adds nothing else.
 */

/** Whatever React's own `<form onSubmit>` is typed as, in this React. */
type FormSubmitEvent = Parameters<
  NonNullable<ComponentProps<"form">["onSubmit"]>
>[0]

export interface PasswordConfirm {
  /** Give this to the `PendingForm` that contains the two fields. */
  onSubmit: (event: FormSubmitEvent) => void
  /** Give this to {@link ConfirmedPasswordFields}. */
  error?: string
}

/**
 * The mismatch check, as submit handler plus error state.
 *
 * The values are read out of the submitted form rather than held in React
 * state: these are password fields, and the less of one that exists outside
 * the DOM node the better. It also means the fields stay uncontrolled, which
 * is what lets the reveal toggle in `PasswordField` keep working by mutating
 * `type` on the element.
 */
export function usePasswordConfirm(t: Catalog): PasswordConfirm {
  const [error, setError] = useState<string | undefined>(undefined)

  const onSubmit = useCallback(
    (event: FormSubmitEvent) => {
      const form = event.currentTarget
      const password = form.elements.namedItem("password")
      const confirm = form.elements.namedItem("confirmPassword")
      if (
        !(password instanceof HTMLInputElement) ||
        !(confirm instanceof HTMLInputElement)
      ) {
        // Not our form after all. Let it post and let the server answer.
        return
      }

      if (password.value !== confirm.value) {
        event.preventDefault()
        setError(t.auth.resetPassword.mismatch)
        // Focus follows the message, or a screen-reader user is told
        // something is wrong and left wherever they were.
        confirm.focus()
        return
      }

      // Cleared on the way out, so a corrected second attempt does not post
      // with last time's message still under the field.
      setError(undefined)
    },
    [t]
  )

  return { onSubmit, error }
}

/**
 * The new-password / confirm-password pair.
 *
 * The labels are injectable because `/setup` says "Confirm password" — there
 * is no old password on a deployment's first run, so "Confirm *new* password"
 * would be describing something that does not exist — while the other two say
 * "Confirm new password".
 */
export function ConfirmedPasswordFields({
  t,
  minLength,
  error,
  newLabel,
  confirmLabel,
  autoFocus,
}: {
  t: Catalog
  /** `ui.passwordMinLength`, so the browser's own check matches the server's. */
  minLength: number
  /** From {@link usePasswordConfirm}. Rendered under the confirm field. */
  error?: string
  newLabel?: string
  confirmLabel?: string
  autoFocus?: boolean
}) {
  return (
    <>
      <PasswordField
        name="password"
        label={newLabel ?? t.common.newPassword}
        autoComplete="new-password"
        minLength={minLength}
        hint={t.auth.signUp.passwordHint(minLength)}
        showLabel={t.common.showPassword}
        hideLabel={t.common.hidePassword}
        autoFocus={autoFocus}
      />
      <PasswordField
        name="confirmPassword"
        label={confirmLabel ?? t.common.confirmPassword}
        autoComplete="new-password"
        minLength={minLength}
        error={error}
        showLabel={t.common.showPassword}
        hideLabel={t.common.hidePassword}
      />
    </>
  )
}
