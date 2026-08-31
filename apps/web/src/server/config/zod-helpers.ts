/**
 * Shared zod building blocks for the three config schemas.
 *
 * Placeholder substitution (CFG-2) runs before validation and always produces
 * strings, so every non-string key accepts its string form too and coerces it
 * "to the schema type by strict JSON parsing". The escape hatch is invisible in
 * the exported JSON Schema (`io: "input"` renders the target type only), which
 * is what operators see in their editor.
 */

import { z } from "zod"

/** `true` / `false`, or the same as a placeholder-substituted string. */
export function flexBoolean() {
  return z.preprocess((value) => {
    if (typeof value !== "string") return value
    const trimmed = value.trim()
    if (trimmed === "true") return true
    if (trimmed === "false") return false
    return value
  }, z.boolean())
}

/** An integer, or the same as a placeholder-substituted string. */
export function flexInt(constraints: { min?: number; max?: number } = {}) {
  let schema = z.number().int()
  if (constraints.min !== undefined) schema = schema.min(constraints.min)
  if (constraints.max !== undefined) schema = schema.max(constraints.max)
  return z.preprocess((value) => {
    if (typeof value !== "string") return value
    const trimmed = value.trim()
    if (trimmed === "" || !/^-?\d+$/.test(trimmed)) return value
    return Number(trimmed)
  }, schema)
}

/** An array, or a placeholder-substituted JSON array literal. */
export function flexArray<T extends z.ZodType>(
  inner: T,
  constraints: { min?: number } = {}
) {
  let schema = z.array(inner)
  if (constraints.min !== undefined) schema = schema.min(constraints.min)
  return z.preprocess((value) => {
    if (typeof value !== "string") return value
    const trimmed = value.trim()
    if (!trimmed.startsWith("[")) return value
    try {
      return JSON.parse(trimmed) as unknown
    } catch {
      return value
    }
  }, schema)
}

/** An object, or a placeholder-substituted JSON object literal. */
export function flexRecord<T extends z.ZodType>(inner: T) {
  return z.preprocess(
    (value) => {
      if (typeof value !== "string") return value
      const trimmed = value.trim()
      if (!trimmed.startsWith("{")) return value
      try {
        return JSON.parse(trimmed) as unknown
      } catch {
        return value
      }
    },
    z.record(z.string(), inner)
  )
}

const DURATION_RE = /^(\d+)\s*(ms|s|m|h|d|w)$/
const DURATION_UNIT_SECONDS: Record<string, number> = {
  ms: 1 / 1000,
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
}

/**
 * Parses a duration into **seconds**. Accepts a plain number of seconds or a
 * `7d` / `15m` / `90d` style string, which is how the CFG-4 table writes them.
 */
export function parseDurationSeconds(
  value: string | number
): number | undefined {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed)
  const match = DURATION_RE.exec(trimmed)
  if (!match) return undefined
  const amount = Number(match[1])
  const unit = DURATION_UNIT_SECONDS[match[2]!]!
  return Math.round(amount * unit)
}

/** A duration in seconds, written as a number or a `7d`-style string. */
export function duration(constraints: { min?: number; max?: number } = {}) {
  return z.union([z.number(), z.string()]).transform((value, ctx) => {
    const seconds = parseDurationSeconds(value)
    if (seconds === undefined) {
      ctx.addIssue({
        code: "custom",
        message: `Invalid duration \`${String(value)}\`. Use seconds (\`3600\`) or a unit suffix (\`15m\`, \`7d\`).`,
      })
      return z.NEVER
    }
    if (constraints.min !== undefined && seconds < constraints.min) {
      ctx.addIssue({
        code: "custom",
        message: `Duration must be at least ${constraints.min}s.`,
      })
      return z.NEVER
    }
    if (constraints.max !== undefined && seconds > constraints.max) {
      ctx.addIssue({
        code: "custom",
        message: `Duration must be at most ${constraints.max}s.`,
      })
      return z.NEVER
    }
    return seconds
  })
}

/**
 * An absolute URI in **any** scheme, with no fragment and no trailing slash —
 * the RFC 8707 resource-identifier shape. `jwt.audience` and
 * `oauth.resources` take this rather than {@link absoluteUrl}: an audience is
 * an identifier compared byte-for-byte, never fetched, and a fixed URI like
 * `semantius://api` is exactly what keeps it independent of the issuer host —
 * an audience derived from a URL goes stale the moment the deployment is
 * reached under a new name.
 */
export function absoluteUri() {
  return z.string().superRefine((value, ctx) => {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      ctx.addIssue({
        code: "custom",
        message: `\`${value}\` is not an absolute URI.`,
      })
      return
    }
    if (url.hash !== "") {
      ctx.addIssue({
        code: "custom",
        message: `\`${value}\` must not contain a fragment.`,
      })
    }
    if (value.endsWith("/") && url.pathname === "/") {
      ctx.addIssue({
        code: "custom",
        message: `\`${value}\` must not end with a trailing slash.`,
      })
    }
  })
}

/**
 * An absolute http(s) URL with no trailing slash and no query/fragment — the
 * shape every issuer, redirect URI and resource identifier must have (SEC-1).
 */
export function absoluteUrl(options: { allowedProtocols?: string[] } = {}) {
  const protocols = options.allowedProtocols ?? ["http:", "https:"]
  return z.string().superRefine((value, ctx) => {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      ctx.addIssue({
        code: "custom",
        message: `\`${value}\` is not an absolute URL.`,
      })
      return
    }
    if (!protocols.includes(url.protocol)) {
      ctx.addIssue({
        code: "custom",
        message: `\`${value}\` must use ${protocols.map((p) => p.replace(":", "")).join(" or ")}.`,
      })
    }
    if (url.hash !== "") {
      ctx.addIssue({
        code: "custom",
        message: `\`${value}\` must not contain a fragment.`,
      })
    }
    if (value.endsWith("/") && url.pathname === "/") {
      ctx.addIssue({
        code: "custom",
        message: `\`${value}\` must not end with a trailing slash.`,
      })
    }
  })
}

/** Turns a zod issue path into a RFC 6901 JSON pointer. */
export function zodPathToPointer(path: readonly PropertyKey[]): string {
  if (path.length === 0) return ""
  return (
    "/" +
    path
      .map((segment) =>
        String(segment).replace(/~/g, "~0").replace(/\//g, "~1")
      )
      .join("/")
  )
}
