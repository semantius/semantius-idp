/**
 * Masking of the effective configuration (CFG-5, SEC-5).
 *
 * `idp config validate` and `/admin/system` both print the configuration the
 * process actually runs with. Anything secret is replaced before it can reach a
 * log line, a terminal or a browser.
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
  /^\/database\/sslCa$/,
  /^\/email\/resend\/apiKey$/,
  /^\/social\/[^/]+\/clientSecret$/,
  /^\/admin\/bootstrap\/password$/,
  /^\/clients\/\d+\/clientSecret$/,
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
  if (pointer === "/database/url") return maskConnectionString(value)
  return value === "" ? "" : MASK
}

/** `postgres://user:pw@host/db` → `postgres://user:***@host/db`. */
export function maskConnectionString(value: string): string {
  try {
    const url = new URL(value)
    if (url.password !== "") url.password = MASK
    return url.toString()
  } catch {
    return MASK
  }
}

function escapeSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1")
}
