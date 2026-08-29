/**
 * The gate that did not exist when the sign-in page lost its stylesheet.
 *
 * Every other gate in this repository reads HTML or JSON. None of them ever
 * asked a *dev server* for an asset, so `base: "./"` could break every URL
 * Vite serves out of its own namespace — `/@vite/client`, `/@fs/…`, `/@id/…` —
 * and every test stayed green while the page arrived with no stylesheet, no
 * client entry and no HMR. The markup was perfect; only the paint was gone.
 *
 * Vite 8 stopped coercing a relative base to `/` for the dev server and now
 * prefixes each transform URL with `/./`. A real path survives it — `/./src/
 * router.tsx` still resolves against the root — but Vite's internal URLs are
 * recognized by their `/@` prefix, so `/./@fs/…` resolves to null and falls
 * through to the application's 404. Hence `base` is relative for the build
 * only (`vite.config.ts`), and these two requests are what says so.
 *
 * **No database.** This file deliberately does not import the harness: it
 * starts Vite and asks it for two assets, neither of which reaches the
 * application, so it needs no schema and no Postgres. It lives in the
 * integration project because it does real I/O, not because it needs a
 * database.
 */

import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { createServer } from "vite"
import type { ViteDevServer } from "vite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const HERE = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = join(HERE, "..", "..", "..")

/** The stylesheet `__root.tsx` imports, as the `/@fs/` URL Vite emits for it. */
const GLOBALS_CSS = resolve(
  APP_ROOT,
  "..",
  "..",
  "packages",
  "ui",
  "src",
  "styles",
  "globals.css"
)

let server: ViteDevServer
let origin: string

beforeAll(async () => {
  server = await createServer({
    root: APP_ROOT,
    // Never the default port: a developer almost certainly has a dev server
    // running already, and `strictPort: false` walks up from here until it
    // finds one free. The URL is read back rather than assumed for exactly
    // that reason.
    server: { port: 43_517, strictPort: false },
    logLevel: "silent",
  })
  await server.listen()
  const resolved = server.resolvedUrls?.local[0]
  if (!resolved) throw new Error("dev server did not bind a port")
  origin = resolved.replace(/\/$/, "")
}, 120_000)

afterAll(async () => {
  await server.close()
})

describe("the dev server serves its own namespace", () => {
  it("serves the client entry, so the page hydrates", async () => {
    const response = await fetch(`${origin}/@vite/client`)

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("javascript")
  })

  it("serves the stylesheet, so the page is branded", async () => {
    // `?direct` is what a browser asking for a stylesheet gets; Vite injects it
    // from the `Accept` header, which is why the header is sent here too.
    const url = `${origin}/@fs/${GLOBALS_CSS.replaceAll("\\", "/")}`
    const response = await fetch(url, { headers: { accept: "text/css" } })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/css")
    // Not merely "some CSS": the compiled Tailwind layers are the branding.
    await expect(response.text()).resolves.toContain("@layer theme")
  })
})

describe("base", () => {
  it("is the host root in dev and relative for the build", async () => {
    const config = (await import("../../../vite.config")).default
    const asFunction = config as unknown as (env: {
      command: "serve" | "build"
      mode: string
    }) => { base: string }

    expect(asFunction({ command: "serve", mode: "development" }).base).toBe("/")
    expect(asFunction({ command: "build", mode: "production" }).base).toBe("./")
  })
})
