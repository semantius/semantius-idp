/**
 * Refuses floating dependency ranges anywhere in the workspace.
 *
 * The pinning policy is absolute: no `latest`, no `^`, no `~`, no `*`, no
 * ranges. Upgrades are deliberate, reviewed changelog entries — not something
 * that happens because someone re-ran `pnpm install` on a Tuesday.
 *
 * `pnpm.overrides` is covered too: an override is what closes a
 * transitive advisory, and one written as a range would drift the same way.
 *
 * So are the `uses:` references in `.github/workflows/*.yml`: an action
 * named by a tag is a dependency whose version somebody else controls. A tag
 * can be moved to a different commit, and it can be deleted — `setup-trivy`'s
 * `v0.2.1` was, out from under a build. Only a commit SHA is an exact
 * version of an action, so only a SHA passes here; the tag it was resolved
 * from rides along in a trailing comment, for the reader and not for this
 * check.
 *
 *   bun run scripts/check-pinned-deps.ts
 */

import { readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, sep } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const

/** An exact semver version: `1.2.3`, `1.2.3-beta.4`, `1.2.3+build`. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** Protocols that are pinned by nature and carry no range. */
const ALLOWED_PROTOCOLS = ["workspace:", "link:", "file:", "catalog:", "patch:"]

/** A full-length git commit SHA — the one action ref nobody can move. */
const COMMIT_SHA = /^[0-9a-f]{40}$/

/**
 * `uses: owner/repo@ref` or `uses: owner/repo/path@ref`, quoted or not. A
 * local action (`./.github/actions/x`) has no `@` and nothing to pin, and a
 * `docker://image:tag` reference is not used in this repository; neither
 * matches, and neither should.
 */
const USES_REFERENCE = /^\s*-?\s*uses:\s*["']?([^\s"'@]+)@([^\s"'#]+)/

interface Violation {
  file: string
  /** A dependency field, `pnpm.overrides`, or `uses`. */
  field: string
  name: string
  spec: string
}

/** Repository-relative and with forward slashes, for the report. */
function relativePath(path: string): string {
  return path.slice(ROOT.length + 1).split(sep).join("/")
}

function packageJsonPaths(): string[] {
  const paths = [join(ROOT, "package.json")]
  for (const group of ["apps", "packages"]) {
    const dir = join(ROOT, group)
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const candidate = join(dir, entry, "package.json")
      try {
        if (statSync(candidate).isFile()) paths.push(candidate)
      } catch {
        // Not a workspace package; skip.
      }
    }
  }
  return paths
}

function workflowPaths(): string[] {
  const dir = join(ROOT, ".github", "workflows")
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  return entries
    .filter((entry) => /\.ya?ml$/.test(entry))
    .map((entry) => join(dir, entry))
}

function check(): Violation[] {
  const violations: Violation[] = []
  for (const path of packageJsonPaths()) {
    const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      Record<string, string> | undefined
    >
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
        if (ALLOWED_PROTOCOLS.some((protocol) => spec.startsWith(protocol))) {
          continue
        }
        if (EXACT_VERSION.test(spec)) continue
        violations.push({
          file: relativePath(path),
          field,
          name,
          spec,
        })
      }
    }

    // `pnpm.overrides` is a dependency decision like any other -- it is how a
    // transitive advisory is closed -- and it sat outside this
    // check until the first one existed. The *key* carries a range on purpose
    // (`brace-expansion@1`, `parent>child`); it is the resolved version on
    // the right that has to be exact, and a range there would drift exactly
    // like a floating dependency.
    const pnpmSection = manifest.pnpm as
      | { overrides?: Record<string, string> }
      | undefined
    for (const [name, spec] of Object.entries(pnpmSection?.overrides ?? {})) {
      if (ALLOWED_PROTOCOLS.some((protocol) => spec.startsWith(protocol))) {
        continue
      }
      if (EXACT_VERSION.test(spec)) continue
      violations.push({
        file: relativePath(path),
        field: "pnpm.overrides",
        name,
        spec,
      })
    }
  }

  // A workflow's `uses:` is a dependency too, and the one class this check
  // did not read while it was the only pinning gate the repository had. A
  // `@v4` is a range in all but spelling -- it resolves to whatever the
  // publisher points it at today -- and an exact tag (`@v0.36.0`) is not
  // much better, because a tag is a ref and refs move. Line by
  // line rather than through a YAML parser: the reference is the only thing
  // being read, and a parser is a dependency this script would then have to
  // pin.
  for (const path of workflowPaths()) {
    const lines = readFileSync(path, "utf8").split(/\r?\n/)
    for (const line of lines) {
      const match = USES_REFERENCE.exec(line)
      if (!match) continue
      const [, name, ref] = match as unknown as [string, string, string]
      if (COMMIT_SHA.test(ref)) continue
      violations.push({
        file: relativePath(path),
        field: "uses",
        name,
        spec: ref,
      })
    }
  }
  return violations
}

const violations = check()
if (violations.length > 0) {
  process.stderr.write(
    `Unpinned dependencies (${violations.length}):\n` +
      violations
        .map((v) => `  ${v.file} › ${v.field} › ${v.name}: "${v.spec}"`)
        .join("\n") +
      "\n\nEvery dependency must be pinned to an exact version, and every workflow action to a commit SHA.\n"
  )
  process.exit(1)
}

process.stdout.write("All dependencies are pinned exactly.\n")
