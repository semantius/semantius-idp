/**
 * TanStack Start's shared entry — the options both the client and the server
 * build read (`src/server.ts` is the server-only half).
 *
 * It exists for one reason: server-function calls (spike S3). The client posts
 * them to a base path that is baked into *both* bundles at build time
 * (`/_serverFn/`), which is correct at the host root and 404s under `/idp`.
 * The `serverFns.fetch` seam is the supported way to move them; the server
 * entry strips the prefix again before Start's handler looks at the URL.
 *
 * **Declaring a start instance disables Start's implicit CSRF middleware** —
 * it is only applied when no instance exists — so the same middleware is
 * registered explicitly below. Removing it would leave server functions open
 * to cross-origin invocation.
 */

import { createCsrfMiddleware, createStart } from "@tanstack/react-start"

import { withBasePath } from "./lib/base-path"

export const startInstance = createStart(() => ({
  requestMiddleware: [
    createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" }),
  ],
  serverFns: {
    fetch: (input, init) => fetch(prefixServerFnUrl(input), init),
  },
}))

/**
 * Moves a server-function request onto the mount path.
 *
 * Only the client ever reaches this — during SSR, server functions are called
 * directly rather than over HTTP.
 */
function prefixServerFnUrl(input: RequestInfo | URL): RequestInfo | URL {
  if (typeof input === "string") {
    return input.startsWith("/") ? withBasePath(input) : input
  }
  if (input instanceof URL) {
    return new URL(withBasePath(input.pathname) + input.search, input)
  }
  const url = new URL(input.url)
  const moved = withBasePath(url.pathname)
  if (moved === url.pathname) return input
  url.pathname = moved
  return new Request(url, input)
}
