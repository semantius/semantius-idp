/**
 * Locale resolution and the typed message catalog (FR-I18N-1).
 *
 * Only `en-US` ships in v1. The structure is what has to be ready: adding a
 * locale must not require code changes outside the catalog, so
 * {@link SUPPORTED_LOCALES} and {@link CATALOGS} are the only two places a new
 * language touches, and its object is type-checked against the en-US shape.
 *
 * Resolution order (FR-I18N-1):
 *   `ui_locales` on the authorize request → locale cookie → `Accept-Language`
 *   → `site.defaultLocale`.
 */

import { enUS  } from "./catalog/en-US"
import type {Catalog} from "./catalog/en-US";

export type { Catalog } from "./catalog/en-US"

export const DEFAULT_LOCALE = "en-US"

/** Every locale that ships. Adding one means adding it here and to CATALOGS. */
export const SUPPORTED_LOCALES = [DEFAULT_LOCALE] as const
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

const CATALOGS: Record<SupportedLocale, Catalog> = {
  [DEFAULT_LOCALE]: enUS,
}

/** The cookie a user's explicit language choice is remembered in. */
export const LOCALE_COOKIE = "idp_locale"

export interface LocaleSources {
  /** The `ui_locales` parameter of an authorize request, space-separated. */
  uiLocales?: string | null
  /** The value of the locale cookie. */
  cookie?: string | null
  /** The raw `Accept-Language` header. */
  acceptLanguage?: string | null
  /** `site.defaultLocale`. */
  configured?: string
}

/**
 * Picks the first supported locale from the sources, in FR-I18N-1's order.
 *
 * Matching is case-insensitive and falls back from a full tag to its language
 * (`de-AT` → `de`), so a browser asking for a regional variant of a language we
 * ship still gets it.
 */
export function resolveLocale(sources: LocaleSources): SupportedLocale {
  const candidates = [
    ...splitSpaceSeparated(sources.uiLocales),
    ...(sources.cookie ? [sources.cookie] : []),
    ...parseAcceptLanguage(sources.acceptLanguage),
    ...(sources.configured ? [sources.configured] : []),
  ]

  for (const candidate of candidates) {
    const match = matchLocale(candidate)
    if (match) return match
  }
  return DEFAULT_LOCALE
}

function splitSpaceSeparated(value: string | null | undefined): string[] {
  if (!value) return []
  return value.split(/\s+/).filter((entry) => entry !== "")
}

/** `Accept-Language: de-AT,de;q=0.9,en;q=0.8` → `["de-AT", "de", "en"]`. */
export function parseAcceptLanguage(
  header: string | null | undefined
): string[] {
  if (!header) return []
  return header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";")
      const qParam = params.find((param) => param.trim().startsWith("q="))
      const quality = qParam ? Number.parseFloat(qParam.trim().slice(2)) : 1
      return {
        tag: (tag ?? "").trim(),
        quality: Number.isFinite(quality) ? quality : 0,
      }
    })
    .filter(
      (entry) => entry.tag !== "" && entry.tag !== "*" && entry.quality > 0
    )
    .sort((left, right) => right.quality - left.quality)
    .map((entry) => entry.tag)
}

function matchLocale(candidate: string): SupportedLocale | undefined {
  const normalized = candidate.trim().toLowerCase()
  if (normalized === "") return undefined

  const exact = SUPPORTED_LOCALES.find(
    (locale) => locale.toLowerCase() === normalized
  )
  if (exact) return exact

  // `de-AT` should still find a `de-*` bundle if we ship one.
  const language = normalized.split("-")[0]
  return SUPPORTED_LOCALES.find(
    (locale) => locale.toLowerCase().split("-")[0] === language
  )
}

/**
 * The catalog for a locale. Unknown locales fall back to the default rather
 * than throwing: a stale cookie must not break a page.
 */
export function getCatalog(locale: string = DEFAULT_LOCALE): Catalog {
  const match = matchLocale(locale)
  return CATALOGS[match ?? DEFAULT_LOCALE]
}

/**
 * Resolves the locale for a request and returns its catalog.
 *
 * Named `t` at call sites (`const t = translator(request)`), so a string reads
 * `t.auth.signIn.title` — typed, with no key strings to mistype.
 */
export function translator(sources: LocaleSources): Catalog {
  return getCatalog(resolveLocale(sources))
}

/** Reads the locale cookie out of a `Cookie` header. */
export function localeFromCookieHeader(
  header: string | null | undefined
): string | undefined {
  if (!header) return undefined
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=")
    if (name === LOCALE_COOKIE) return decodeURIComponent(rest.join("="))
  }
  return undefined
}
