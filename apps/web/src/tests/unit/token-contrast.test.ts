/**
 * The palette's contrast, computed from the stylesheets themselves (D128).
 *
 * This is the one layer that can check a pair no page happens to render while
 * axe is looking — a hover tint, a placeholder, a control on a surface nothing
 * currently puts it on — and the one that fails when a token moves, rather than
 * at the next e2e run or never. It does not replace the axe scan in
 * `e2e/a11y.spec.ts`: a conformant palette can still be misused at a call site,
 * and only a rendered page shows that.
 *
 * Every pair is measured under a channel clip and under CSS gamut mapping and
 * must clear both; `fixtures/palette.ts` says why, and holds the list.
 */

import { readFileSync } from "node:fs"
import { basename } from "node:path"

import { describe, expect, it } from "vitest"

import {
  PATHS,
  THEMES,
  contrast,
  contrastUnder,
  palette,
  read,
  requirements,
  rulesInOrder,
  sourceFiles,
  themeColorMappings,
  tint,
  toSrgb,
  tokensSetBy,
} from "../fixtures/palette"

function expectAtLeast(ratio: number, min: number, what: string) {
  expect(
    ratio,
    `${what} is ${ratio.toFixed(3)}:1, under ${min}:1`
  ).toBeGreaterThanOrEqual(min)
}

/**
 * The arrangement is an import order, which CSS does not enforce and a build
 * does not check. Lose it and every correction reverts to the preset's value in
 * the browser while the contrast cases below keep passing against the files on
 * disk. These are the tripwire; they assert the wiring, not a color.
 */
describe("the palette's wiring", () => {
  it("__root.tsx loads app.css, and nothing loads the stock palette alone", () => {
    const root = read(PATHS.rootRoute)
    expect(root).toMatch(/^import \w+ from "@workspace\/ui\/app\.css\?url"$/m)

    const bypass = sourceFiles(PATHS.webSource).filter((file) =>
      /["']@workspace\/ui\/globals\.css/.test(readFileSync(file, "utf8"))
    )
    expect(bypass, "imports the stock palette without its corrections").toEqual(
      []
    )

    const exports = (
      JSON.parse(read(PATHS.uiPackage)) as { exports: Record<string, string> }
    ).exports
    expect(exports["./app.css"]).toBe("./src/styles/app.css")
    expect(exports).not.toHaveProperty("./globals.css")
  })

  it("puts every theme-a11y.css token block after every globals.css one", () => {
    const blocks = rulesInOrder()
      .map((rule, index) => ({ ...rule, index }))
      .filter((rule) => rule.prelude === ":root" || rule.prelude === ".dark")
    const from = (file: string) =>
      blocks.filter((rule) => rule.file === file).map((rule) => rule.index)

    const stock = from(PATHS.globals)
    const corrections = from(PATHS.a11y)
    expect(stock, "globals.css contributes no token block").toHaveLength(2)
    expect(
      corrections,
      "theme-a11y.css is not reached from app.css"
    ).toHaveLength(2)
    expect(Math.min(...corrections)).toBeGreaterThan(Math.max(...stock))
  })

  it("corrects exactly the tokens it names, in both themes", () => {
    // Named rather than counted, so adding one is a deliberate edit here and
    // dropping one cannot pass unnoticed.
    const expected = [
      "--destructive",
      "--destructive-foreground",
      "--input-border",
      "--muted-foreground",
      "--ring",
      "--sidebar-primary",
      "--sidebar-ring",
      "--skeleton",
    ]
    expect(tokensSetBy(PATHS.a11y)).toEqual({ light: expected, dark: expected })
  })

  it("restates every :root correction in .dark, because the order cuts both ways", () => {
    // theme-a11y.css's `:root` comes after globals.css's `.dark`, and both match
    // `<html class="dark">` at (0,1,0): a token set in `:root` alone replaces
    // the dark value with a light one. `palette()` models the cascade in source
    // order, so the contrast cases would catch the colors — this catches the
    // shape, before a pair happens to fail.
    const { light, dark } = tokensSetBy(PATHS.a11y)
    expect(light.filter((name) => !dark.includes(name))).toEqual([])
  })
})

describe("the utilities the palette's tokens are used through", () => {
  it("are mapped in @theme for every token a class names", () => {
    // `text-destructive-foreground` compiled to nothing for as long as the
    // impersonation banner has existed: the preset defines no such token and
    // maps no such color, and Tailwind drops a utility it has no color for,
    // silently. So the banner's text was `--foreground` on red, 3.46:1.
    const tokens = new Set(
      THEMES.flatMap((theme) => Object.keys(palette()[theme]))
        .map((name) => name.slice(2))
        .filter(
          (name) => !name.startsWith("radius") && !name.startsWith("status-")
        )
    )
    const mapped = themeColorMappings()
    const property =
      "(?:text|bg|border(?:-[trblxyse])?|ring|outline|fill|stroke|placeholder|divide|caret|accent|decoration|from|via|to|shadow)"
    const unmapped = new Set<string>()
    for (const dir of [PATHS.webSource, PATHS.components]) {
      for (const file of sourceFiles(dir)) {
        const text = readFileSync(file, "utf8")
        for (const token of tokens) {
          const used = new RegExp(
            `[\\s"'\`:]${property}-${token}(?:/\\d+)?(?![\\w-])`
          )
          if (used.test(text) && !(`--color-${token}` in mapped)) {
            unmapped.add(`${token} (${basename(file)})`)
          }
        }
      }
    }
    expect(
      [...unmapped],
      "used as a utility with no --color-* mapping"
    ).toEqual([])
  })
})

describe("the control boundary", () => {
  it("covers every registry control that draws itself as a fill", () => {
    // The boundary rule names its slots, and the next `shadcn add` of a control
    // in this style (`select`, `input-group`, `switch`…) brings another
    // `border-transparent bg-input/*` that it would not cover. The slot is the
    // nearest `data-slot` before the class string, which is how every one of
    // these registry files is written.
    const rule = read(PATHS.a11y)
    const covered = new Set(
      [...rule.matchAll(/\[data-slot="([\w-]+)"\]/g)].map((match) => match[1])
    )
    const missing: string[] = []
    for (const file of sourceFiles(PATHS.components)) {
      const text = readFileSync(file, "utf8")
      for (const match of text.matchAll(/"([^"\n]*)"/g)) {
        const classes = (match[1] ?? "").split(/\s+/)
        if (!classes.includes("border-transparent")) continue
        if (!classes.some((c) => /^bg-input\/\d+$/.test(c))) continue
        const before = text.slice(0, match.index)
        const slot = [...before.matchAll(/data-slot="([\w-]+)"/g)].at(-1)?.[1]
        if (!slot || !covered.has(slot)) {
          missing.push(`${basename(file)}: ${slot ?? "no data-slot"}`)
        }
      }
    }
    expect(missing, "a fill-only control with no --input-border").toEqual([])
    expect(covered).toContain("input")
  })
})

