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
 *
 * **It is also the edge** (M11). Every request that reaches the application
 * passes through here exactly once, which makes it the only honest place to
 * mint the request id, resolve the client address and stamp the SEC-4 headers.
 * Doing it in `src/serve.ts` instead would leave `vite dev` without any of it,
 * so a developer would be looking at a different application from the one that
 * ships.
 */

import {
  createStartHandler,
  defaultStreamHandler,
} from "@tanstack/react-start/server"
import type { Register } from "@tanstack/react-router"
import type { RequestHandler } from "@tanstack/react-start/server"

import { setRuntimeBasePath } from "./lib/base-path"
import type { IdpConfig } from "./server/config/derive"
import { loadConfig } from "./server/config/loader"
import { loadDevEnv } from "./server/dev-env"
import { SOCKET_ADDRESS_HEADER, clientIpFrom } from "./server/http/client-ip"
import { clientOrigins } from "./server/http/cors"
import {
  buildLogEntry,
  isQuietPath,
  logRequest,
  requestIdFrom,
  withRequestContext,
} from "./server/http/request-log"
import { beginDraining, releaseResources } from "./server/http/lifecycle"
import {
  withSecurityHeaders,
  withStandardRetryAfter,
} from "./server/http/security-headers"
import { anonymizeIp, createLogger } from "./server/logger"
import type { Logger } from "./server/logger"

const SERVER_FN_SEGMENT = "/_serverFn/"

let mountPath: string | undefined
let edge: { config: IdpConfig; logger: Logger } | undefined

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

/**
 * Configuration and a logger for the edge, resolved once.
 *
 * Same reasoning as `resolveMountPath`: this runs before the first request is
 * routed, and `getRuntime()` is the whole OPS-2 start-up sequence. A broken
 * configuration yields `undefined`, and the edge then does the minimum — an id
 * and the headers — rather than refusing to serve the page that would explain
 * the breakage.
 */
function resolveEdge(): { config: IdpConfig; logger: Logger } | undefined {
  if (edge !== undefined) return edge
  try {
    loadDevEnv()
    const { config } = loadConfig()
    edge = {
      config,
      logger: createLogger({
        level: config.file.logging.level,
        format: config.file.logging.format,
      }),
    }
  } catch {
    return undefined
  }
  return edge
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

export type ServerEntry = {
  fetch: RequestHandler<Register>
  /**
   * OPS-4, step one: `/readyz` starts answering 503 so the load balancer stops
   * choosing this instance. In-flight requests are untouched.
   */
  beginDraining: () => void
  /**
   * OPS-4, step two: closes the database pool. Called by `src/serve.ts` only
   * after the in-flight requests have finished, because closing it under one
   * of them is how an orderly rollout produces 500s.
   */
  releaseResources: () => Promise<void>
}

const entry: ServerEntry = {
  fetch: async (request, ...rest) => {
    const base = resolveMountPath()
    const context = resolveEdge()
    const trustProxy = context?.config.file.server.trustProxy ?? false

    const requestId = requestIdFrom(request, trustProxy)
    const ipAddress = clientIpFrom(request, trustProxy, {
      socketAddress: request.headers.get(SOCKET_ADDRESS_HEADER),
    })
    const startedAt = Date.now()

    const response = await withRequestContext(
      { requestId, ipAddress: anonymizeIp(ipAddress) },
      () => handler(unmountServerFnRequest(request), ...rest)
    )

    const { pathname } = new URL(request.url)
    if (context && !isQuietPath(pathname, base)) {
      logRequest(
        context.logger,
        buildLogEntry({
          request,
          status: response.status,
          startedAt,
          requestId,
          ipAddress,
        })
      )
    }

    const withHeaders = withSecurityHeaders(
      withStandardRetryAfter(response),
      request,
      {
        https: context?.config.base.secure ?? false,
        basePath: base,
        // The registered redirect origins, so a completed authorization can
        // actually reach the client that asked for it (SEC-4, D46).
        formAction: context ? [...clientOrigins(context.config)] : [],
      }
    )
    // Echoed so an operator reading a 500 in a browser can quote the id that
    // is on the log line and the audit row.
    withHeaders.headers.set("X-Request-Id", requestId)
    return withHeaders
  },
  beginDraining,
  releaseResources,
}

export default entry
