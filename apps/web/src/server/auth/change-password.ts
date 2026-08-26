/**
 * Changing a password, once, for the two places that offer it (FR-AUTH-3/4).
 *
 * `/change-password` is the forced-change page (FR-AUTH-4) and the target of
 * `/.well-known/change-password`, so it stays a page. `/account/security`
 * offers the same change as a dialog, like every other action on that page.
 * Two callers, one set of rules — and the rules are the part that must not
 * drift: which refusal maps to `wrong_current_password`, that the other
 * sessions are revoked, and that the notification is sent.
 *
 * The redirect is *not* here. Where a completed change lands is the difference
 * between the two callers: the forced page resumes a waiting authorization
 * (FR-OIDC-9) and the account page comes back to itself.
 */

import { callAuth, errorCodeFor } from "../http/auth-proxy"
import { readSession } from "../http/session"
import type { Runtime } from "../runtime"

export type ChangePasswordResult =
  | { ok: true; cookies: string[] }
  | { ok: false; code: string }

export async function changePassword(
  runtime: Runtime,
  request: Request,
  form: Record<string, string | undefined>
): Promise<ChangePasswordResult> {
  // The browser checks this too since D62, and the check stays here because a
  // form is whatever the caller posts.
  if (form.password !== form.confirmPassword) {
    return { ok: false, code: "password_mismatch" }
  }

  const result = await callAuth(
    runtime,
    "/change-password",
    {
      currentPassword: form.currentPassword ?? "",
      newPassword: form.password ?? "",
      // FR-AUTH-3: a change revokes the user's other sessions.
      revokeOtherSessions: true,
    },
    request
  )

  if (!result.ok) {
    const code = typeof result.body.code === "string" ? result.body.code : ""
    return {
      ok: false,
      code: /INVALID_PASSWORD|INCORRECT/i.test(code)
        ? "wrong_current_password"
        : errorCodeFor(result),
    }
  }

  // FR-AUTH-3, FR-MAIL-1: "your password was changed" is the message that
  // tells someone their account has been taken, so it cannot be reserved for
  // the reset path. `onPasswordReset` covers that one; this is the other half,
  // and it was missing — changing a password from `/account/security` sent
  // nothing at all.
  //
  // Read after the change, because the session survives it: only the *other*
  // sessions are revoked.
  const changed = await readSession(runtime, request)
  if (changed) {
    await runtime.mailer.send("passwordChanged", changed.user.email)
  }

  return { ok: true, cookies: result.cookies }
}
