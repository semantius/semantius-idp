/**
 * Re-derives the contrast-critical tokens after a shadcn theme change.
 *
 * `packages/ui/src/styles/theme-a11y.css` corrects the preset's palette so that
 * form controls, focus indicators and secondary text clear WCAG AA. Every value
 * in it was derived against one preset's surfaces — the darkest being a
 * `bg-input/90` checkbox on the sidebar — so a different preset moves the
 * ground under them, and nothing guarantees they still clear anything.
 *
 * `pnpm test` says when that happened: `token-contrast.test.ts` recomputes the
 * whole matrix from whatever the stylesheets hold. This says what to write
 * instead. For each failing token it walks OKLCH lightness outward from the
 * current value, 0.001 at a time in both directions, and prints the nearest
 * value that clears every check — the smallest visible change that conforms.
 *
 *   bun run scripts/derive-a11y-tokens.ts [--check]
 *
 * It reads the palette as the browser resolves it, so it is right after a
 * preset apply without being edited, and it does not write the file: several
 * values carry a judgment — "keep it one hue with the preset", "leave a margin
 * over the floor" — that a script cannot make. `--check` exits 1 when any
 * token fails.
 *
 * Ported from semantius-app's `derive-a11y-tokens.mjs`, with two differences
 * that change answers. Every pair is measured with channels clipped *and* with
 * CSS gamut mapping, and must clear both; and a suggestion is written inside
 * sRGB, trading chroma the screen could not show anyway, so that it is one
 * color under either (`atLightness` in `palette.ts`).
 */

import {
  MAPPINGS,
  THEMES,
  atLightness,
  contrast,
  contrastUnder,
  oklchOf,
  palette,
  requirements,
} from "../src/tests/fixtures/palette"
import type { Check, Requirement } from "../src/tests/fixtures/palette"

const STEP = 0.001

/** The check this value clears by the least, as a fraction of its floor. */
function worst(
  candidate: string,
  checks: Check[]
): { check: Check; ratio: number; margin: number } {
  let found: { check: Check; ratio: number; margin: number } | undefined
  for (const check of checks) {
    const ratio = contrast(...check.pair(candidate))
    const margin = ratio / check.min
    if (!found || margin < found.margin) found = { check, ratio, margin }
  }
  if (!found) throw new Error("a requirement with no checks")
  return found
}

/**
 * The nearest lightness, either way, at which every check clears. Starts at
 * the current one: an out-of-gamut token can fail only because a clip paints
 * it darker than it is written, and in gamut it may already clear.
 */
function solve(requirement: Requirement, current: string): string | undefined {
  const [lightness] = oklchOf(current)
  for (let k = 0; k * STEP <= 1; k++) {
    for (const l of k === 0
      ? [lightness]
      : [lightness - k * STEP, lightness + k * STEP]) {
      if (l < 0 || l > 1) continue
      const candidate = atLightness(current, l)
      if (worst(candidate, requirement.checks).margin >= 1) return candidate
    }
  }
  return undefined
}

const checkOnly = process.argv.includes("--check")
const resolved = palette()
let failures = 0

console.log("Contrast-critical tokens, measured against the current palette —")
console.log(
  "globals.css with theme-a11y.css over it, the way app.css loads them.\n"
)

for (const theme of THEMES) {
  console.log(`\x1b[1m${theme} theme\x1b[0m`)
  for (const requirement of requirements(theme, resolved[theme])) {
    const current = resolved[theme][requirement.token]
    if (!current) {
      console.log(`  \x1b[31mFAIL\x1b[0m ${requirement.token} is not defined`)
      failures++
      continue
    }
    const { check, ratio, margin } = worst(current, requirement.checks)
    const [pairA, pairB] = check.pair(current)
    const both = MAPPINGS.map(
      (m) => `${m} ${contrastUnder(pairA, pairB, m).toFixed(2)}`
    ).join(", ")
    const mark = margin >= 1 ? "\x1b[32mOK  \x1b[0m" : "\x1b[31mFAIL\x1b[0m"
    console.log(
      `  ${mark} ${requirement.token.padEnd(28)} ${ratio.toFixed(2)}:1 (needs ${check.min}) — worst: ${check.name} [${both}]`
    )
    if (margin >= 1) continue
    failures++
    console.log(`       ${requirement.why}`)
    const fix = solve(requirement, current)
    console.log(
      fix
        ? `       \x1b[33msuggested:\x1b[0m ${requirement.token}: ${fix};`
        : "       \x1b[33mno lightness on this hue clears it\x1b[0m — the grounds " +
            "have to move, or the token needs another hue or chroma."
    )
  }
  console.log()
}

if (failures > 0) {
  console.log(
    `${failures} token(s) miss their floor. Edit packages/ui/src/styles/theme-a11y.css, ` +
      "then run this again and `pnpm --filter web test -- token-contrast`."
  )
}
process.exit(checkOnly && failures > 0 ? 1 : 0)