describe("the color math", () => {
  // colorjs.io 0.7.1's answers, which semantius-app measures with. The module
  // agreed with it to 3e-8 over two thousand colors when it was written; these
  // pin that it still does, on the three kinds of value that matter here.
  it("brings an out-of-gamut color in the way colorjs.io does, both ways", () => {
    const expectRgb = (actual: number[], expected: number[]) =>
      actual.forEach((c, i) => expect(c).toBeCloseTo(expected[i] ?? NaN, 5))

    const red = "oklch(0.804 0.191 22.216)"
    expectRgb(toSrgb(red, "clip").rgb, [1, 0.521183, 0.522371])
    expectRgb(toSrgb(red, "css").rgb, [1, 0.604105, 0.591719])
    // Out of gamut, but within a just-noticeable difference of its clip, so the
    // CSS algorithm returns the clip.
    const nearly = "oklch(0.577 0.245 27.325)"
    expectRgb(toSrgb(nearly, "css").rgb, [0.906458, 0, 0.042215])
    expectRgb(toSrgb("#92400e", "css").rgb, [
      0x92 / 255,
      0x40 / 255,
      0x0e / 255,
    ])
  })

  it("measures a self-tinted pair the way colorjs.io does, both ways", () => {
    // semantius-app's light --destructive on its own hover tint over the
    // sidebar: over the floor mapped, under it clipped. The reason this suite
    // measures twice.
    const red = "oklch(0.476 0.245 27.325)"
    const hover = tint(red, 0.2, "oklch(0.985 0.001 106.423)")
    expect(contrastUnder(red, hover, "clip")).toBeCloseTo(4.191491, 5)
    expect(contrastUnder(red, hover, "css")).toBeCloseTo(4.543132, 5)
    expect(contrast(red, hover)).toBeCloseTo(4.191491, 5)
  })

  it("keeps the WCAG endpoints", () => {
    expect(contrast("#ffffff", "oklch(0 0 0)")).toBeCloseTo(21, 9)
    expect(contrast("#92400e", "oklch(1 0 0)")).toBeCloseTo(7.08959, 5)
  })
})

describe.each(THEMES)("the %s theme", (theme) => {
  const resolved = palette()[theme]

  describe.each(requirements(theme, resolved))(
    "$token — $why",
    (requirement) => {
      const value = resolved[requirement.token]

      it("is defined", () => {
        expect(
          value,
          `${requirement.token} has no ${theme} value`
        ).toBeDefined()
      })

      it.each(requirement.checks)("against $name", (check) => {
        if (!value) return
        const [ink, ground] = check.pair(value)
        expectAtLeast(
          contrast(ink, ground),
          check.min,
          `${requirement.token} against ${check.name}`
        )
      })
    }
  )
})
