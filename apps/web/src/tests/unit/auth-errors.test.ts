import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import {
  NOTICE_CODES,
  messageForErrorCode,
  messageForNoticeCode,
} from "@/lib/auth-errors"
import { adminErrorCodeFor, errorCodeFor } from "@/server/http/auth-proxy"
import { getCatalog } from "@/server/i18n"

/**
 * The codes redirects carry, and the strings they resolve to (FR-I18N-1).
 *
 * Wording never travels in a URL — only a code does — so the risk is not a
 * wrong message but *no* message: a page that renders a blank alert because
 * nothing handles the code it was sent. That is exactly what happened to
 * `account_created` and `signed_out`, which two routes emitted and nothing
 * ever translated.
 */
const t = getCatalog()

/** Every `notice=` value any route actually redirects with. */
function emittedNoticeCodes(): string[] {
  const routes = fileURLToPath(new URL("../../routes/", import.meta.url))
  const files = [
    "forgot-password.tsx",
    "logout.tsx",
    "reset-password.tsx",
    "signup.tsx",
    "verify-email.tsx",
  ]
  const found = new Set<string>()
  for (const file of files) {
    const source = readFileSync(routes + file, "utf8")
    for (const match of source.matchAll(/notice=([a-z_]+)/g)) {
      found.add(match[1]!)
    }
  }
  return [...found].sort()
}

describe("notice codes", () => {
  it("translates every code a route actually emits", () => {
    // Read out of the routes rather than listed here, so adding a redirect
    // with a new notice fails this test instead of shipping a blank alert.
    const emitted = emittedNoticeCodes()
    expect(emitted.length).toBeGreaterThan(0)
    for (const code of emitted) {
      expect(messageForNoticeCode(code, t), code).toBeTruthy()
    }
  })

  it("keeps NOTICE_CODES and the switch in agreement", () => {
    for (const code of NOTICE_CODES) {
      expect(messageForNoticeCode(code, t), code).toBeTruthy()
    }
    for (const code of emittedNoticeCodes()) {
      expect(NOTICE_CODES.has(code), code).toBe(true)
    }
  })

  it("says nothing for a code it does not know", () => {
    // Unlike an error, an unknown notice must not fall back to a message —
    // inventing good news from an unrecognized query parameter would be worse
    // than silence.
    expect(messageForNoticeCode("made_up", t)).toBeUndefined()
    expect(messageForNoticeCode(undefined, t)).toBeUndefined()
  })
})

describe("error codes", () => {
  it("collapses a wrong password and an unknown address (SEC-7)", () => {
    expect(messageForErrorCode("invalid_credentials", t, 10)).toBe(
      t.auth.signIn.failed
    )
  })

  it("never confirms that an address is already registered (SEC-7)", () => {
    // `signup_failed` covers "already exists" too, and resolves to the same
    // neutral confirmation a successful sign-up shows.
    expect(messageForErrorCode("signup_failed", t, 10)).toBe(t.auth.signUp.done)
  })

  it("falls back to a generic failure rather than nothing", () => {
    // The opposite rule to notices: an error the page cannot name still has
    // to say *something*, or a failed action looks like a successful one.
    expect(messageForErrorCode("something_new", t, 10)).toBe(
      t.errors.serverError.description
    )
  })

  it("says nothing when there is no error at all", () => {
    expect(messageForErrorCode(undefined, t, 10)).toBeUndefined()
  })

  it("quotes the configured minimum, not the one it was written against", () => {
    // The hint hard-coded 12 while `auth.password.minLength` was configurable,
    // so a deployment that lowered it told people the wrong number.
    expect(messageForErrorCode("password_length", t, 10)).toBe(
      t.auth.signUp.passwordHint(10)
    )
    expect(messageForErrorCode("password_length", t, 16)).toBe(
      t.auth.signUp.passwordHint(16)
    )
  })
})

