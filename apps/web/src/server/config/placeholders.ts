/**
 * Placeholder grammar for config files (CFG-2, decision D18).
 *
 * Placeholders are expanded inside JSON **string values only** — never inside
 * keys — in a single, non-recursive pass that runs before schema validation.
 *
 * ```text
 *   ${env:NAME}              environment variable, required
 *   ${env:NAME:-default}     environment variable with a default when unset or empty
 *   ${file:/abs/path}        file contents, read once, one trailing newline trimmed
 *   $${                      escapes a literal "${"
 * ```
 *
 * `NAME` matches `[A-Z_][A-Z0-9_]*`. Un-namespaced `${VAR}` is rejected on
 * purpose: bare `${VAR}` collides with docker-compose's own interpolation and
 * has no file source. An unresolved variable without a default is an error that
 * names the file, the JSON pointer and the variable — **never** the value.
 *
 * A string consisting of exactly one placeholder is recorded in
 * {@link SubstitutionResult.placeholderPointers}; the schema layer then coerces
 * it to the declared type (`"true"` → `true`, `"42"` → `42`, `"[…]"` → array)
 * and the production-literal-secret check (CFG-5) uses the same set to tell a
 * real secret in a file apart from one injected from the environment.
 */

import type { ConfigFileName, ConfigIssue } from "./errors"
import { toPointer } from "./errors"

/** `[A-Z_][A-Z0-9_]*` — the only accepted environment variable name shape. */
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/

export interface SubstitutionEnvironment {
  /** Environment variables. Defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /** Reads a `${file:…}` source. Throws when the file cannot be read. */
  readFile?: (path: string) => string
  /** Decides whether a `${file:…}` path is absolute. Injectable for tests. */
  isAbsolutePath?: (path: string) => boolean
}

export interface SubstitutionResult<T = unknown> {
  value: T
  /**
   * Pointers whose entire value came from a single placeholder that resolved
   * from an environment variable or a secret file. This is the set the
   * production-literal-secret rule trusts — a value that fell back to an inline
   * `:-default` is literal text in the file and is deliberately absent.
   */
  placeholderPointers: Set<string>
  /**
   * Pointers whose entire value was a single placeholder, whatever it resolved
   * from. These are the ones the schema may coerce to a non-string type.
   */
  coercedPointers: Set<string>
  issues: ConfigIssue[]
}

interface Context {
  file: ConfigFileName
  env: Record<string, string | undefined>
  readFile: (path: string) => string
  isAbsolutePath: (path: string) => boolean
  fileCache: Map<string, string>
  placeholderPointers: Set<string>
  coercedPointers: Set<string>
  issues: ConfigIssue[]
}

/**
 * Expands every placeholder in `input`, returning a structurally new value.
 * Object keys are copied verbatim — the grammar never applies to them.
 */
export function substitutePlaceholders<T = unknown>(
  file: ConfigFileName,
  input: unknown,
  environment: SubstitutionEnvironment = {}
): SubstitutionResult<T> {
  const ctx: Context = {
    file,
    env: environment.env ?? process.env,
    readFile:
      environment.readFile ??
      ((path) => {
        throw new Error(`no file reader configured (wanted ${path})`)
      }),
    isAbsolutePath: environment.isAbsolutePath ?? defaultIsAbsolutePath,
    fileCache: new Map(),
    placeholderPointers: new Set(),
    coercedPointers: new Set(),
    issues: [],
  }

  const value = walk(ctx, input, []) as T
  return {
    value,
    placeholderPointers: ctx.placeholderPointers,
    coercedPointers: ctx.coercedPointers,
    issues: ctx.issues,
  }
}

function walk(
  ctx: Context,
  value: unknown,
  path: (string | number)[]
): unknown {
  if (typeof value === "string") return substituteString(ctx, value, path)
  if (Array.isArray(value))
    return value.map((item, index) => walk(ctx, item, [...path, index]))
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>
    )) {
      result[key] = walk(ctx, item, [...path, key])
    }
    return result
  }
  return value
}

interface Segment {
  text: string
  /** The segment came from a placeholder rather than surrounding literal text. */
  fromPlaceholder: boolean
  /**
   * The placeholder resolved from an actual environment variable or secret
   * file, not from its inline `:-default`. An inline default is literal text in
   * the config file, so it must not satisfy the production-secret rule (CFG-5).
   */
  fromSource: boolean
}

