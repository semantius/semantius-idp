/**
 * Structured logging (SEC-5).
 *
 * One JSON object per line on stdout, or a readable form for development.
 * Hand-rolled rather than pulled from a library because the redaction rules are
 * the point: the list of things that must never reach a log line is a security
 * requirement, and it is enforced here, once, for every call site.
 *
 * Never logged: passwords, tokens, authorization codes, secrets, reset and
 * verification links, `Authorization` and `Cookie` headers, and the query
 * strings of `/oauth2/*` and `/api/auth/*`.
 */

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error"] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
}

export type LogFields = Record<string, unknown>

export interface Logger {
  trace: (message: string, fields?: LogFields) => void
  debug: (message: string, fields?: LogFields) => void
  info: (message: string, fields?: LogFields) => void
  warn: (message: string, fields?: LogFields) => void
  error: (message: string, fields?: LogFields) => void
  /** Returns a logger that stamps `fields` onto every record — e.g. a request id. */
  child: (fields: LogFields) => Logger
}

export interface CreateLoggerOptions {
  level?: LogLevel
  format?: "json" | "pretty"
  /** Where records go. Injected by tests; defaults to stdout/stderr. */
  write?: (line: string, level: LogLevel) => void
  /** Injected by tests so records are deterministic. */
  now?: () => Date
  base?: LogFields
}

/**
 * Field names whose value is replaced wholesale, wherever they appear.
 * Matched case-insensitively against the key.
 */
const REDACTED_KEYS = [
  "password",
  "newpassword",
  "currentpassword",
  "secret",
  "clientsecret",
  "apikey",
  "api_key",
  "token",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "idtoken",
  "id_token",
  "code",
  "codeverifier",
  "code_verifier",
  "authorization",
  "cookie",
  "setcookie",
  "set-cookie",
  "sessiontoken",
  "session_token",
  "privatekey",
  "backupcodes",
  "totp",
  "url", // verification and reset links
  "link",
]

const REDACTION = "[redacted]"

/** Paths whose query string is stripped before a URL is logged (SEC-5). */
/**
 * Paths whose query string is dropped wholesale (SEC-5).
 *
 * Matched **anywhere in the path**, not only at the start, because under a
 * sub-path deployment the protocol endpoints are at `/idp/oauth2/...` — and a
 * prefix check would have quietly logged every authorization code the moment
 * the mount path was set (OPS-10).
 *
 * The list covers more than SEC-5 names literally, and each addition is a
 * parameter that is a credential in its own right:
 *
 *  - `/reset-password` and `/verify-email` carry single-use tokens;
 *  - `/change-password`, `/login`, `/two-factor` and `/consent` carry the
 *    signed `oauth_query` continuation, which is a bearer of the whole
 *    authorization request (FR-OIDC-9).
 *
 * Dropping the whole query rather than naming sensitive parameters is
 * deliberate: the set of parameters grows with every plugin, and a redaction
 * list that has to be maintained is one that will be out of date.
 */
const SENSITIVE_PATH_SEGMENTS = [
  "/oauth2/",
  "/api/auth/",
  "/reset-password",
  "/verify-email",
  "/change-password",
  "/two-factor",
  "/consent",
  "/login",
]

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const level = options.level ?? "info"
  const format = options.format ?? "json"
  const now = options.now ?? (() => new Date())
  const write =
    options.write ??
    ((line: string, recordLevel: LogLevel) => {
      const stream =
        LEVEL_ORDER[recordLevel] >= LEVEL_ORDER.error
          ? process.stderr
          : process.stdout
      stream.write(line + "\n")
    })

  function make(base: LogFields): Logger {
    const emit = (
      recordLevel: LogLevel,
      message: string,
      fields?: LogFields
    ) => {
      if (LEVEL_ORDER[recordLevel] < LEVEL_ORDER[level]) return
      const record: LogFields = {
        time: now().toISOString(),
        level: recordLevel,
        msg: message,
        ...redactFields(base),
        ...redactFields(fields ?? {}),
      }
      write(
        format === "json" ? JSON.stringify(record) : formatPretty(record),
        recordLevel
      )
    }

    return {
      trace: (message, fields) => emit("trace", message, fields),
      debug: (message, fields) => emit("debug", message, fields),
      info: (message, fields) => emit("info", message, fields),
      warn: (message, fields) => emit("warn", message, fields),
      error: (message, fields) => emit("error", message, fields),
      child: (fields) => make({ ...base, ...fields }),
    }
  }

  return make(options.base ?? {})
}

/** Replaces every secret-bearing value in `fields`, recursively. */
export function redactFields(fields: LogFields): LogFields {
  return redactValue(fields, 0) as LogFields
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > 6) return "[deep]"
  if (Array.isArray(value))
    return value.map((item) => redactValue(item, depth + 1))
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack }
  }
  if (value instanceof Date) return value.toISOString()
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>
    )) {
      result[key] = isRedactedKey(key)
        ? REDACTION
        : redactValue(item, depth + 1)
    }
    return result
  }
  return value
}

function isRedactedKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_]/g, "")
  return REDACTED_KEYS.some(
    (candidate) => candidate.replace(/[-_]/g, "") === normalized
  )
}

/**
 * Makes a URL safe to log: the query string of a protocol endpoint carries
 * codes, tokens and `login_hint`, so it is dropped entirely rather than
 * filtered key by key.
 */
export function safeUrlForLog(url: string): string {
  try {
    const parsed = new URL(url, "http://placeholder.invalid")
    const path = parsed.pathname
    if (
      SENSITIVE_PATH_SEGMENTS.some((segment) => path.includes(segment)) &&
      parsed.search !== ""
    ) {
      return `${path}?[redacted]`
    }
    return parsed.search === "" ? path : `${path}${parsed.search}`
  } catch {
    return "[unparseable]"
  }
}

/**
 * Anonymises a client IP for logging (SEC-5): the last octet of an IPv4 address
 * and everything below the /64 of an IPv6 address are dropped, which keeps the
 * value useful for rate-limit forensics without storing a personal identifier.
 */
export function anonymizeIp(ip: string | null | undefined): string | undefined {
  if (!ip) return undefined
  const trimmed = ip.trim()
  if (trimmed === "") return undefined
  if (trimmed.includes(":")) {
    const groups = trimmed.split(":")
    return groups.slice(0, 4).join(":") + "::"
  }
  const octets = trimmed.split(".")
  if (octets.length !== 4) return undefined
  return `${octets[0]}.${octets[1]}.${octets[2]}.0`
}

function formatPretty(record: LogFields): string {
  const { time, level, msg, ...rest } = record as {
    time: string
    level: string
    msg: string
  } & LogFields
  const restText =
    Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : ""
  return `${time} ${level.toUpperCase().padEnd(5)} ${msg}${restText}`
}
