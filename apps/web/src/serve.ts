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
 * The request id, the SEC-5 log line and the SEC-4 headers all live in
 * `src/server-entry.ts` instead, so `vite dev` gets them too. The one thing
 * only this layer knows is the **socket address** — `Bun.serve` reports it and
 * a `Request` does not carry it — so it is stamped into a private header for
 * the entry to resolve `server.trustProxy` against.
 *
 * M12 extends this with SIGTERM draining and health-check exclusions; what is
 * here is what spike S3 needed to prove the sub-path build, plus M11's edge.
 */

import { loadConfig } from "./server/config/loader"
import { loadDevEnv } from "./server/dev-env"
import { SOCKET_ADDRESS_HEADER } from "./server/http/client-ip"

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
      // An asset gets `nosniff` and the frame headers but no CSP — the policy
      // governs documents, and repeating it on every chunk is bytes on every
      // request for nothing. No log line either: a page load is one request in
      // the log, not thirty.
      "X-Content-Type-Options": "nosniff",
    },
  })
}

/**
 * Stamps the socket address the entry cannot otherwise see.
 *
 * **Always overwritten, never merged.** A client that sends this header of its
 * own has it erased here, before anything reads it — otherwise the header
 * would be a way to hand `clientIpFrom` an address of the caller's choosing,
 * which is precisely what the rightmost-untrusted-hop rule exists to prevent.
 */
function withSocketAddress(
  request: Request,
  address: { address: string } | null
): Request {
  const next = new Request(request)
  if (address) next.headers.set(SOCKET_ADDRESS_HEADER, address.address)
  else next.headers.delete(SOCKET_ADDRESS_HEADER)
  return next
}

const server = Bun.serve({
  hostname: config.file.server.host,
  port: config.file.server.port,
  idleTimeout: 30,
  fetch: async (request, listener) => {
    const { pathname } = new URL(request.url)
    if (request.method === "GET" || request.method === "HEAD") {
      const asset = await staticResponse(pathname)
      if (asset) return asset
    }
    return entry.fetch(withSocketAddress(request, listener.requestIP(request)))
  },
})

console.log(
  `idp listening on http://${server.hostname}:${server.port}${basePath}`
)
