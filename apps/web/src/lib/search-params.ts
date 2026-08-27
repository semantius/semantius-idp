/**
 * Reading query parameters out of a TanStack Router location.
 *
 * The router parses the query string with `JSON.parse` per value, so a
 * parameter is only a `string` when it does not happen to look like something
 * else. `?forced=1` arrives as the **number** `1`, and `?forced=true` as the
 * boolean `true` — which is how `/change-password?forced=1` came to render the
 * ordinary "Change your password" page instead of the temporary-password one
 * FR-AUTH-4 asks for, with the `forced` marker missing from the form it
 * submits. Casting the search object to `Record<string, string>` hid it: the
 * types said string, the values were not.
 *
 * Every route reads its parameters through these two, so the coercion is
 * handled once instead of being rediscovered per page.
 */

/** A parameter as a string, whatever the parser turned it into. */
export function searchString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }
  // Arrays and objects are never something this app asked for.
  return undefined
}

/**
 * Whether a parameter is present and truthy.
 *
 * `?forced=1` and `?forced=true` both mean yes; `?forced=0`, `?forced=false`
 * and an absent parameter all mean no. A bare `?forced` (no value) is a
 * deliberate no — every link this app emits supplies a value, so a missing one
 * means the URL was hand-edited.
 */
export function searchFlag(value: unknown): boolean {
  const text = searchString(value)
  return text === "1" || text === "true"
}

/**
 * The same URL with one query parameter removed (**D71**).
 *
 * A success notice arrives as `?notice=…` and is shown once; leaving the
 * parameter behind is what made the old inline banner outlive its truth —
 * reloading, or coming Back to the page an hour later, re-announced something
 * that had already happened. Only the named parameter goes: `error`, `draft`
 * and `created` are siblings on the same URL and each has its own consumer.
 *
 * A plain string in, a plain string out, so it is testable without a router
 * and without a DOM.
 */
export function hrefWithoutParam(href: string, name: string): string {
  // Relative to an origin that is thrown away again: `URL` needs an absolute
  // input, and every caller passes `location.href`, which already is one.
  const url = new URL(href, "http://localhost")
  if (!url.searchParams.has(name)) return href
  url.searchParams.delete(name)
  return `${url.pathname}${url.search}${url.hash}`
}
