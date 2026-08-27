/**
 * Refuses a Bun version that disagrees with itself (OPS-1, SEC-9).
 *
 * Bun is not a build tool here — it is **the runtime**. The final image is
 * `oven/bun:<version>-slim` with Bun as PID 1, the CLI and the server are
 * bundled with `--target=bun`, and the health check is a Bun one-liner. That
 * makes the version a property of the artefact, not of somebody's toolchain,
 * and it is written down in five places:
 *
 *   .bun-version                       the source of truth
 *   package.json engines.bun           what a contributor is told to install
 *   docker/Dockerfile ARG BUN_VERSION  the runtime base image, per architecture
 *   .github/workflows/ci.yml           the Bun that runs the gates
 *   .github/workflows/release.yml      the Bun that runs the smoke test
 *
 * Nothing checked that they agreed until a release workflow added the fifth
 * copy by hand (**D73**). Drift here is quiet and specific: the smoke test
 * would pass on one Bun while the image shipped another, and the difference
 * only shows up as a runtime failure in a deployment nobody can reproduce —
 * on **arm64**, where Bun is a different binary altogether.
 *
 *   bun run scripts/check-bun-version.ts
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const read = (relative: string): string =>
  readFileSync(join(ROOT, relative), "utf8")

/** The source of truth. Everything else is checked against this. */
const expected = read(".bun-version").trim()

if (!/^\d+\.\d+\.\d+$/.test(expected)) {
  console.error(
    `.bun-version is not an exact version: ${expected || "(empty)"}`
  )
  process.exit(1)
}

interface Pin {
  file: string
  what: string
  /** The version each file declares, or `null` when the pattern is gone. */
  found: string | null
}

/**
 * Each pattern is deliberately narrow. A loose one that stops matching would
 * report `null` — "the pin is missing" — rather than silently passing, which
 * is the failure mode a checker like this has to refuse to have.
 */
const first = (source: string, pattern: RegExp): string | null =>
  pattern.exec(source)?.[1] ?? null

const pins: Pin[] = [
  {
    file: "package.json",
    what: "engines.bun",
    // `>=` is intentional there — a contributor may run newer — so only the
    // floor is compared.
    found: first(read("package.json"), /"bun":\s*">=(\d+\.\d+\.\d+)"/),
  },
  {
    file: "docker/Dockerfile",
    what: "ARG BUN_VERSION",
    found: first(read("docker/Dockerfile"), /^ARG BUN_VERSION=(\S+)/m),
  },
  {
    file: ".github/workflows/ci.yml",
    what: "env.BUN_VERSION",
    found: first(read(".github/workflows/ci.yml"), /BUN_VERSION:\s*"(\S+)"/),
  },
  {
    file: ".github/workflows/release.yml",
    what: "env.BUN_VERSION",
    found: first(
      read(".github/workflows/release.yml"),
      /BUN_VERSION:\s*"(\S+)"/
    ),
  },
]

const wrong = pins.filter((pin) => pin.found !== expected)

if (wrong.length > 0) {
  console.error(`.bun-version says ${expected}. These disagree:\n`)
  for (const pin of wrong) {
    console.error(
      `  ${pin.file} (${pin.what}): ${pin.found ?? "no pin found — has the line moved?"}`
    )
  }
  console.error(
    `\nBun is this image's runtime, not a build tool. Update every copy together.`
  )
  process.exit(1)
}

console.log(`Bun is pinned to ${expected} in all ${pins.length + 1} places.`)
