/**
 * The palette as the browser resolves it, and the WCAG arithmetic on it.
 *
 * Two readers, one list. `unit/token-contrast.test.ts` asserts every pair in
 * `requirements()`, and `scripts/derive-a11y-tokens.ts` prints the value a
 * failing token needs, so the script can never suggest a value the test would
 * refuse. The structure follows semantius-app's `tokenContrast.test.ts` and
 * `derive-a11y-tokens.mjs`, which duplicated the list between the two and had
 * to say "keep it in step" in both.
 *
 * **It parses the real stylesheets.** A test that carries its own copy of the
 * palette passes forever after somebody edits the palette; the point is to fail
 * the moment a token moves, including when `shadcn apply --preset` moves it.
 *
 * **Every pair is measured twice and must clear its floor both times.** Several
 * of the preset's `oklch()` values are outside sRGB — its reds, its greens, the
 * chart ramp — and there are two ways to bring one back in. axe-core, which is
 * the e2e gate (TST-6), *clips* each channel (`parseString` in axe-core 4.13:
 * `toGamut({ space: "srgb", method: "clip" })`). The CSS Color 4 algorithm
 * *maps* — it lowers chroma until the clip is within a just-noticeable
 * difference — and that is what colorjs.io's `toGamut({ method: "css" })` does
 * and what semantius-app derived its values with. On the saturated reds the two
 * differ by up to half a ratio point, and not always in the same direction:
 * semantius-app's dark `--destructive` clears its hover tint by 0.003 under the
 * mapping and misses it by 0.34 under the clip. A value that clears both is
 * right whichever a renderer or a checker does.
 *
 * **The color math is here, not a dependency.** It is the CSS Color 4 sample
 * code with colorjs.io's matrices. When it was written it agreed with
 * colorjs.io 0.7.1 to 3e-8 in every channel and 6e-9 in every ratio, under both
 * mappings, over the palette and 2,000 random colors, about 70 % of them out of
 * gamut; the reference values in the test pin that. colorjs.io is not
 * installed because a devDependency ships: the image's `node_modules` is the
 * whole virtual store (`docker/Dockerfile`, D86), and its prune list removes
 * tooling by name.
 */

import { readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = join(HERE, "..", "..", "..")
const UI = join(WEB, "..", "..", "packages", "ui")

export const PATHS = {
  /** What `__root.tsx` loads. It composes the two below, in that order. */
  entry: join(UI, "src", "styles", "app.css"),
  /** Stock `shadcn` output. The CLI's `tailwind.css` target. */
  globals: join(UI, "src", "styles", "globals.css"),
  /** This project's corrections to it. The CLI does not know it exists. */
  a11y: join(UI, "src", "styles", "theme-a11y.css"),
  rootRoute: join(WEB, "src", "routes", "__root.tsx"),
  uiPackage: join(UI, "package.json"),
  components: join(UI, "src", "components"),
  webSource: join(WEB, "src"),
}

export type Theme = "light" | "dark"
export const THEMES: Theme[] = ["light", "dark"]

/** 1.4.11 — user-interface components and graphical objects. */
export const NON_TEXT = 3
/** 1.4.3 — body text. */
export const TEXT = 4.5

export function read(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n")
}

// ---------------------------------------------------------------- the CSS ---

type Item =
  | { kind: "import"; specifier: string }
  | { kind: "rule"; prelude: string; body: string }

/**
 * The top level of a stylesheet, in source order: `@import` statements and
 * rules. Comments go first, so a `:root` mentioned in prose is never taken for
 * one, and strings are stepped over, because `@source "…/*.{ts,tsx}"` has
 * braces in it.
 */
function scan(css: string): Item[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "")
  const items: Item[] = []
  let depth = 0
  let from = 0
  let bodyFrom = 0
  let prelude = ""
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (ch === '"' || ch === "'") {
      const close = src.indexOf(ch, i + 1)
      i = close === -1 ? src.length : close
    } else if (ch === "{") {
      if (depth === 0) {
        prelude = src.slice(from, i).trim()
        bodyFrom = i + 1
      }
      depth++
    } else if (ch === "}") {
      depth--
      if (depth === 0) {
        items.push({ kind: "rule", prelude, body: src.slice(bodyFrom, i) })
        from = i + 1
      }
    } else if (ch === ";" && depth === 0) {
      const specifier = /^@import\s+["']([^"']+)["']/.exec(
        src.slice(from, i).trim()
      )?.[1]
      if (specifier) items.push({ kind: "import", specifier })
      from = i + 1
    }
  }
  return items
}

