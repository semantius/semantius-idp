/**
 * The API-gateway rules both sides need (FR-GW-1, **D91**).
 *
 * `/admin/gateways`'s form and the `gateways` block of `config.jsonc` apply the
 * same constraints, and there is exactly one place that knows them: this one.
 * The zod schema calls these functions, the admin endpoints call the zod
 * schema, and the dialog calls them directly — so a target the file would
 * refuse cannot be stored through the database path either.
 *
 * **Deliberately not in `server/`**, for the reason `client-rules.ts` gives at
 * length (**D62**): importing the zod schema into a dialog would pass
 * `check-client-bundle.ts` — that gate greps for six marker strings and a size
 * ceiling, and zod carries none of them — while quietly eroding the seam those
 * markers stand for. Pure functions, no zod, no imports; both sides call them.
 *
 * The answers are **codes, not sentences**. The schema turns them into the
 * operator-facing message a startup failure prints; the dialog turns them into
 * catalog strings (FR-I18N-1). Neither wording travels.
 */

/**
 * A gateway name is a **URL path segment** — `/gateway/<name>` — so it is
 * restricted to what is unambiguous in one: lower-case, no percent-encoding,
 * no dots (which would make `.` and `..` reachable as names), no slashes.
 * 64 characters is the same ceiling Postgres puts on an identifier and is far
 * more than a routing label needs.
 */
export const GATEWAY_NAME_PATTERN = "[a-z0-9][a-z0-9_-]{0,63}"

export function isValidGatewayName(value: string): boolean {
  return new RegExp(`^${GATEWAY_NAME_PATTERN}$`).test(value)
}

export type GatewayUrlProblem =
  | "not_absolute"
  | "scheme"
  | "trailing_slash"
  | "query"
  | "fragment"
  | "credentials"

/**
 * A gateway target must be an absolute http(s) origin-plus-optional-path with
 * nothing after the path.
 *
 * Each refusal is a way the proxy's URL join would stop being unambiguous, or
 * a way the IdP would end up forwarding something it did not mean to:
 *
 * - **scheme** — http and https only. `file:`, `gopher:` and friends are how a
 *   proxy becomes a file reader; the reach of an admin-defined target is
 *   already an accepted SSRF-shaped capability (**D91**), and widening it to
 *   non-HTTP schemes is not.
 * - **trailing_slash** — the proxy joins `${url}/${rest}`, so a trailing slash
 *   would produce `//` on every sub-path request. Some upstreams treat that as
 *   a different resource and one of them will be the one you deploy.
 * - **query** — the inbound query string is forwarded verbatim, so a target
 *   carrying one of its own would have to be merged, and "merged how" has no
 *   answer that is right for every upstream.
 * - **credentials** — userinfo in the URL is a secret in a config file that
 *   `/admin/system` would have to mask and a log line would have to redact.
 *   `Authorization` is what this feature is for; say it there.
 *
 * `undefined` means the URL is acceptable.
 */
export function checkGatewayUrl(value: string): GatewayUrlProblem | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return "not_absolute"
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "scheme"
  if (url.username !== "" || url.password !== "") return "credentials"
  // Both halves matter: `URL` drops an empty trailing `?`/`#`, and a target
  // written with one is still a target that meant to carry something.
  if (url.search !== "" || value.includes("?")) return "query"
  if (url.hash !== "" || value.includes("#")) return "fragment"
  if (value.endsWith("/")) return "trailing_slash"
  return undefined
}

export interface GatewayFormValues {
  name: string
  url: string
}

export type GatewayFormErrors = Partial<Record<keyof GatewayFormValues, string>>

/**
 * Everything the form can decide for itself, keyed by field name so the caller
 * can hang each message under its own input.
 *
 * A `url:<problem>` value carries the offending URL after a second colon, the
 * way `validateClientForm` does, so the dialog can name it without the wording
 * ever leaving the catalog.
 */
export function validateGatewayForm(
  values: GatewayFormValues
): GatewayFormErrors {
  const errors: GatewayFormErrors = {}
  if (!isValidGatewayName(values.name)) errors.name = "invalid"

  const url = values.url.trim()
  if (url === "") {
    errors.url = "required"
  } else {
    const problem = checkGatewayUrl(url)
    if (problem) errors.url = `url:${problem}:${url}`
  }
  return errors
}
