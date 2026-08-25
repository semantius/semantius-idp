import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import {
  NOTICE_CODES,
  messageForErrorCode,
  messageForNoticeCode,
} from "@/lib/auth-errors"
import { errorCodeFor } from "@/server/http/auth-proxy"
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
    // inventing good news from an unrecognised query parameter would be worse
    // than silence.
    expect(messageForNoticeCode("made_up", t)).toBeUndefined()
    expect(messageForNoticeCode(undefined, t)).toBeUndefined()
  })
})

describe("error codes", () => {
  it("collapses a wrong password and an unknown address (SEC-7)", () => {
    expect(messageForErrorCode("invalid_credentials", t)).toBe(
      t.auth.signIn.failed
    )
  })

  it("never confirms that an address is already registered (SEC-7)", () => {
    // `signup_failed` covers "already exists" too, and resolves to the same
    // neutral confirmation a successful sign-up shows.
    expect(messageForErrorCode("signup_failed", t)).toBe(t.auth.signUp.done)
  })

  it("falls back to a generic failure rather than nothing", () => {
    // The opposite rule to notices: an error the page cannot name still has
    // to say *something*, or a failed action looks like a successful one.
    expect(messageForErrorCode("something_new", t)).toBe(
      t.errors.serverError.description
    )
  })

  it("says nothing when there is no error at all", () => {
    expect(messageForErrorCode(undefined, t)).toBeUndefined()
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

  it("still collapses an unknown refusal into the neutral one", () => {
    // SEC-7: a wrong password and an address with no account are the same
    // answer, and anything unrecognised joins them rather than leaking.
    expect(codeFor("SOMETHING_NEW")).toBe("invalid_credentials")
    expect(codeFor("ANYTHING", 429)).toBe("rate_limited")
    expect(codeFor("ANYTHING", 500)).toBe("server_error")
  })
})