export interface PlacedRule {
  file: string
  prelude: string
  body: string
}

/**
 * Every rule the entry reaches, in the order the browser receives them.
 * Tailwind inlines each `@import` where it stands, so a relative one is
 * followed in place; a package one (`tailwindcss`, the font) contributes no
 * palette token and is not.
 */
export function rulesInOrder(file: string = PATHS.entry): PlacedRule[] {
  const out: PlacedRule[] = []
  for (const item of scan(read(file))) {
    if (item.kind === "rule") {
      out.push({ file, prelude: item.prelude, body: item.body })
    } else if (item.specifier.startsWith(".")) {
      out.push(...rulesInOrder(resolve(dirname(file), item.specifier)))
    }
  }
  return out
}

export function declarations(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const match of `${body};`.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    const [, name, value] = match
    if (name && value) out[name] = value.trim()
  }
  return out
}

/**
 * The palette per theme, resolved the way the cascade resolves it.
 *
 * Every token block — `globals.css`'s `:root` and `.dark`, then
 * `theme-a11y.css`'s — is an unlayered selector of specificity (0,1,0), and on
 * the dark theme `<html class="dark">` matches all of them. So the last
 * declaration in source order wins across the lot; it is **not** `.dark`
 * layered over `:root`. A token that `theme-a11y.css` sets in `:root` alone
 * therefore replaces the stock *dark* value too. semantius-app shipped exactly
 * that once — a light-mode placeholder ink on the dark theme, 2.72:1 — while a
 * test that layered `.dark` over `:root` passed it at 5.49:1.
 */
export function palette(): Record<Theme, Record<string, string>> {
  const light: Record<string, string> = {}
  const dark: Record<string, string> = {}
  for (const rule of rulesInOrder()) {
    if (rule.prelude === ":root") {
      Object.assign(light, declarations(rule.body))
      Object.assign(dark, declarations(rule.body))
    } else if (rule.prelude === ".dark") {
      Object.assign(dark, declarations(rule.body))
    }
  }
  return { light, dark }
}

/** The token names one file sets, per theme block. */
export function tokensSetBy(file: string): Record<Theme, string[]> {
  const light = new Set<string>()
  const dark = new Set<string>()
  for (const item of scan(read(file))) {
    if (item.kind !== "rule") continue
    const names = Object.keys(declarations(item.body))
    if (item.prelude === ":root") names.forEach((name) => light.add(name))
    if (item.prelude === ".dark") names.forEach((name) => dark.add(name))
  }
  return { light: [...light].sort(), dark: [...dark].sort() }
}

/** Every `--color-*` mapping across all `@theme` blocks the entry reaches. */
export function themeColorMappings(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rule of rulesInOrder()) {
    if (rule.prelude.startsWith("@theme")) {
      for (const [name, value] of Object.entries(declarations(rule.body))) {
        if (name.startsWith("--color-")) out[name] = value
      }
    }
  }
  return out
}

/** Every `.ts`/`.tsx` file under a directory, recursively. */
export function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
}

// ---------------------------------------------------------------- color ---

type Vec3 = [number, number, number]
type Matrix = [Vec3, Vec3, Vec3]

/** Which of the two out-of-gamut treatments a measurement uses. See the top. */
export type Mapping = "clip" | "css"
export const MAPPINGS: Mapping[] = ["clip", "css"]

