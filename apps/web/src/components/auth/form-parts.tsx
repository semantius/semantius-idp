import { useId } from "react"
import type { ReactNode } from "react"

import { Eye, EyeOff } from "lucide-react"

import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { cn } from "@workspace/ui/lib/utils"

import { usePendingForm } from "@/components/common/pending-form"

/**
 * Form pieces shared by the public pages (FR-ACCT-2, WCAG 2.1 AA).
 *
 * Every input is labelled, carries the right `autocomplete` token so password
 * managers behave, and describes its own hint and error through
 * `aria-describedby`. The password field's visibility toggle is a plain
 * checkbox, so the control is already correct on the first paint, before
 * hydration. It does not have to survive scripting being off (D31).
 *
 * Inside a `PendingForm` both fields go `readOnly` while the post is in
 * flight. `readOnly` rather than `disabled`: a disabled field is dropped from
 * the submitted entry list and removed from the accessibility tree, and the
 * form the browser is at that moment submitting still has to contain its own
 * values.
 *
 * **The DOM id is generated, not the field name.** It used to be `name`, which
 * is unique in a *form* and emphatically not in a document: `/account/security`
 * has three fields called `password` — the new one in the change-password
 * dialog and the two the second-factor forms ask for — so `<label for>`
 * resolved to whichever `#password` came first in the DOM and named the wrong
 * control. The e2e suite caught it as "the field is not in the dialog", which
 * is exactly what an assistive technology would have reported. `name` still
 * decides what is submitted; nothing else uses it.
 */

export function FieldError({
  id,
  children,
}: {
  id: string
  children?: ReactNode
}) {
  if (!children) return null
  return (
    <p id={id} className="text-sm text-destructive">
      {children}
    </p>
  )
}

export function FormAlert({
  children,
  variant = "destructive",
}: {
  children: ReactNode
  variant?: "default" | "destructive"
}) {
  if (!children) return null
  return (
    <Alert variant={variant} className="mb-4">
      {/* Announced immediately: a sign-in failure is the whole point of the page. */}
      <AlertDescription aria-live="polite">{children}</AlertDescription>
    </Alert>
  )
}

