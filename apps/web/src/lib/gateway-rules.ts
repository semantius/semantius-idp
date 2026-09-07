/**
 * The API-gateway rules both sides need.
 *
 * `/admin/gateways`'s form and the `gateways` block of `config.jsonc` apply the
 * same constraints, and there is exactly one place that knows them: this one.
 * The zod schema calls these functions, the admin endpoints call the zod
 * schema, and the dialog calls them directly — so a target the file would
 * refuse cannot be stored through the database path either.
 *
 * **Deliberately not in `server/`**, for the reason `client-rules.ts` gives at
 * length: importing the zod schema into a dialog would pass
 * `check-client-bundle.ts` — that gate greps for six marker strings and a size
 * ceiling, and zod carries none of them — while quietly eroding the seam those
 * markers stand for. Pure functions, no zod, no imports; both sides call them.
 *
 * The answers are **codes, not sentences**. The schema turns them into the
 * operator-facing message a startup failure prints; the dialog turns them into
 * catalog strings. Neither wording travels.
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
  | "link_local"

/**
 * Whether an address is link-local: `169.254.0.0/16` — which holds every
 * cloud provider's instance-metadata service — or `fe80::/10`, in any of the
 * spellings an upstream hostname or a resolver can produce.
 *
 * This is the **one** range an admin-defined target may not reach. The gateway design
 * accepts private-address reach outright: the shipped sibling deployment's
 * upstream is `http://postgrest:3000` on a compose network, the integration
 * suite's is `127.0.0.1`, and a gateway whose whole point is to sit in front
 * of an internal service cannot be told that internal addresses are off
 * limits. Link-local is different in kind — nothing an operator deploys
 * behind a gateway lives there, and the thing that does live there hands out
 * cloud credentials to whoever asks.
 *
 * Pure string work rather than `node:net`, because the form calls this in the
 * browser. Accepts what the WHATWG URL parser and `dns.lookup` hand over:
 * dotted-decimal IPv4 (the parser has already normalized the octal and
 * integer forms), IPv6 with or without brackets, a zone id, and the
 * IPv4-mapped (`::ffff:a.b.c.d`, `::ffff:a9fe:a9fe`) and IPv4-compatible
 * forms. Anything it cannot parse is **not** link-local — a hostname is
 * resolved before it is judged, and a literal the parser refused never got
 * this far.
 */
export function isLinkLocalAddress(address: string): boolean {
  const ipv4 = parseIpv4(address)
  if (ipv4) return ipv4[0] === 169 && ipv4[1] === 254
  const hextets = parseIpv6(address)
  if (!hextets) return false
  if ((hextets[0]! & 0xffc0) === 0xfe80) return true
  // IPv4-mapped (`::ffff:a.b.c.d`) and IPv4-compatible (`::a.b.c.d`).
  const embedded =
    hextets.slice(0, 5).every((h) => h === 0) &&
    (hextets[5] === 0xffff || hextets[5] === 0)
  if (!embedded) return false
  return hextets[6]! >> 8 === 169 && (hextets[6]! & 0xff) === 254
}

function parseIpv4(value: string): number[] | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value)
  if (!match) return undefined
  const octets = match.slice(1).map(Number)
  return octets.every((octet) => octet <= 255) ? octets : undefined
}

