import type { ReactNode } from "react"

import { Eye, EyeOff } from "lucide-react"

import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { cn } from "@workspace/ui/lib/utils"

/**
 * Form pieces shared by the public pages (FR-ACCT-2, WCAG 2.1 AA).
 *
 * Every input is labelled, carries the right `autocomplete` token so password
 * managers behave, and describes its own hint and error through
 * `aria-describedby`. The password field's visibility toggle is a plain
 * checkbox driven by CSS, so it works before — and without — hydration.
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
  const hintId = hint ? `${name}-hint` : undefined
  const errorId = error ? `${name}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={name}>{label}</Label>
      <Input
        id={name}
        name={name}
        type={type}
        inputMode={inputMode}
        autoComplete={autoComplete}
        defaultValue={defaultValue}
        required={required}
        autoFocus={autoFocus}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
      />
      {hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      <FieldError id={errorId ?? `${name}-error`}>{error}</FieldError>
    </div>
  )
}

/**
 * A password field with a no-JavaScript visibility toggle (R-1, FR-ACCT-2).
 *
 * The control is the conventional eye / eye-off button sitting inside the
 * field, right-aligned. Underneath it is still a checkbox — visually hidden but
 * focusable — so the toggle works on the first paint, before hydration and
 * with JavaScript off. `autocomplete` matters here: a password manager that
 * cannot tell "current" from "new" will offer the wrong value at the wrong
 * moment.
 *
 * How the three CSS hooks divide the work, and why they are not all `peer-*`:
 *
 * - Tailwind v4 compiles `peer-checked:X` to `:where(.peer):checked ~ *`, a
 *   *sibling* combinator. It cannot reach the icons nested inside the label, so
 *   those swap on `group-has-checked:X` → `:where(.group):has(:checked) *`,
 *   which is a descendant selector.
 * - The input's masking uses the same `group-has-checked:` hook rather than
 *   `peer-checked:`, which buys the natural tab order: the checkbox can then
 *   sit *after* the input in the DOM, so Tab goes password field → reveal
 *   control instead of the other way round.
 * - The focus ring is drawn on the label via `peer-focus-visible:`, which does
 *   work as a sibling selector — the label directly follows the checkbox.
 *
 * **The CSS-only reveal is not enough on its own, measured 2026-08-24:**
 *
 * | engine        | `-webkit-text-security:none` on `input[type=password]` |
 * |---------------|--------------------------------------------------------|
 * | Chromium 151  | parsed, then clamped back to `disc` — no effect         |
 * | WebKit 26.5   | parsed, then clamped back to `disc` — no effect         |
 * | Firefox 153   | honoured                                               |
 *
 * (All three honour it on `input[type=text]`, so the property is alive; Blink
 * and WebKit specifically refuse to let a password field be unmasked by style.
 * `:has()` is supported everywhere that matters, so it is not the constraint.)
 *
 * So the working mechanism is the checkbox's `onChange` flipping the input
 * `type`, and the CSS is what covers Firefox before hydration. Where scripting
 * is off entirely, the `<noscript>` rule below **removes** the control rather
 * than leaving a toggle that renames itself "Hide password" while the password
 * stays masked — a dead control that lies to a screen reader is worse than no
 * control. Firefox-without-scripting loses a reveal it could have had; that is
 * the price of not shipping the lie to Chrome and Safari.
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
  const hintId = hint ? `${name}-hint` : undefined
  const errorId = error ? `${name}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined
  const toggleId = `${name}-reveal`

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={name}>{label}</Label>
      <div className="group relative">
        <Input
          id={name}
          name={name}
          type="password"
          autoComplete={autoComplete}
          required
          minLength={minLength}
          autoFocus={autoFocus}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          // Room for the control, and the scriptless reveal itself.
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
            // The only mechanism Blink and WebKit leave us; also what makes
            // the control instant on Firefox once hydrated.
            const field = document.getElementById(name)
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
      <FieldError id={errorId ?? `${name}-error`}>{error}</FieldError>
    </div>
  )
}