// colorjs.io's matrices, which are the CSS Color 4 sample code's.
const LINEAR_SRGB_TO_XYZ: Matrix = [
  [0.41239079926595934, 0.357584339383878, 0.1804807884018343],
  [0.21263900587151027, 0.715168678767756, 0.07219231536073371],
  [0.01933081871559182, 0.11919477979462598, 0.9505321522496607],
]
const XYZ_TO_LINEAR_SRGB: Matrix = [
  [3.2409699419045226, -1.537383177570094, -0.4986107602930034],
  [-0.9692436362808796, 1.8759675015077202, 0.04155505740717559],
  [0.05563007969699366, -0.20397695888897652, 1.0569715142428786],
]
const XYZ_TO_LMS: Matrix = [
  [0.819022437996703, 0.3619062600528904, -0.1288737815209879],
  [0.0329836539323885, 0.9292868615863434, 0.0361446663506424],
  [0.0481771893596242, 0.2642395317527308, 0.6335478284694309],
]
const LMS_TO_XYZ: Matrix = [
  [1.2268798758459243, -0.5578149944602171, 0.2813910456659647],
  [-0.0405757452148008, 1.112286803280317, -0.0717110580655164],
  [-0.0763729366746601, -0.4214933324022432, 1.5869240198367816],
]
const LMS_TO_OKLAB: Matrix = [
  [0.210454268309314, 0.7936177747023054, -0.0040720430116193],
  [1.9779985324311684, -2.4285922420485799, 0.450593709617411],
  [0.0259040424655478, 0.7827717124575296, -0.8086757549230774],
]
const OKLAB_TO_LMS: Matrix = [
  [1, 0.3963377773761749, 0.2158037573099136],
  [1, -0.1055613458156586, -0.0638541728258133],
  [1, -0.0894841775298119, -1.2914855480194092],
]

function multiply(m: Matrix, v: Vec3): Vec3 {
  const row = (r: Vec3) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]
  return [row(m[0]), row(m[1]), row(m[2])]
}

const map3 = (v: Vec3, f: (c: number) => number): Vec3 => [
  f(v[0]),
  f(v[1]),
  f(v[2]),
]

function toLinear(c: number): number {
  const abs = Math.abs(c)
  return abs <= 0.04045
    ? c / 12.92
    : Math.sign(c) * ((abs + 0.055) / 1.055) ** 2.4
}

function toGamma(c: number): number {
  const abs = Math.abs(c)
  return abs > 0.0031308
    ? Math.sign(c) * (1.055 * abs ** (1 / 2.4) - 0.055)
    : 12.92 * c
}

function oklchToOklab([l, c, h]: Vec3): Vec3 {
  const radians = (h * Math.PI) / 180
  return [l, c * Math.cos(radians), c * Math.sin(radians)]
}

function oklabToOklch([l, a, b]: Vec3): Vec3 {
  const hue = (Math.atan2(b, a) * 180) / Math.PI
  return [l, Math.hypot(a, b), hue < 0 ? hue + 360 : hue]
}

/** OKLab to gamma-encoded sRGB, unbounded — out of gamut is < 0 or > 1. */
function oklabToSrgb(lab: Vec3): Vec3 {
  const lms = map3(multiply(OKLAB_TO_LMS, lab), (c) => c ** 3)
  return map3(multiply(XYZ_TO_LINEAR_SRGB, multiply(LMS_TO_XYZ, lms)), toGamma)
}

function srgbToOklab(rgb: Vec3): Vec3 {
  const xyz = multiply(LINEAR_SRGB_TO_XYZ, map3(rgb, toLinear))
  return multiply(LMS_TO_OKLAB, map3(multiply(XYZ_TO_LMS, xyz), Math.cbrt))
}

const inGamut = (rgb: Vec3) => rgb.every((c) => c >= 0 && c <= 1)
const clip = (rgb: Vec3) => map3(rgb, (c) => Math.min(1, Math.max(0, c)))

