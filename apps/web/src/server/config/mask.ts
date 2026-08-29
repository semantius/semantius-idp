/**
 * Masking of the effective configuration (CFG-5, SEC-5).
 *
 * `/admin/system` prints the configuration the process actually runs with, in
 * full, to a browser. Anything secret is replaced before it gets there.
 *
 * (`idp config validate` prints its own fixed summary and does not go through
 * this — it names `database.url` and passes it through `maskConnectionString`
 * directly. This file's only caller is the admin endpoint.)
 *
 * The rule is positional, not heuristic: a fixed list of pointers plus a
 * pattern for the per-provider and per-client secrets. A new secret-bearing key
 * has to be added here, which is exactly the review prompt we want.
 */

const MASK = "***"

/** Config pointers whose value must never be shown. */
const SECRET_POINTERS: readonly RegExp[] = [
  /^\/secret$/,
  /^\/database\/url$/,
  /^\/database\/directUrl$/,
  /^\/database\/sslCa$/,
  /^\/email\/resend\/apiKey$/,
  /^\/social\/[^/]+\/clientSecret$/,
  /^\/clients\/\d+\/clientSecret$/,
  // FR-GW-1: a gateway target is not a secret — the host is what an operator
  // came to this page to read — but userinfo in it would be, so it is masked
  // password-only, the way a connection string is.
  /^\/gateways\/[^/]+\/url$/,
]

/**
 * Secrets that are connection strings, masked password-only. Kept as a set
 * rather than a literal comparison because `directUrl` (D27) was added to the
 * config without being added here, and the single-pointer `===` check made that
 * omission invisible — the value fell through unmasked.
 */
const CONNECTION_STRING_POINTERS: ReadonlySet<string> = new Set([
  "/database/url",
  "/database/directUrl",
])

/**
 * The same treatment for a family of pointers whose keys the operator chooses.
 *
 * `gateways.<name>.url` cannot be listed by name, and it wants exactly what a
 * connection string wants: the host stays readable, the password does not.
 */
const CONNECTION_STRING_PATTERNS: readonly RegExp[] = [
  /^\/gateways\/[^/]+\/url$/,
]

export function isSecretPointer(pointer: string): boolean {
  return SECRET_POINTERS.some((pattern) => pattern.test(pointer))
}

/**
 * Returns a deep copy with every secret replaced by `***`. Connection strings
 * keep their shape — host and database name are operationally useful and are
 * not themselves secret — but the password is removed.
 */
export function maskConfig<T>(value: T): T {
  return maskValue(value, "") as T
}

function maskValue(value: unknown, pointer: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => maskValue(item, `${pointer}/${index}`))
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>
    )) {
      result[key] = maskValue(item, `${pointer}/${escapeSegment(key)}`)
    }
    return result
  }
  if (typeof value !== "string") return value
  if (!isSecretPointer(pointer)) return value
  if (
    CONNECTION_STRING_POINTERS.has(pointer) ||
    CONNECTION_STRING_PATTERNS.some((pattern) => pattern.test(pointer))
  )
    return maskConnectionString(value)
  return value === "" ? "" : MASK
}

/**
 * `postgres://user:pw@host/db` → `postgres://user:***@host/db`.
 *
 * Userinfo is the usual place, and not the only one: libpq's URI form also
 * accepts `password` and `sslpassword` as query parameters, so a connection
 * string with no `:pw@` in it can still carry one. Both are masked, by name,
 * for the same reason the pointer list is positional — a parameter nobody
 * added here is a parameter nobody thought about.
 *
 * Anything `URL` cannot parse is replaced wholesale rather than returned: a
 * string this cannot read is a string it cannot promise to have cleaned.
 */
const SECRET_QUERY_PARAMS = ["password", "sslpassword"] as const

export function maskConnectionString(value: string): string {
  try {
    const url = new URL(value)
    if (url.password !== "") url.password = MASK
    for (const name of SECRET_QUERY_PARAMS) {
      if (url.searchParams.has(name)) url.searchParams.set(name, MASK)
    }
    return url.toString()
  } catch {
    return MASK
  }
}

/**
 * A gateway target on its way to `/admin/gateways`, and **not normalized**.
 *
 * A gateway target is not a connection string, and passing one through
 * {@link maskConnectionString} was a bug rather than a shortcut: that function
 * ends in `url.toString()`, and `new URL("https://api.example.com").toString()`
 * is `"https://api.example.com/"`. `checkGatewayUrl` answers `trailing_slash`
 * for exactly that, so opening Edit on any gateway whose target is a bare
 * origin — the common shape, since the path is optional — and changing only a
 * checkbox produced a refusal about a slash the operator never typed.
 *
 * So the stored string is returned **verbatim** unless it actually carries a
 * password, which `checkGatewayUrl` refuses on write and can therefore only
 * reach the table by hand in `psql`. `masked` says which happened, because a
 * masked value is a lossy projection and `/idp/update-gateway` is a full
 * replace: the edit page refuses to prefill one rather than offering to store
 * `***` as the target.
 */
export function maskGatewayTarget(value: string): {
  url: string
  masked: boolean
} {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    // Unparseable, so nothing can be promised about it — the same answer
    // `maskConnectionString` gives, and for the same reason.
    return { url: MASK, masked: true }
  }
  if (url.password === "") return { url: value, masked: false }
  url.password = MASK
  return { url: url.toString(), masked: true }
}

function escapeSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1")
}