export function TextField({
  name,
  label,
  type = "text",
  autoComplete,
  defaultValue,
  required = true,
  hint,
  error,
  autoFocus,
  inputMode,
}: {
  name: string
  label: string
  type?: string
  autoComplete?: string
  defaultValue?: string
  required?: boolean
  hint?: ReactNode
  error?: ReactNode
  autoFocus?: boolean
  inputMode?: "text" | "email" | "numeric"
}) {
  const fieldId = `${name}-${useId()}`
  const hintId = hint ? `${fieldId}-hint` : undefined
  const errorId = error ? `${fieldId}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined
  const { pending } = usePendingForm()

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={fieldId}>{label}</Label>
      <Input
        id={fieldId}
        name={name}
        type={type}
        inputMode={inputMode}
        autoComplete={autoComplete}
        defaultValue={defaultValue}
        required={required}
        autoFocus={autoFocus}
        readOnly={pending || undefined}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
      />
      {hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      <FieldError id={errorId ?? `${fieldId}-error`}>{error}</FieldError>
    </div>
  )
}

/**
 * A password field with an in-field visibility toggle (R-1, FR-ACCT-2).
 *
 * The control is the conventional eye / eye-off button sitting inside the
 * field, right-aligned. Underneath it is a visually-hidden but focusable
 * checkbox, so the control is already correct on the first paint and the
 * label's `for` does the work a click handler would. `autocomplete` matters
 * here: a password manager that cannot tell "current" from "new" will offer
 * the wrong value at the wrong moment.
 *
 * **The toggle is the checkbox's `onChange` flipping the input `type`.** Two
 * findings are worth keeping, because both contradict what this file used to
 * assume:
 *
 * - Tailwind v4 compiles `peer-checked:X` to `:where(.peer):checked ~ *`, a
 *   *sibling* combinator, so it can reach neither the icons nested inside the
 *   label nor an input that precedes it. Those use `group-has-checked:X` →
 *   `:where(.group):has(:checked) *`, a descendant selector. Using it for the
 *   input's masking too is what lets the checkbox sit *after* the input in the
 *   DOM, so Tab goes password field → reveal control rather than the reverse.
 *   The focus ring is drawn on the label via `peer-focus-visible:`, which does
 *   work as a sibling selector — the label directly follows the checkbox.
 *
 * - `-webkit-text-security: none` on `input[type=password]` is parsed and then
 *   clamped straight back to `disc`, measured 2026-08-24:
 *
 *   | engine       | effect                                          |
 *   |--------------|-------------------------------------------------|
 *   | Chromium 151 | none — clamped to `disc`                        |
 *   | WebKit 26.5  | none — clamped to `disc`                        |
 *   | Firefox 153  | honoured                                        |
 *
 *   All three honour it on `input[type=text]`, so the property is alive and
 *   Blink and WebKit are specifically refusing to let a password field be
 *   unmasked by style. The CSS-only reveal this component once claimed
 *   therefore only ever worked in Firefox. It stays as a one-class fallback
 *   that covers Firefox before hydration; it is not the mechanism.
 *
 * Scripting being off is not a supported case (D31). The `<noscript>` rule
 * below still withdraws the control, because it costs nothing and stops the
 * toggle renaming itself "Hide password" over a field that is still masked —
 * which would lie to a screen reader.
 */
export function PasswordField({
  name,
  label,
  autoComplete,
  hint,
  error,
  showLabel,
  hideLabel,
  minLength,
  autoFocus,
}: {
  name: string
  label: string
  autoComplete: "current-password" | "new-password"
  hint?: ReactNode
  error?: ReactNode
  /** The control's accessible name while the password is masked. */
  showLabel: string
  /** …and while it is revealed. The checkbox is named by whichever shows. */
  hideLabel: string
  minLength?: number
  autoFocus?: boolean
}) {
  const fieldId = `${name}-${useId()}`
  const hintId = hint ? `${fieldId}-hint` : undefined
  const errorId = error ? `${fieldId}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined
  const toggleId = `${fieldId}-reveal`
  const { pending } = usePendingForm()

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={fieldId}>{label}</Label>
      <div className="group relative">
        <Input
          id={fieldId}
          name={name}
          type="password"
          autoComplete={autoComplete}
          required
          minLength={minLength}
          autoFocus={autoFocus}
          readOnly={pending || undefined}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          // Room for the control, plus Firefox's before-hydration fallback.
          className="pr-10 group-has-checked:[-webkit-text-security:none]"
        />
        {/* Rendered as markup only when scripting is off, so it costs nothing
            otherwise. `dangerouslySetInnerHTML` keeps React from hydrating
            against it — with scripts on the browser parses this as text. */}
        <noscript
          dangerouslySetInnerHTML={{
            __html: "<style>[data-idp-reveal]{display:none}</style>",
          }}
        />
        <input
          id={toggleId}
          data-idp-reveal=""
          type="checkbox"
          className="peer sr-only"
          onChange={(event) => {
            // The mechanism. Blink and WebKit leave no CSS-only option, and
            // this is also what makes the control instant on Firefox.
            const field = document.getElementById(fieldId)
            if (field instanceof HTMLInputElement) {
              field.type = event.currentTarget.checked ? "text" : "password"
            }
          }}
        />
        <Label
          htmlFor={toggleId}
          data-idp-reveal=""
          className={cn(
            "absolute inset-y-0 right-0 flex w-10 cursor-pointer items-center justify-center rounded-r-lg",
            "text-muted-foreground transition-colors hover:text-foreground",
            "peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50 peer-focus-visible:outline-none"
          )}
        >
          <Eye aria-hidden="true" className="size-4 group-has-checked:hidden" />
          <EyeOff
            aria-hidden="true"
            className="hidden size-4 group-has-checked:block"
          />
          {/* The checkbox's accessible name, and it changes with its state. */}
          <span className="sr-only group-has-checked:hidden">{showLabel}</span>
          <span className="sr-only hidden group-has-checked:inline">
            {hideLabel}
          </span>
        </Label>
      </div>
      {hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      <FieldError id={errorId ?? `${fieldId}-error`}>{error}</FieldError>
    </div>
  )
}