/** Eight hextets, or `undefined` for anything that is not an IPv6 address. */
function parseIpv6(value: string): number[] | undefined {
  let text = value.trim().toLowerCase()
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1)
  const zone = text.indexOf("%")
  if (zone !== -1) text = text.slice(0, zone)
  if (!text.includes(":")) return undefined

  // A trailing dotted quad becomes the last two hextets.
  const lastColon = text.lastIndexOf(":")
  const tail = text.slice(lastColon + 1)
  if (tail.includes(".")) {
    const quad = parseIpv4(tail)
    if (!quad) return undefined
    const high = ((quad[0]! << 8) | quad[1]!).toString(16)
    const low = ((quad[2]! << 8) | quad[3]!).toString(16)
    text = `${text.slice(0, lastColon)}:${high}:${low}`
  }

  const halves = text.split("::")
  if (halves.length > 2) return undefined
  const toHextets = (part: string): number[] | undefined => {
    if (part === "") return []
    const groups = part.split(":")
    const parsed = groups.map((group) =>
      /^[0-9a-f]{1,4}$/.test(group) ? Number.parseInt(group, 16) : Number.NaN
    )
    return parsed.some(Number.isNaN) ? undefined : parsed
  }
  const head = toHextets(halves[0]!)
  const rest = halves.length === 2 ? toHextets(halves[1]!) : []
  if (!head || !rest) return undefined
  if (halves.length === 1) return head.length === 8 ? head : undefined
  const missing = 8 - head.length - rest.length
  if (missing < 1) return undefined
  return [...head, ...new Array<number>(missing).fill(0), ...rest]
}

/**
 * A gateway target must be an absolute http(s) origin-plus-optional-path with
 * nothing after the path.
 *
 * Each refusal is a way the proxy's URL join would stop being unambiguous, or
 * a way the IdP would end up forwarding something it did not mean to:
 *
 * - **scheme** — http and https only. `file:`, `gopher:` and friends are how a
 *   proxy becomes a file reader; the reach of an admin-defined target is
 *   already an accepted SSRF-shaped capability, and widening it to
 *   non-HTTP schemes is not.
 * - **trailing_slash** — the proxy joins `${url}/${rest}`, so a trailing slash
 *   would produce `//` on every sub-path request. Some upstreams treat that as
 *   a different audience and one of them will be the one you deploy.
 * - **query** — the inbound query string is forwarded verbatim, so a target
 *   carrying one of its own would have to be merged, and "merged how" has no
 *   answer that is right for every upstream.
 * - **credentials** — userinfo in the URL is a secret in a config file that
 *   `/admin/system` would have to mask and a log line would have to redact.
 *   `Authorization` is what this feature is for; say it there.
 * - **link_local** — an address literal in `169.254.0.0/16` or `fe80::/10`
 *. Refused here so a misconfiguration is named at start-up or
 *   in the form; a *hostname* that resolves there is refused per request by
 *   the proxy, against the resolved address, with the same rule
 *   ({@link isLinkLocalAddress}).
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
  if (isLinkLocalAddress(url.hostname)) return "link_local"
  // Both halves matter: `URL` drops an empty trailing `?`/`#`, and a target
  // written with one is still a target that meant to carry something.
  if (url.search !== "" || value.includes("?")) return "query"
  if (url.hash !== "" || value.includes("#")) return "fragment"
  if (value.endsWith("/")) return "trailing_slash"
  return undefined
}

export type GatewayResourceProblem = "not_uri" | "fragment"

/**
 * A gateway's optional audience: the `aud` the minted
 * JWT names for that gateway, in place of `jwt.audience`.
 *
 * RFC 8707 §2 is the rule — an absolute URI (RFC 3986 §4.3), so a scheme is
 * required and a URN is fine, and **no fragment**. Whitespace is refused with
 * everything else `new URL` refuses. The value is compared by the upstream
 * as an opaque string, so nothing here normalizes it: what the operator
 * typed is what the token carries.
 *
 * `undefined` means acceptable; an empty string is "unset" and is the
 * caller's to handle, because a form field and a config key spell absence
 * differently.
 */
export function checkGatewayAudience(
  value: string
): GatewayResourceProblem | undefined {
  if (/\s/.test(value)) return "not_uri"
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return "not_uri"
  }
  // `URL` drops an empty trailing `#`, and a value written with one still
  // meant to carry a fragment — the same reading `checkGatewayUrl` takes.
  if (url.hash !== "" || value.includes("#")) return "fragment"
  return undefined
}

export interface GatewayFormValues {
  name: string
  url: string
  /** Optional; empty means "not set". */
  audience?: string
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

  const audience = (values.audience ?? "").trim()
  if (audience !== "") {
    const problem = checkGatewayAudience(audience)
    if (problem) errors.audience = `audience:${problem}:${audience}`
  }
  return errors
}
