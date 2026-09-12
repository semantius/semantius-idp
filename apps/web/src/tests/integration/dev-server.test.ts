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
 * **No database, and none reachable.** This file deliberately does not import
 * the harness. Most of what it asks for never reaches the application, and the
 * one page it renders is meant to fail start-up: the configuration folder
 * points nowhere, so `getRuntime()` throws before it looks for a database.
 * The database URLs are pointed at a closed local port as well, because the
 * dev server's `loadDevEnv()` would otherwise fill them from the repo-root
 * `.env` — the developer's own database, persistent schema and all — and an
 * accidental start-up there is not something a test may risk. It lives in the
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
const APP_CSS = resolve(
  APP_ROOT,
  "..",
  "..",
  "packages",
  "ui",
  "src",
  "styles",
  "app.css"
)

let server: ViteDevServer
let origin: string

/** Set before Vite starts, because its SSR modules share this process's env. */
const ISOLATED_ENV = {
  IDP_CONFIG_DIR: join(APP_ROOT, "no-such-config-folder"),
  DATABASE_URL: "postgres://nobody@127.0.0.1:1/none",
  DATABASE_URL_ADMIN: "postgres://nobody@127.0.0.1:1/none",
  IDP_SCHEMA_NAME: "idp_dev_server_test_never_created",
}
const previousEnv: Record<string, string | undefined> = {}

beforeAll(async () => {
  for (const [name, value] of Object.entries(ISOLATED_ENV)) {
    previousEnv[name] = process.env[name]
    process.env[name] = value
  }
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
  for (const [name, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
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
    const url = `${origin}/@fs/${APP_CSS.replaceAll("\\", "/")}`
    const response = await fetch(url, { headers: { accept: "text/css" } })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/css")
    const css = await response.text()
    // Not merely "some CSS": the compiled Tailwind layers are the branding.
    expect(css).toContain("@layer theme")
    // …and the contrast corrections are compiled into the same file, which
    // is what `app.css` exists for (D128). `--input-border` is defined
    // nowhere else, so its presence says theme-a11y.css was inlined.
    expect(css).toContain("--input-border")
  })

  it("answers a request through the server entry, not only Vite's own paths", async () => {
    // The two cases above never reach `server-entry.ts`: Vite answers them
    // itself. This one does, as a srvx `NodeRequest` — which is not a real
    // Request, so the edge's `new Request(request)` threw "reading 'window'"
    // on every page for four days while this file stayed green.
    const response = await fetch(`${origin}/healthz`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ status: "ok" })
  })

  it("draws the 500 page when start-up fails, instead of crashing the shell", async () => {
    // The root route's `beforeLoad` fails here, as it did on 2026-09-11 on a
    // schema whose migrations no longer matched. The document shell then
    // destructured loader data that never arrived, and the only thing in the
    // log was its `TypeError`. The page this asserts is `ErrorPage`.
    const response = await fetch(`${origin}/`)
    const html = await response.text()

    expect(response.status).toBe(500)
    expect(html).toContain("Something went wrong")
    expect(html).not.toContain("Cannot destructure")
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
