/**
 * The mount path as the *browser* bundle sees it (OPS-10).
 *
 * `server/oidc/base-path.ts` is the server-side twin: it derives every absolute
 * URL from `server.baseUrl`. This module exists because the same value is
 * needed in code that is compiled into the client bundle — the router's
 * `basepath`, the server-function fetch and the one `?url` asset import — and
 * nothing under `@/server` may be imported there.
 *
 * **Why it is not simply a build-time constant.** `server.baseUrl` is runtime
 * configuration (CFG-5) but Vite's `base`, TanStack Start's router `basepath`
 * and its server-function base are all baked at build time. One image has to
 * serve at `/` and at `/idp` (OPS-10, G6), so the value has to reach the
 * bundle some other way. It arrives twice, from the only two places that know
 * it at the right moment:
 *
 *  - on the server, {@link setRuntimeBasePath} is called by the Start server
 *    entry (`src/server.ts`) before the first request builds a router;
 *  - in the browser, it is read back off the `data-base-path` attribute that
 *    `__root.tsx` renders onto `<html>` — already parsed by the time the
 *    client entry runs, so no extra round trip and no inline script.
 */

/** Attribute on `<html>` that carries the mount path to the browser. */
export const BASE_PATH_ATTRIBUTE = "data-base-path"

let value: string | undefined

/**
 * Server-side only: fixes the mount path for the life of the process.
 * Called once by the Start server entry, before any router is created.
 */
export function setRuntimeBasePath(next: string): void {
  value = next
}

/**
 * The mount path — `""` at the host root, `/idp` under a sub-path.
 *
 * On the server the answer is whatever `setRuntimeBasePath` was given. In the
 * browser it is read from `<html data-base-path>` once and then cached; the
 * document cannot change mount points without a full navigation.
 */
export function runtimeBasePath(): string {
  if (value !== undefined) return value
  // Deliberately not cached on the server: `""` here would only mean
  // "the entry has not run yet", and caching it would be permanent.
  if (typeof document === "undefined") return ""
  value = document.documentElement.getAttribute(BASE_PATH_ATTRIBUTE) ?? ""
  return value
}

/** Test seam: forget the cached value. */
export function resetRuntimeBasePath(): void {
  value = undefined
}

/** `/login` → `/idp/login`. Absolute URLs and already-prefixed paths pass through. */
export function withBasePath(path: string): string {
  const base = runtimeBasePath()
  if (base === "" || !path.startsWith("/")) return path
  if (path === base || path.startsWith(`${base}/`)) return path
  return `${base}${path}`
}

/**
 * Resolves a Vite `?url` asset import against the mount path.
 *
 * The build uses `base: "./"` so that chunk-to-chunk imports and CSS `url()`
 * references relocate with the bundle. The cost is that a `?url` import is a
 * *document-relative* string on the server (`./assets/globals-abc.css`), which
 * would resolve differently on `/idp/login` and `/idp/account/security`. This
 * pins it to the mount path instead. In the browser the same import is already
 * an absolute URL resolved from `import.meta.url`, so it passes through.
 */
export function assetUrl(url: string): string {
  if (!url.startsWith("./")) return url
  return `${runtimeBasePath()}/${url.slice(2)}`
}