function deltaEOK(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

/**
 * CSS Color 4 §13.2's gamut mapping — binary search on chroma, keeping
 * lightness and hue, until the clipped color is within a just-noticeable
 * difference of the unclipped one. colorjs.io's `toGamutCSS`, step for step.
 */
function cssGamutMap(lch: Vec3): Vec3 {
  const JND = 0.02
  const EPSILON = 0.0001
  if (lch[0] >= 1) return [1, 1, 1]
  if (lch[0] <= 0) return [0, 0, 0]
  const at = (chroma: number): Vec3 => [lch[0], chroma, lch[2]]
  const srgbAt = (chroma: number) => oklabToSrgb(oklchToOklab(at(chroma)))
  if (inGamut(srgbAt(lch[1]))) return srgbAt(lch[1])

  const distance = (chroma: number, clipped: Vec3) =>
    deltaEOK(srgbToOklab(clipped), oklchToOklab(at(chroma)))

  let clipped = clip(srgbAt(lch[1]))
  if (distance(lch[1], clipped) < JND) return clipped

  let min = 0
  let max = lch[1]
  let minInGamut = true
  while (max - min > EPSILON) {
    const chroma = (min + max) / 2
    if (minInGamut && inGamut(srgbAt(chroma))) {
      min = chroma
      continue
    }
    clipped = clip(srgbAt(chroma))
    const e = distance(chroma, clipped)
    if (e < JND) {
      if (JND - e < EPSILON) break
      minInGamut = false
      min = chroma
    } else {
      max = chroma
    }
  }
  return clipped
}

interface Parsed {
  /** OKLCH for an `oklch()`, gamma-encoded sRGB for a hex value. */
  space: "oklch" | "srgb"
  coords: Vec3
  alpha: number
}

function number(token: string, percentOf: number): number {
  const value = token.endsWith("%")
    ? (Number(token.slice(0, -1)) / 100) * percentOf
    : Number(token.replace(/deg$/, ""))
  if (!Number.isFinite(value)) throw new Error(`not a number: "${token}"`)
  return value
}

/**
 * The two syntaxes the palette uses. Anything else throws rather than being
 * measured as something it is not — a preset that starts writing `lab()` should
 * fail this loudly, not pass it quietly.
 */
function parse(value: string): Parsed {
  const v = value.trim().toLowerCase()
  const hex = /^#([0-9a-f]{6})$/.exec(v)?.[1]
  if (hex) {
    const channel = (i: number) => parseInt(hex.slice(i, i + 2), 16) / 255
    return {
      space: "srgb",
      coords: [channel(0), channel(2), channel(4)],
      alpha: 1,
    }
  }
  const args = /^oklch\(([^)]*)\)$/.exec(v)?.[1]
  if (args) {
    const [channels = "", alpha] = args.split("/")
    const [l, c, h, ...rest] = channels.trim().split(/\s+/)
    if (l && c && h && rest.length === 0) {
      return {
        space: "oklch",
        coords: [number(l, 1), number(c, 0.4), number(h, 1)],
        alpha: alpha === undefined ? 1 : number(alpha.trim(), 1),
      }
    }
  }
  throw new Error(
    `palette: cannot measure "${value}" — teach parse() its syntax`
  )
}

/** A CSS color as sRGB, brought into gamut the way `mapping` says. */
export function toSrgb(
  value: string,
  mapping: Mapping
): { rgb: Vec3; alpha: number } {
  const parsed = parse(value)
  if (parsed.space === "srgb")
    return { rgb: parsed.coords, alpha: parsed.alpha }
  const rgb =
    mapping === "clip"
      ? clip(oklabToSrgb(oklchToOklab(parsed.coords)))
      : cssGamutMap(parsed.coords)
  return { rgb, alpha: parsed.alpha }
}

