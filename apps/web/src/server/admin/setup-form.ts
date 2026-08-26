/**
 * What `/setup` accepts, as a pure function (FR-ADMIN-1, **D54**).
 *
 * The route handler owns the rate limiter, the advisory lock and the redirects;
 * this owns the rules, so they can be asserted without a runtime, a database or
 * a browser. Every failure is an error *code* — wording never travels in a
 * query string (see `lib/auth-errors.ts`).
 */

export interface SetupFormValues {
  email: string
  firstName: string
  lastName: string
  password: string
}

export type SetupFormResult =
  | { ok: true; values: SetupFormValues }
  | { ok: false; code: string }

/**
 * Shape only. The address is not verified and does not need to be: the person
 * filling this in is standing at the deployment they just started, and
 * `emailVerified` is set for exactly that reason.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function validateSetupForm(
  form: Record<string, string | undefined>,
  policy: { minLength: number; maxLength: number }
): SetupFormResult {
  // Trimmed as well as lower-cased, per FR-AUTH-1's "trimmed and lower-cased
  // everywhere": `EMAIL_SHAPE` rejects any whitespace, so without this a
  // pasted address with a trailing space is refused as malformed — on the one
  // form in the application that cannot be reached a second time.
  const email = (form.email ?? "").trim().toLowerCase()
  const firstName = (form.firstName ?? "").trim()
  const lastName = (form.lastName ?? "").trim()
  const password = form.password ?? ""

  if (!EMAIL_SHAPE.test(email)) return { ok: false, code: "invalid_email" }

  // Both names are required (D54). The display name is derived from them
  // (D49), so a blank one leaves the first administrator with a name that
  // renders as a stray space in the admin list and the audit trail — and
  // `/setup` is not reachable a second time to correct it.
  if (firstName === "" || lastName === "")
    return { ok: false, code: "missing_name" }

  if (password.length < policy.minLength || password.length > policy.maxLength)
    return { ok: false, code: "password_length" }

  // Typed twice, because nothing here can recover a typo: the account is
  // created verified with no forced change, so a mistyped password means a
  // deployment nobody can sign in to and a `/setup` page that has closed.
  if (password !== (form.confirmPassword ?? ""))
    return { ok: false, code: "password_mismatch" }

  return { ok: true, values: { email, firstName, lastName, password } }
}