function substituteString(
  ctx: Context,
  input: string,
  path: (string | number)[]
): string {
  if (!input.includes("${") && !input.includes("$$")) return input

  const pointer = toPointer(path)
  const segments: Segment[] = []
  let literal = ""
  let index = 0

  const flushLiteral = () => {
    if (literal.length > 0) {
      segments.push({
        text: literal,
        fromPlaceholder: false,
        fromSource: false,
      })
      literal = ""
    }
  }

  while (index < input.length) {
    // "$${" escapes a literal "${".
    if (input.startsWith("$${", index)) {
      literal += "${"
      index += 3
      continue
    }

    if (input.startsWith("${", index)) {
      const end = input.indexOf("}", index + 2)
      if (end === -1) {
        addIssue(
          ctx,
          pointer,
          "Unterminated placeholder: no closing `}` found.",
          {
            hint: 'Write `${env:NAME}`, `${env:NAME:-default}` or `${file:/abs/path}`; use `$${` for a literal "${".',
          }
        )
        return input
      }
      const body = input.slice(index + 2, end)
      flushLiteral()
      const resolved = resolvePlaceholder(ctx, pointer, body)
      if (resolved === undefined) return input
      segments.push({
        text: resolved.text,
        fromPlaceholder: true,
        fromSource: resolved.fromSource,
      })
      index = end + 1
      continue
    }

    literal += input[index]
    index += 1
  }
  flushLiteral()

  if (segments.length === 1 && segments[0]!.fromPlaceholder) {
    ctx.coercedPointers.add(pointer)
    if (segments[0]!.fromSource) ctx.placeholderPointers.add(pointer)
  }
  // Single non-recursive pass: substituted text is never rescanned.
  return segments.map((segment) => segment.text).join("")
}

interface Resolution {
  text: string
  fromSource: boolean
}

/** Returns the replacement, or `undefined` when an issue was recorded. */
function resolvePlaceholder(
  ctx: Context,
  pointer: string,
  body: string
): Resolution | undefined {
  const separator = body.indexOf(":")
  const namespace = separator === -1 ? "" : body.slice(0, separator)
  const rest = separator === -1 ? "" : body.slice(separator + 1)

  if (namespace === "env") return resolveEnv(ctx, pointer, rest)
  if (namespace === "file") return resolveFile(ctx, pointer, rest)

  if (separator === -1 && ENV_NAME_RE.test(body)) {
    addIssue(
      ctx,
      pointer,
      `Un-namespaced placeholder \`\${${body}}\` is not supported.`,
      {
        hint: `Write \`\${env:${body}}\` — the namespace is required so the grammar cannot be confused with docker-compose interpolation.`,
      }
    )
    return undefined
  }

  addIssue(ctx, pointer, `Malformed placeholder \`\${${body}}\`.`, {
    hint: "Supported forms: `${env:NAME}`, `${env:NAME:-default}`, `${file:/abs/path}`.",
  })
  return undefined
}

function resolveEnv(
  ctx: Context,
  pointer: string,
  rest: string
): Resolution | undefined {
  const defaultMarker = rest.indexOf(":-")
  const name = defaultMarker === -1 ? rest : rest.slice(0, defaultMarker)
  const fallback =
    defaultMarker === -1 ? undefined : rest.slice(defaultMarker + 2)

  if (!ENV_NAME_RE.test(name)) {
    addIssue(
      ctx,
      pointer,
      `Invalid environment variable name \`${name}\` in placeholder.`,
      {
        hint: "Names must match [A-Z_][A-Z0-9_]* — upper case, starting with a letter or underscore.",
      }
    )
    return undefined
  }

  const raw = ctx.env[name]
  // Shell `:-` semantics: the default also applies to an empty value.
  if (raw !== undefined && raw !== "") return { text: raw, fromSource: true }
  if (fallback !== undefined) return { text: fallback, fromSource: false }

  addIssue(
    ctx,
    pointer,
    `Environment variable \`${name}\` is not set and has no default.`,
    {
      hint: `Set ${name}, or write \`\${env:${name}:-<default>}\`.`,
    }
  )
  return undefined
}

function resolveFile(
  ctx: Context,
  pointer: string,
  rawPath: string
): Resolution | undefined {
  const path = rawPath.trim()
  if (path === "") {
    addIssue(ctx, pointer, "Empty path in `${file:…}` placeholder.")
    return undefined
  }
  if (!ctx.isAbsolutePath(path)) {
    addIssue(ctx, pointer, `\`\${file:${path}}\` must use an absolute path.`, {
      hint: "Secret files are mounted at a known location, e.g. `${file:/run/secrets/idp_secret}`.",
    })
    return undefined
  }

  const cached = ctx.fileCache.get(path)
  if (cached !== undefined) return { text: cached, fromSource: true }

  try {
    // Content is read once and one trailing newline is trimmed, which is how
    // Docker and Kubernetes write secret files.
    const content = ctx.readFile(path).replace(/\r?\n$/, "")
    ctx.fileCache.set(path, content)
    return { text: content, fromSource: true }
  } catch {
    addIssue(ctx, pointer, `Cannot read secret file \`${path}\`.`, {
      hint: "Check that the file exists and is readable by the container user.",
    })
    return undefined
  }
}

function addIssue(
  ctx: Context,
  pointer: string,
  message: string,
  extra?: { hint?: string }
): void {
  ctx.issues.push({ file: ctx.file, pointer, message, hint: extra?.hint })
}

function defaultIsAbsolutePath(path: string): boolean {
  // POSIX absolute, or a Windows drive/UNC path so the loader also works on a
  // developer machine.
  return (
    path.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.startsWith("\\\\")
  )
}