/**
 * A color as CSS writes it, or one composited over another — kept symbolic so
 * that every conversion in a measurement happens under the same mapping.
 *
 * `{ paint, alpha, over }` is what a Tailwind `bg-x/50` resolves to: the
 * utility is `color-mix(in oklab, var(--x) 50%, transparent)`, which is the
 * token at half its alpha, and the browser blends that over the ground in sRGB.
 * `alpha` multiplies any the token already carries — the dark theme's `--input`
 * is `oklch(1 0 0 / 15%)`, so `bg-input/50` is 7.5 % white.
 */
export type Paint = string | { paint: Paint; alpha: number; over: Paint }

export function tint(paint: Paint, alpha: number, over: Paint): Paint {
  return { paint, alpha, over }
}

export function resolvePaint(paint: Paint, mapping: Mapping): Vec3 {
  if (typeof paint !== "string") {
    const ground = resolvePaint(paint.over, mapping)
    const src =
      typeof paint.paint === "string"
        ? toSrgb(paint.paint, mapping)
        : { rgb: resolvePaint(paint.paint, mapping), alpha: 1 }
    const a = src.alpha * paint.alpha
    return [0, 1, 2].map(
      (i) => (src.rgb[i] ?? 0) * a + (ground[i] ?? 0) * (1 - a)
    ) as Vec3
  }
  const { rgb, alpha } = toSrgb(paint, mapping)
  if (alpha < 1) {
    throw new Error(`"${paint}" is translucent — measure it over its ground`)
  }
  return rgb
}

/** WCAG 2.x relative luminance, from gamma-encoded sRGB. */
function luminance(rgb: Vec3): number {
  return Math.max(0, multiply(LINEAR_SRGB_TO_XYZ, map3(rgb, toLinear))[1])
}