describe("errorCodeFor (FR-ADMIN-4, SEC-7)", () => {
  function codeFor(code: string, status = 403): string {
    return errorCodeFor({ ok: false, status, body: { code }, cookies: [] })
  }

  it("maps both ban refusals onto the page that explains a suspension", () => {
    // Two refusals reach the sign-in handler for the same state. The gate in
    // `database-hooks.ts` raises `ACCOUNT_BANNED`; Better Auth's admin plugin
    // has a ban check of its own on `session.create` that runs first and
    // raises `BANNED_USER`. Only the first was mapped, so an account suspended
    // from `/admin/users` was told its password was wrong.
    expect(codeFor("ACCOUNT_BANNED")).toBe("banned")
    expect(codeFor("BANNED_USER")).toBe("banned")
  })

  it("separates a rejected origin from a rejected credential (D57)", () => {
    // The refusal that costs the most time of any in this application. Better
    // Auth turns a post from an untrusted `Origin` away before it looks at the
    // password; unmapped, that arrived as `invalid_credentials` and the page
    // said the password was wrong — so the operator whose `server.baseUrl`
    // says `localhost` and whose browser says `127.0.0.1` goes hunting for a
    // credential bug that does not exist. The account it happens to first is
    // the one the first-run wizard just created, which is also the one nobody
    // can prove the password of.
    expect(codeFor("INVALID_ORIGIN")).toBe("untrusted_origin")
    expect(codeFor("MISSING_OR_NULL_ORIGIN")).toBe("untrusted_origin")
    // And it has to reach a message of its own, or the split buys nothing.
    expect(messageForErrorCode("untrusted_origin", t, 10)).toBe(
      t.auth.signIn.untrustedOrigin
    )
    expect(messageForErrorCode("untrusted_origin", t, 10)).not.toBe(
      t.auth.signIn.failed
    )
  })

  it("still collapses an unknown refusal into the neutral one", () => {
    // SEC-7: a wrong password and an address with no account are the same
    // answer, and anything unrecognized joins them rather than leaking.
    expect(codeFor("SOMETHING_NEW")).toBe("invalid_credentials")
    expect(codeFor("ANYTHING", 429)).toBe("rate_limited")
    expect(codeFor("ANYTHING", 500)).toBe("server_error")
  })

  it("hides both spellings of a taken address behind one sign-up answer (D70)", () => {
    // The public half of D70. `/sign-up/email` and `/admin/create-user` refuse
    // a duplicate with different codes; only the first was mapped, so the
    // second fell through the collapse below. On a public page both must land
    // on the same neutral sentence — SEC-7 is unchanged here.
    expect(codeFor("USER_ALREADY_EXISTS")).toBe("signup_failed")
    expect(codeFor("USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL")).toBe(
      "signup_failed"
    )
  })

  it("names a malformed address rather than calling it a bad credential (D70)", () => {
    // `invalid_email` has had a message since the setup wizard and nothing
    // emitted it; Better Auth's own validator is what produces the refusal.
    expect(codeFor("INVALID_EMAIL")).toBe("invalid_email")
    expect(messageForErrorCode("invalid_email", t, 10)).toBe(
      t.setup.invalidEmail
    )
  })
})

describe("adminErrorCodeFor (D70)", () => {
  function codeFor(code: string, status = 403): string {
    return adminErrorCodeFor({ ok: false, status, body: { code }, cookies: [] })
  }

  it("names a duplicate address, in either of Better Auth's spellings", () => {
    // The field report: a valid "Create a user" form answered "that e-mail
    // address and password combination is not correct" — in a dialog with no
    // password field — because the admin endpoint's spelling was unmapped and
    // the SEC-7 catch-all owned it.
    expect(codeFor("USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL")).toBe(
      "email_exists"
    )
    expect(codeFor("USER_ALREADY_EXISTS")).toBe("email_exists")
    expect(messageForErrorCode("email_exists", t, 10)).toBe(
      t.admin.refusals.emailExists
    )
  })

  it("never answers an administrator with a credential message", () => {
    // Everything that used to fall through: a bare 401, a validation refusal,
    // an unrecognized code. None of them is about a password here.
    for (const code of [
      "SOMETHING_NEW",
      "VALIDATION_ERROR",
      "YOU_ARE_NOT_ALLOWED_TO_CREATE_USERS",
    ]) {
      expect(codeFor(code)).toBe("request_failed")
      expect(codeFor(code)).not.toBe("invalid_credentials")
    }
    expect(
      adminErrorCodeFor({ ok: false, status: 401, body: {}, cookies: [] })
    ).toBe("request_failed")
    expect(messageForErrorCode("request_failed", t, 10)).toBe(
      t.errors.serverError.description
    )
    expect(messageForErrorCode("request_failed", t, 10)).not.toBe(
      t.auth.signIn.failed
    )
  })

  it("passes every mapped refusal through unchanged", () => {
    // The point of delegating rather than re-implementing: the admin
    // invariants and the client refusals each name something the
    // administrator can do next, and shadowing one would undo D50 and D66.
    expect(codeFor("LAST_ADMIN_PROTECTED")).toBe("last_admin_protected")
    expect(codeFor("CLIENT_MANAGED_BY_FILE")).toBe("client_managed_by_file")
    expect(codeFor("INVALID_EMAIL")).toBe("invalid_email")
    expect(codeFor("ANYTHING", 429)).toBe("rate_limited")
    expect(codeFor("ANYTHING", 500)).toBe("server_error")
  })
})
