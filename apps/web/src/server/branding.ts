/**
 * Serving the operator's branding files.
 *
 * A deployment supplies its own logo and favicon by dropping them in the
 * config folder — the only writable-by-the-operator, readable-by-the-container
 * place there is, since the image mounts `/config` read-only into an image with a
 * read-only root filesystem. `/branding/logo.svg` is
 * `${IDP_CONFIG_DIR}/branding/logo.svg`; nothing is baked in, and re-branding
 * is a file copy and a restart rather than a rebuild.
 *
 * **This is a path from a URL turned into a path on disk**, which is the shape
 * of every directory-traversal bug ever filed, so it is written as a series of
 * refusals rather than a series of transformations:
 *
 *  - the request must be a plain relative path — a leading `/`, a `..`
 *    segment, a backslash, a null byte, a drive letter or a scheme is refused
 *    outright, not normalized into something safe;
 *  - the resolved path is checked to still be inside the branding folder after
 *    resolution, which is the only check that catches whatever the first list
 *    missed;
 *  - the extension must be one of a short allow-list. Not because a `.pem` in
 *    `branding/` would be *served* — the folder is the operator's — but
 *    because it decides the `Content-Type`, and a file server that guesses is
 *    a file server that will one day serve `text/html` from a directory
 *    someone else can write to.
 *
 * Anything refused is a 404, never a 403: the difference between "you may not
 * have this" and "this does not exist" tells a prober which paths are real.
 */

import { extname, resolve, sep } from "node:path"

import { loadConfig } from "./config/loader"

/**
 * What may be served, and as what.
 *
 * Images and fonts only. The `Content-Type` is looked up here rather than
 * sniffed, so an unknown extension has no answer and is refused — see the
 * module note.
 */
const CONTENT_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
}

/** The subfolder of the config directory that `/branding/*` maps onto. */
export const BRANDING_DIR = "branding"

/** Everything a request must not contain, checked before anything is resolved. */
const REFUSED = /(^\/)|(^[a-zA-Z]:)|(^\\)|(\\)|(\0)|(^\.\.?$)|(^\.\.\/)|(\/\.\.(\/|$))|(:\/\/)/

/**
 * The requested path, or `undefined` if it is not one this will serve.
 *
 * Exported for its own tests: the traversal rules are the security-relevant
 * part and deserve to be asserted without a filesystem or a router.
 */
export function safeBrandingPath(splat: string): string | undefined {
  const requested = decodeSafely(splat)
  if (requested === undefined) return undefined
  if (requested === "") return undefined
  if (REFUSED.test(requested)) return undefined
  if (!(extname(requested).toLowerCase() in CONTENT_TYPES)) return undefined
  return requested
}

/**
 * `decodeURIComponent` that answers `undefined` instead of throwing.
 *
 * The decode has to happen — `%2e%2e%2f` is `../` and the refusal list must
 * see it that way — and a malformed sequence is a request nobody legitimate
 * made.
 */
function decodeSafely(value: string): string | undefined {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

/** `image/svg+xml` for a path that got this far. */
export function brandingContentType(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream"
}

/**
 * The policy on every branding response.
 *
 * `security-headers.ts` attaches the site's CSP to `text/html` only, and an
 * SVG is not HTML — it is a *document* all the same. Opened top-level,
 * `image/svg+xml` runs its own `<script>` and `<foreignObject>` on this
 * origin, where the session cookie lives; in an `<img>` it is inert, but the
 * URL is public and nothing makes a visitor open it that way. The folder is
 * the operator's, so this is defense in depth rather than a live hole — and
 * it costs one header. `default-src 'none'` means the document may load
 * nothing, `sandbox` with no allowances means it may run nothing, and both
 * are meaningless to a browser rendering an image, which is the point.
 */
export const BRANDING_CSP = "default-src 'none'; sandbox"

/**
 * The full header set for a served file (`requested` names it) or for a
 * refusal (`undefined`). One function so the refusal cannot forget what the
 * file carries: the policy is the same either way, and only the file has a
 * type and a cache lifetime.
 *
 * Cached for an hour rather than for ever: these files keep their names across
 * changes — an operator replaces `logo.svg` with a different `logo.svg` — so
 * there is no hash to make immutability safe, and `immutable` would strand the
 * old logo in every browser that had seen it.
 */
export function brandingResponseHeaders(
  requested: string | undefined
): Record<string, string> {
  const shared = {
    "Content-Security-Policy": BRANDING_CSP,
    "X-Content-Type-Options": "nosniff",
  }
  if (requested === undefined) {
    return { ...shared, "Cache-Control": "no-store" }
  }
  return {
    ...shared,
    "Content-Type": brandingContentType(requested),
    "Cache-Control": "public, max-age=3600, must-revalidate",
  }
}

/** 404 with nothing in it. Used for every refusal; see the module note. */
function notFound(): Response {
  return new Response(null, {
    status: 404,
    headers: brandingResponseHeaders(undefined),
  })
}

/**
 * The branding folder, resolved once per process.
 *
 * `loadConfig()` reads, expands and validates three files, and this used to
 * do that on every logo and favicon request — a cost paid twice per page for
 * an answer that cannot change: the image mounts `/config` read-only and the
 * runtime reads it once at start-up, so a moved folder is a restart either
 * way. A load that *fails* is deliberately not remembered: a configuration
 * that broken has bigger problems, reported by `/readyz` and the start-up
 * error, and a missing logo is not the place to surface them — the answer is
 * a 404 and the next request asks again, which is cheap because it is rare.
 *
 * The loader is a parameter so the memo can be asserted without a config
 * folder on disk; production passes nothing.
 */
let brandingRootMemo: string | undefined

export function brandingRoot(
  load: () => { dir: string } = loadConfig
): string | undefined {
  if (brandingRootMemo !== undefined) return brandingRootMemo
  try {
    brandingRootMemo = resolve(load().dir, BRANDING_DIR)
  } catch {
    return undefined
  }
  return brandingRootMemo
}

/** Forgets the memo. For tests, which build several configurations per process. */
export function forgetBrandingRoot(): void {
  brandingRootMemo = undefined
}

/** Serves one file out of the config folder's `branding/` directory. */
export async function serveBrandingFile(splat: string): Promise<Response> {
  const requested = safeBrandingPath(splat)
  if (requested === undefined) return notFound()

  const root = brandingRoot()
  if (root === undefined) return notFound()

  const resolved = resolve(root, requested)
  // The check that catches what the pattern above did not: after resolution,
  // is it still inside the folder?
  if (resolved !== root && !resolved.startsWith(root + sep)) return notFound()

  const file = Bun.file(resolved)
  if (!(await file.exists())) return notFound()

  return new Response(file, { headers: brandingResponseHeaders(requested) })
}
