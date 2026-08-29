/**
 * Serving the operator's branding files (CFG-1).
 *
 * A deployment supplies its own logo and favicon by dropping them in the
 * config folder — the only writable-by-the-operator, readable-by-the-container
 * place there is, since OPS-1 mounts `/config` read-only into an image with a
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

/** 404 with nothing in it. Used for every refusal; see the module note. */
function notFound(): Response {
  return new Response(null, {
    status: 404,
    headers: { "cache-control": "no-store" },
  })
}

/**
 * Serves one file out of the config folder's `branding/` directory.
 *
 * Cached for an hour rather than for ever: these files keep their names across
 * changes — an operator replaces `logo.svg` with a different `logo.svg` — so
 * there is no hash to make immutability safe, and `immutable` would strand the
 * old logo in every browser that had seen it.
 */
export async function serveBrandingFile(splat: string): Promise<Response> {
  const requested = safeBrandingPath(splat)
  if (requested === undefined) return notFound()

  let root: string
  try {
    root = resolve(loadConfig().dir, BRANDING_DIR)
  } catch {
    // A configuration this broken has bigger problems, and they are reported
    // by `/readyz` and by the startup error. A missing logo is not the place
    // to surface them.
    return notFound()
  }

  const resolved = resolve(root, requested)
  // The check that catches what the pattern above did not: after resolution,
  // is it still inside the folder?
  if (resolved !== root && !resolved.startsWith(root + sep)) return notFound()

  const file = Bun.file(resolved)
  if (!(await file.exists())) return notFound()

  return new Response(file, {
    headers: {
      "Content-Type": brandingContentType(requested),
      "Cache-Control": "public, max-age=3600, must-revalidate",
      "X-Content-Type-Options": "nosniff",
    },
  })
}
