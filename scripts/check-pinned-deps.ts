/**
 * Refuses floating dependency ranges anywhere in the workspace (SEC-9).
 *
 * The pinning policy is absolute: no `latest`, no `^`, no `~`, no `*`, no
 * ranges. Upgrades are deliberate, reviewed changelog entries — not something
 * that happens because someone re-ran `pnpm install` on a Tuesday.
 *
 * `pnpm.overrides` is covered too (D85): an override is what closes a
 * transitive advisory, and one written as a range would drift the same way.
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

interface Violation {
  file: string
  /** A dependency field, or `pnpm.overrides`. */
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
    // transitive advisory is closed (SEC-9, D85) -- and it sat outside this
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
  return violations
}

const violations = check()
if (violations.length > 0) {
  process.stderr.write(
    `Unpinned dependencies (${violations.length}):\n` +
      violations
        .map((v) => `  ${v.file} › ${v.field} › ${v.name}: "${v.spec}"`)
        .join("\n") +
      "\n\nEvery dependency must be pinned to an exact version (SEC-9).\n"
  )
  process.exit(1)
}

process.stdout.write("All dependencies are pinned exactly.\n")
