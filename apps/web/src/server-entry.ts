/**
 * TanStack Start's server entry — the process-wide seam where the *runtime*
 * mount path is applied to a build that was compiled without one (spike S3).
 *
 * Three build-time constants decide where a Start app lives: Vite's `base`,
 * the router's `basepath` and the server-function base. `server.baseUrl` is
 * runtime configuration, and one image has to serve at `/` and at `/idp`
 * (OPS-10, G6). Each constant is neutralised here or in the module it belongs
 * to:
 *
 *  - **assets** — the build uses `base: "./"`, so chunk-to-chunk imports and
 *    CSS `url()` references already relocate. What stays absolute is the SSR
 *    manifest, and `transformAssets` is Start's supported hook for rewriting
 *    exactly those URLs (it exists for CDNs; a mount path is the same edit).
 *  - **router basepath** — `src/router.tsx` re-applies the runtime value on
 *    every `router.update`, which is how Start pushes the baked one in.
 *  - **server functions** — the client moves them onto the mount path
 *    (`src/start-entry.ts`); this entry strips the prefix again, because the
 *    handler matches them against the baked base before anything else runs.
 *
 * Static assets are served by whatever fronts this handler (`scripts/
 * spike-s3-proxy.ts` today, the container's entrypoint from M12); that layer
 * strips the mount path before looking in `dist/client`.
 */

import {
  createStartHandler,
  defaultStreamHandler,
} from "@tanstack/react-start/server"
import type { Register } from "@tanstack/react-router"
import type { RequestHandler } from "@tanstack/react-start/server"

import { setRuntimeBasePath } from "./lib/base-path"
import { loadConfig } from "./server/config/loader"
import { loadDevEnv } from "./server/dev-env"

const SERVER_FN_SEGMENT = "/_serverFn/"

let mountPath: string | undefined

/**
 * The mount path, read straight from the config folder.
 *
 * Deliberately not `getRuntime()`: this runs before the first request is even
 * routed, and building the runtime is the whole OPS-2 startup sequence
 * (migrations, bootstrap, key seeding). Only `server.baseUrl` is needed, and
 * `loadConfig` is synchronous.
 *
 * A broken configuration resolves to the host root rather than throwing, so
 * the failure still surfaces where it is diagnosable — as the startup error
 * `getRuntime()` raises on the first request — instead of as a dead process.
 */
function resolveMountPath(): string {
  if (mountPath !== undefined) return mountPath
  try {
    loadDevEnv()
    mountPath = loadConfig().config.base.basePath
  } catch {
    mountPath = ""
  }
  setRuntimeBasePath(mountPath)
  return mountPath
}

const handler = createStartHandler({
  handler: defaultStreamHandler,
  transformAssets: {
    transform: ({ url }) => ({ href: assetHref(url) }),
  },
})

/** `/./assets/x.js` → `/idp/assets/x.js` (and → `/assets/x.js` at the root). */
function assetHref(url: string): string {
  if (!url.startsWith("/")) return url
  const rooted = url.startsWith("/./") ? url.slice(2) : url
  return `${resolveMountPath()}${rooted}`
}

/**
 * Undoes `src/start-entry.ts`'s prefixing so Start's handler recognises a
 * server-function call. Page requests keep their prefix — the router matches
 * them with the same `basepath` the links were rendered with.
 */
function unmountServerFnRequest(request: Request): Request {
  const base = resolveMountPath()
  if (base === "") return request
  const url = new URL(request.url)
  if (!url.pathname.startsWith(`${base}${SERVER_FN_SEGMENT}`)) return request
  url.pathname = url.pathname.slice(base.length)
  return new Request(url, request)
}

export type ServerEntry = { fetch: RequestHandler<Register> }

const entry: ServerEntry = {
  fetch: (request, ...rest) => {
    resolveMountPath()
    return handler(unmountServerFnRequest(request), ...rest)
  },
}

export default entry