/** WCAG 2.x contrast under one mapping, 1..21. */
export function contrastUnder(a: Paint, b: Paint, mapping: Mapping): number {
  const [hi, lo] = [
    luminance(resolvePaint(a, mapping)),
    luminance(resolvePaint(b, mapping)),
  ].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** The lower of the two — what the test asserts and the script solves for. */
export function contrast(a: Paint, b: Paint): number {
  return Math.min(...MAPPINGS.map((m) => contrastUnder(a, b, m)))
}

/** The token's OKLCH coordinates, whichever syntax it is written in. */
export function oklchOf(value: string): Vec3 {
  const parsed = parse(value)
  return parsed.space === "oklch"
    ? parsed.coords
    : oklabToOklch(srgbToOklab(parsed.coords))
}

/**
 * Same hue at another lightness, with the token's own chroma where sRGB can
 * show it and the most sRGB can show where it cannot — the axis a token is
 * tuned on.
 *
 * Not simply `oklch(l c h)`, because an out-of-gamut value is two colors: a
 * clip and a gamut map paint it differently, so a value that clears its floor
 * under one can miss it under the other, and the preset's reds are far out.
 * Written in gamut, what is written is what paints, everywhere. Chroma is
 * rounded *down*, so the three decimals printed stay inside.
 */
export function atLightness(value: string, lightness: number): string {
  const [, c, h] = oklchOf(value)
  const fits = (chroma: number) =>
    inGamut(oklabToSrgb(oklchToOklab([lightness, chroma, h])))
  let chroma = c
  if (!fits(c)) {
    let lo = 0
    let hi = c
    while (hi - lo > 1e-6) {
      const mid = (lo + hi) / 2
      if (fits(mid)) lo = mid
      else hi = mid
    }
    chroma = Math.floor(lo * 1000) / 1000
  }
  return formatOklch([lightness, chroma, h])
}

export function formatOklch([l, c, h]: Vec3): string {
  const trim = (n: number, digits: number) => Number(n.toFixed(digits))
  return `oklch(${trim(l, 3)} ${trim(c, 3)} ${trim(h, 3)})`
}

// --------------------------------------------------------- requirements ---

export interface Check {
  /** The ground, as a test title reads it. */
  name: string
  min: number
  /** The pair, given the value being tried for the token. */
  pair: (candidate: string) => [Paint, Paint]
}

export interface Requirement {
  token: string
  why: string
  checks: Check[]
}

/**
 * Each contrast-critical token: what it must clear, and against what, per theme.
 * Adding an entry is how the guarantee is extended; the test and the script
 * both pick it up.
 *
 * The grounds are the four surfaces a control can sit on and the two fills the
 * kit paints controls with: `bg-input/50` for `input`, `textarea` and
 * `native-select`, and `bg-input/90` for `checkbox`.
 */
export function requirements(
  theme: Theme,
  p: Record<string, string> = palette()[theme]
): Requirement[] {
  const t = (name: string): string => {
    const value = p[name]
    if (!value) throw new Error(`${name} is not defined for the ${theme} theme`)
    return value
  }
  const bases = {
    page: t("--background"),
    card: t("--card"),
    popover: t("--popover"),
    sidebar: t("--sidebar"),
  }
  const fields: Record<string, Paint> = {}
  for (const [name, base] of Object.entries(bases)) {
    fields[`a bg-input/50 field on the ${name}`] = tint(t("--input"), 0.5, base)
    fields[`a bg-input/90 checkbox on the ${name}`] = tint(
      t("--input"),
      0.9,
      base
    )
  }
  const against = (
    grounds: Record<string, Paint>,
    min: number,
    label: (name: string) => string = (name) => `the ${name}`
  ): Check[] =>
    Object.entries(grounds).map(([name, ground]) => ({
      name: label(name),
      min,
      pair: (candidate) => [candidate, ground],
    }))

  // The tints `text-destructive` is painted on, from the registry: `/10` at rest
  // and `/20` on hover (button, badge, dropdown-menu), with dark stepping the
  // button up one — `dark:bg-destructive/20`, `dark:hover:bg-destructive/30`.
  // `/5` is sql-runner's error panel. No light call site paints `/30`, and
  // holding light to it would over-constrain a tint nobody sees.
  const destructiveTints =
    theme === "dark" ? [0.05, 0.1, 0.2, 0.3] : [0.05, 0.1, 0.2]

  return [
    {
      token: "--ring",
      why: "the focus indicator, `focus-visible:border-ring` (1.4.11, 2.4.7)",
      checks: [
        ...against(bases, NON_TEXT, (name) => `the ${name} behind the control`),
        ...against(fields, NON_TEXT, (name) => `${name}, which it encloses`),
        {
          // Not a WCAG number. If the two land on one value the border does not
          // change on focus at all, which passes every check above and ships an
          // invisible focus state.
          name: "the unfocused boundary, so focus reads as a change",
          min: 1.5,
          pair: (candidate) => [candidate, t("--input-border")],
        },
      ],
    },
    {
      token: "--input-border",
      why: "the boundary of a form control (1.4.11)",
      checks: [
        ...against(bases, NON_TEXT, (name) => `the ${name} behind the control`),
        ...against(fields, NON_TEXT, (name) => `${name}, which it encloses`),
      ],
    },
    {
      token: "--sidebar-ring",
      why: "the focus indicator inside the sidebar (1.4.11)",
      checks: [
        ...against(
          {
            sidebar: t("--sidebar"),
            "hovered or active menu item": tint(
              t("--sidebar-accent"),
              1,
              t("--sidebar")
            ),
          },
          NON_TEXT
        ),
        {
          name: "the sidebar's own border, so focus reads as a change",
          min: 1.5,
          pair: (candidate) => [
            candidate,
            tint(t("--sidebar-border"), 1, t("--sidebar")),
          ],
        },
      ],
    },
    {
      token: "--muted-foreground",
      why: "secondary text and every ::placeholder (1.4.3)",
      checks: [
        ...against(bases, TEXT),
        ...against({ "muted panel": tint(t("--muted"), 1, bases.page) }, TEXT),
        // The placeholder is the pair axe cannot see: a pseudo-element has no
        // node to inspect, and it is on every text field in the application.
        ...Object.entries(bases).map(([name, base]) => ({
          name: `a placeholder on a bg-input/50 field on the ${name}`,
          min: TEXT,
          pair: (candidate: string): [Paint, Paint] => [
            candidate,
            tint(t("--input"), 0.5, base),
          ],
        })),
      ],
    },
    {
      token: "--destructive",
      why: "`text-destructive`, on the tints the kit paints it on (1.4.3)",
      checks: [
        ...against(bases, TEXT),
        ...destructiveTints.flatMap((alpha) =>
          Object.entries(bases).map(([name, base]) => ({
            name: `its own /${Math.round(alpha * 100)} tint over the ${name}`,
            min: TEXT,
            // Self-tinted: darkening the token darkens the ink far more than
            // the 10 % of it in the ground, which is why this converges at all.
            pair: (candidate: string): [Paint, Paint] => [
              candidate,
              tint(candidate, alpha, base),
            ],
          }))
        ),
        {
          // `Alert variant="destructive"`: `bg-card text-destructive`, with the
          // description at `text-destructive/90`.
          name: "a destructive alert's description, at /90 on the card",
          min: TEXT,
          pair: (candidate) => [tint(candidate, 0.9, bases.card), bases.card],
        },
      ],
    },
    {
      token: "--destructive-foreground",
      why: "the impersonation banner, which is `bg-destructive` (1.4.3)",
      checks: [
        {
          name: "the destructive fill",
          min: TEXT,
          pair: (candidate) => [candidate, t("--destructive")],
        },
        {
          // The banner's stop button: `hover:bg-destructive-foreground/10`.
          name: "its own /10 hover tint over the destructive fill",
          min: TEXT,
          pair: (candidate) => [
            candidate,
            tint(candidate, 0.1, t("--destructive")),
          ],
        },
      ],
    },
    {
      // semantius-app's module tile draws a white icon on this; nav-user.tsx
      // does not use it because it draws an initial, which is text. Corrected
      // anyway so the next copy from the reference app is not a trap.
      token: "--sidebar-primary",
      why: "under `--sidebar-primary-foreground`, as semantius-app's tile has it (1.4.3)",
      checks: [
        {
          name: "the sidebar-primary-foreground on it",
          min: TEXT,
          pair: (candidate) => [t("--sidebar-primary-foreground"), candidate],
        },
      ],
    },
    // Stock pairs nothing corrects. Pinned so a preset that breaks one fails
    // here, rather than on whichever page first shows it.
    ...STOCK_TEXT_PAIRS.map(([ink, ground]) => ({
      token: ink,
      why: `text on \`${ground}\` (1.4.3)`,
      checks: against({ [ground.slice(2)]: t(ground) }, TEXT),
    })),
    // The vendored Neon components' two tokens, from neon-supplement.css.
    {
      token: "--status-scaling",
      why: "the console's blocked-write banner and mode toggle, on the token's own tints (1.4.3)",
      checks: [0.05, 0.15].flatMap((alpha) =>
        (["page", "card"] as const).map((name) => ({
          name: `its own /${Math.round(alpha * 100)} tint over the ${name}`,
          min: TEXT,
          pair: (candidate: string): [Paint, Paint] => [
            candidate,
            tint(candidate, alpha, bases[name]),
          ],
        }))
      ),
    },
    {
      token: "--status-sleeping",
      why: "the SQL editor's comment color (1.4.3)",
      checks: against({ page: bases.page, card: bases.card }, TEXT),
    },
  ]
}

const STOCK_TEXT_PAIRS: Array<[string, string]> = [
  ["--foreground", "--background"],
  ["--card-foreground", "--card"],
  ["--popover-foreground", "--popover"],
  ["--sidebar-foreground", "--sidebar"],
  ["--primary-foreground", "--primary"],
  ["--secondary-foreground", "--secondary"],
  ["--accent-foreground", "--accent"],
  ["--sidebar-accent-foreground", "--sidebar-accent"],
]
