import type { ReactNode } from "react"

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
 * A password field with a no-JavaScript visibility toggle.
 *
 * The checkbox is visually hidden and drives the input's type through a sibling
 * selector, so it works on the first paint. `autocomplete` matters here: a
 * password manager that cannot tell "current" from "new" will offer the wrong
 * value at the wrong moment.
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
  showLabel: string
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
      <div className="group grid gap-1.5">
        <input id={toggleId} type="checkbox" className="peer sr-only" />
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
          // The sibling checkbox flips this to a text field with no script.
          className="peer-checked:[-webkit-text-security:none] [&[type=password]]:peer-checked:[-webkit-text-security:none]"
        />
        <Label
          htmlFor={toggleId}
          className={cn(
            "w-fit cursor-pointer text-xs font-normal text-muted-foreground underline underline-offset-4",
            "peer-checked:hidden"
          )}
        >
          {showLabel}
        </Label>
        <Label
          htmlFor={toggleId}
          className={cn(
            "hidden w-fit cursor-pointer text-xs font-normal text-muted-foreground underline underline-offset-4",
            "peer-checked:block"
          )}
        >
          {hideLabel}
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
