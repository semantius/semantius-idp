/**
 * The production entrypoint: `Bun.serve` around the built Start handler.
 *
 * The build emits a `{ fetch }` object, not a listener, and nothing in it
 * serves `dist/client`. This wrapper supplies both, and it is the layer that
 * knows about the mount path: a request for `/idp/assets/x.js` is a request
 * for `dist/client/assets/x.js` (OPS-10, spike S3). Page requests keep their
 * prefix — the router matches them with it.
 *
 * The entry is imported by path rather than by specifier so that `tsc` does
 * not need `dist/` to exist, and so the container can point at its own layout.
 *
 * M12 extends this with SIGTERM draining, health-check exclusions and request
 * logging; what is here is what spike S3 needed to prove the sub-path build.
 */

import { loadConfig } from "./server/config/loader"
import { loadDevEnv } from "./server/dev-env"

const DEFAULT_ENTRY = new URL("../dist/server/server-entry.js", import.meta.url)
  .href
const DEFAULT_CLIENT_DIR = new URL("../dist/client/", import.meta.url)

interface ServerEntryModule {
  default: { fetch: (request: Request) => Response | Promise<Response> }
}

loadDevEnv()
const { config } = loadConfig()
const basePath = config.base.basePath

const entryPath = process.env.IDP_SERVER_ENTRY ?? DEFAULT_ENTRY
const clientDir = process.env.IDP_CLIENT_DIR
  ? new URL(`file://${process.env.IDP_CLIENT_DIR}/`)
  : DEFAULT_CLIENT_DIR

const entry = ((await import(entryPath)) as ServerEntryModule).default

/**
 * Serves a file out of `dist/client`, or returns `undefined` so the request
 * falls through to the app.
 *
 * `..` cannot escape the directory: the path is resolved as a URL against the
 * client directory and then checked to still be inside it.
 */
async function staticResponse(pathname: string): Promise<Response | undefined> {
  let relative = pathname
  if (basePath !== "") {
    if (relative === basePath) return undefined
    if (!relative.startsWith(`${basePath}/`)) return undefined
    relative = relative.slice(basePath.length)
  }
  if (relative === "/" || relative === "") return undefined

  const resolved = new URL(`.${relative}`, clientDir)
  if (!resolved.href.startsWith(clientDir.href)) return undefined

  const file = Bun.file(resolved)
  if (!(await file.exists())) return undefined

  // Hashed asset names are immutable; everything else in `public/` is not.
  const immutable = relative.startsWith("/assets/")
  return new Response(file, {
    headers: {
      "Cache-Control": immutable
        ? "public, max-age=31536000, immutable"
        : "public, max-age=0, must-revalidate",
    },
  })
}

const server = Bun.serve({
  hostname: config.file.server.host,
  port: config.file.server.port,
  idleTimeout: 30,
  fetch: async (request) => {
    const { pathname } = new URL(request.url)
    if (request.method === "GET" || request.method === "HEAD") {
      const asset = await staticResponse(pathname)
      if (asset) return asset
    }
    return entry.fetch(request)
  },
})

console.log(
  `idp listening on http://${server.hostname}:${server.port}${basePath}`
)
