/**
 * Configuration error reporting (CFG-5).
 *
 * Every problem found while loading the config folder is collected as a
 * {@link ConfigIssue} so that **all** errors can be reported in one pass
 * instead of failing on the first one. Each issue names the file, a
 * RFC 6901 JSON pointer into that file, and an actionable message.
 */

export type ConfigFileName =
  | "config.json"
  | "oauth_clients.json"
  | "roles.json"
  | "(environment)"

export interface ConfigIssue {
  /** Which config file the problem is in. */
  file: ConfigFileName
  /** RFC 6901 JSON pointer, e.g. `/social/google/clientSecret`. Empty string = document root. */
  pointer: string
  /** What is wrong. Never contains a secret value. */
  message: string
  /** Optional "do this instead" hint. */
  hint?: string
}

export interface ConfigWarning {
  /** Stable identifier so tests can assert on a warning without matching prose. */
  code: string
  message: string
}

/**
 * Aggregated configuration failure. Thrown once, after every check has run,
 * so the operator sees the complete list rather than a trickle.
 */
export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[]

  constructor(issues: readonly ConfigIssue[]) {
    super(formatIssues(issues))
    this.name = "ConfigError"
    this.issues = issues
  }
}

export function formatIssues(issues: readonly ConfigIssue[]): string {
  if (issues.length === 0) return "Invalid configuration."
  const lines = issues.map((issue) => {
    const where =
      issue.pointer === "" ? issue.file : `${issue.file}${issue.pointer}`
    const hint = issue.hint ? `\n      hint: ${issue.hint}` : ""
    return `  - ${where}: ${issue.message}${hint}`
  })
  const plural = issues.length === 1 ? "problem" : "problems"
  return `Invalid configuration (${issues.length} ${plural}):\n${lines.join("\n")}`
}

/** Escapes one path segment for use in a RFC 6901 JSON pointer. */
export function pointerSegment(segment: string | number): string {
  return String(segment).replace(/~/g, "~0").replace(/\//g, "~1")
}

/** Joins path segments into a RFC 6901 JSON pointer. */
export function toPointer(path: readonly (string | number)[]): string {
  if (path.length === 0) return ""
  return "/" + path.map(pointerSegment).join("/")
}
