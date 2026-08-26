/**
 * Configuration error reporting (CFG-5).
 *
 * Every problem found while loading the config folder is collected as a
 * {@link ConfigIssue} so that **all** errors can be reported in one pass
 * instead of failing on the first one. Each issue names the file, a
 * RFC 6901 JSON pointer into that file, and an actionable message.
 */

/**
 * The *logical* identity of a config file, not the name on disk.
 *
 * Since **D60** each file may be spelled `.jsonc` (canonical) or `.json`
 * (still accepted), so the two are no longer the same string. Retyping this
 * union through the five modules that carry it — and the two dozen literals in
 * the cross-checks that name a file — would have bought nothing but a wider
 * diff and a lost exhaustiveness check, so the union stays canonical and the
 * name the operator actually has is substituted once, where issues are
 * formatted, from {@link ResolvedFileNames}.
 */
export type ConfigFileName =
  | "config.json"
  | "oauth_clients.json"
  | "roles.json"
  | "(environment)"

/**
 * Logical name → the name the file was actually read under. An absent entry
 * falls back to the logical name, which is what a file that was never found —
 * or an `(environment)` issue, which has no file — needs.
 */
export type ResolvedFileNames = Partial<Record<ConfigFileName, string>>

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

  constructor(issues: readonly ConfigIssue[], names: ResolvedFileNames = {}) {
    super(formatIssues(issues, names))
    this.name = "ConfigError"
    this.issues = issues
  }
}

export function formatIssues(
  issues: readonly ConfigIssue[],
  names: ResolvedFileNames = {}
): string {
  if (issues.length === 0) return "Invalid configuration."
  const lines = issues.map((issue) => {
    // The operator has to be able to open what this names, so it is the file
    // on disk — `config.jsonc` or `config.json`, whichever was read (D60).
    const file = names[issue.file] ?? issue.file
    const where = issue.pointer === "" ? file : `${file}${issue.pointer}`
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
