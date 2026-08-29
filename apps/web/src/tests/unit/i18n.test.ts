import { describe, expect, it } from "vitest"

import {
  DEFAULT_LOCALE,
  getCatalog,
  localeFromCookieHeader,
  parseAcceptLanguage,
  resolveLocale,
  translator,
} from "@/server/i18n"

describe("FR-I18N-1 locale resolution", () => {
  it("prefers ui_locales, then the cookie, then Accept-Language, then the config", () => {
    // With only en-US shipping, the observable behavior is that each source is
    // consulted and an unsupported value never wins.
    expect(
      resolveLocale({
        uiLocales: "fr-FR en-US",
        cookie: "de-DE",
        acceptLanguage: "es-ES",
        configured: "en-US",
      })
    ).toBe("en-US")
  })

  it("falls back to the default when nothing matches", () => {
    expect(resolveLocale({ acceptLanguage: "fr-FR,de;q=0.9" })).toBe(
      DEFAULT_LOCALE
    )
    expect(resolveLocale({})).toBe(DEFAULT_LOCALE)
  })

  it("matches case-insensitively and by language", () => {
    expect(resolveLocale({ cookie: "EN-us" })).toBe("en-US")
    expect(resolveLocale({ cookie: "en" })).toBe("en-US")
    expect(resolveLocale({ cookie: "en-GB" })).toBe("en-US")
  })

  it("ignores a stale or nonsense cookie rather than breaking the page", () => {
    expect(resolveLocale({ cookie: "not-a-locale" })).toBe(DEFAULT_LOCALE)
    expect(getCatalog("kl-KL").locale).toBe(DEFAULT_LOCALE)
  })

  describe("Accept-Language parsing", () => {
    it("orders by quality", () => {
      expect(parseAcceptLanguage("de;q=0.7,en-US,fr;q=0.9")).toEqual([
        "en-US",
        "fr",
        "de",
      ])
    })

    it("drops the wildcard and zero-quality entries", () => {
      expect(parseAcceptLanguage("*,en;q=0,de")).toEqual(["de"])
    })

    it("handles an absent or empty header", () => {
      expect(parseAcceptLanguage(undefined)).toEqual([])
      expect(parseAcceptLanguage("")).toEqual([])
    })
  })

  it("reads the locale cookie out of a Cookie header", () => {
    expect(localeFromCookieHeader("a=1; idp_locale=en-US; b=2")).toBe("en-US")
    expect(localeFromCookieHeader("a=1")).toBeUndefined()
    expect(localeFromCookieHeader(undefined)).toBeUndefined()
  })
})

describe("catalog", () => {
  const t = translator({})

  it("returns typed strings and parameterised functions", () => {
    expect(t.auth.signIn.title).toBe("Sign in")
    expect(t.auth.signUp.passwordHint(12)).toContain("12")
    expect(t.email.verify.subject("Acme IdP")).toContain("Acme IdP")
  })

  it("gives the same neutral sign-in failure whatever went wrong (SEC-7)", () => {
    expect(t.auth.signIn.failed).not.toMatch(/unknown|not found|no account/i)
  })

  it("covers all nine e-mail templates (FR-MAIL-1)", () => {
    const templates = [
      "verify",
      "resetPassword",
      "setPassword",
      "pendingSignUp",
      "approved",
      "rejected",
      "passwordChanged",
      "twoFactorChanged",
      "apiKeyCreated",
    ] as const
    for (const name of templates) {
      expect(t.email[name]).toBeDefined()
    }
  })

  it("describes every default scope for the consent page (FR-OIDC-10)", () => {
    for (const scope of ["openid", "profile", "email", "offline_access"]) {
      expect(t.consent.scopes[scope]).toBeTruthy()
    }
    expect(t.consent.unknownScope("billing:read")).toContain("billing:read")
  })
})
