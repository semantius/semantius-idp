/**
 * The headers every response carries (SEC-4).
 *
 * **CSP without a nonce, and why.** A nonce is the better mechanism and it is
 * not available here: TanStack Start streams the HTML shell, and the inline
 * scripts that carry the router's serialised state are emitted by the
 * framework — there is no seam to stamp a per-request nonce into them, and a
 * policy that omits them stops the application from hydrating. Hashing is no
 * better: the payload is different on every request by construction.
 *
 * So `script-src` carries `'unsafe-inline'`, and the policy is written so that
 * this is the *only* thing it concedes. `default-src 'self'` with no remote
 * origin anywhere means an injected `<script src>` has nowhere to load from,
 * `connect-src 'self'` means an injected inline script has nowhere to send
 * what it steals, and `form-action 'self'` means it cannot post the page's
 * fields elsewhere. That is a materially weaker policy than a nonce and it is
 * recorded as such rather than described as equivalent — when Start grows a
 * nonce hook, this module is the one place to change.
 *
 * `frame-ancestors 'none'` and `X-Frame-Options: DENY` say the same thing
 * twice on purpose: the first is the standard, the second is what an old
 * browser understands, and a clickjacked consent screen is the attack this
 * whole file exists for.
 *
 * **HSTS** is emitted only when the issuer is https, and only on the app's own
 * responses. A reverse proxy that also sets it will simply agree; a
 * development server on http never sends it, because an HSTS header on
 * localhost poisons the browser for every other project on that host.
 */

/** The endpoints that must never be stored, whatever else is true (SEC-4). */
const NO_STORE_PATHS = [
  "/oauth2/token",
  "/oauth2/userinfo",
  "/oauth2/introspect",
  "/oauth2/revoke",
]

export interface SecurityHeaderOptions {
  /** True when the *issuer* is https, whatever scheme the process listens on. */
  https: boolean
  /** Where the app is mounted, so the no-store paths match under a sub-path. */
  basePath?: string
  /**
   * Extra origins the page may connect to. Empty in every shipped
   * configuration; the hook exists so an operator embedding the IdP in their
   * own shell has somewhere documented to put it rather than editing this file.
   */
  connectSrc?: readonly string[]
  /**
   * Origins a form on these pages may end up submitting to: every registered
   * client's redirect and post-logout origin (FR-OIDC-17's list, reused).
   *
   * **Without this, no OAuth login can complete in Chrome.** The sign-in form
   * posts to this origin and the response is a 303 to the client's redirect
   * URI, and Chromium applies `form-action` to the *redirect* as well as to
   * the submission — so a bare `form-action 'self'` cancels the navigation
   * with `ERR_ABORTED`, leaving the browser sitting on a filled-in sign-in
   * form while the server has already issued the authorization code. Firefox
   * does not check redirects, so it worked there, which is worse than if it
   * had failed everywhere.
   *
   * These are the origins the operator has already trusted with authorization
   * codes; the policy is no wider than the deployment's own client list.
   */
  formAction?: readonly string[]
}

/** The Content-Security-Policy value. Exported so a test can read it apart. */
export function contentSecurityPolicy({
  connectSrc = [],
  formAction = [],
}: Pick<SecurityHeaderOptions, "connectSrc" | "formAction"> = {}): string {
  const connect = ["'self'", ...connectSrc].join(" ")
  const forms = ["'self'", ...formAction].join(" ")
  return [
    "default-src 'self'",
    // See the module header: streamed framework scripts leave no seam for a
    // nonce, and the rest of the policy is written to contain the concession.
    "script-src 'self' 'unsafe-inline'",
    // Tailwind emits a stylesheet, but the framework also injects inline style
    // for streamed content; the same reasoning applies and the risk is lower.
    "style-src 'self' 'unsafe-inline'",
    // `data:` for the QR code, which is rendered inline as an SVG (FR-2FA-1).
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connect}`,
    "frame-ancestors 'none'",
    `form-action ${forms}`,
    "base-uri 'self'",
    "object-src 'none'",
    // Nothing here is ever framed, and nothing navigates a top-level frame.
    "frame-src 'none'",
  ].join("; ")
}

/**
 * Adds the headers to a response, returning a new one.
 *
 * Existing values win. A handler that has already decided its own
 * `Cache-Control` — the JWKS document with its ETag, a static asset with its
 * immutable year — knows something this function does not.
 */
export function withSecurityHeaders(
  response: Response,
  request: Request,
  options: SecurityHeaderOptions
): Response {
  const headers = new Headers(response.headers)

  setUnlessPresent(headers, "X-Content-Type-Options", "nosniff")
  setUnlessPresent(headers, "X-Frame-Options", "DENY")
  setUnlessPresent(
    headers,
    "Referrer-Policy",
    "strict-origin-when-cross-origin"
  )
  // Nothing in this application uses a camera, a microphone or a location.
  setUnlessPresent(
    headers,
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
  )

  if (options.https) {
    setUnlessPresent(
      headers,
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains"
    )
  }

  // The CSP applies to documents. Sending it on a JSON API response costs
  // nothing but says nothing either, and on an asset it is noise on every
  // request the browser makes.
  if (isHtml(response)) {
    setUnlessPresent(
      headers,
      "Content-Security-Policy",
      contentSecurityPolicy(options)
    )
  }

  if (isNoStorePath(new URL(request.url).pathname, options.basePath ?? "")) {
    // SEC-4 names these explicitly, and here the header is *overwritten*: a
    // cached token response is a token handed to whoever asks next.
    headers.set("Cache-Control", "no-store")
    headers.set("Pragma", "no-cache")
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/** Whether SEC-4's no-store rule covers this path, under any mount point. */
export function isNoStorePath(pathname: string, basePath = ""): boolean {
  const relative =
    basePath !== "" && pathname.startsWith(basePath)
      ? pathname.slice(basePath.length)
      : pathname
  return NO_STORE_PATHS.some(
    (path) => relative === path || relative === `/api/auth${path}`
  )
}

function isHtml(response: Response): boolean {
  const type = response.headers.get("content-type")
  return type !== null && type.includes("text/html")
}

function setUnlessPresent(headers: Headers, name: string, value: string): void {
  if (!headers.has(name)) headers.set(name, value)
}

/**
 * Gives a 429 the header clients actually honour (SEC-2).
 *
 * Better Auth's rate limiter answers with `X-Retry-After`, which is not a
 * header — no browser, no `fetch` wrapper and no HTTP client library does
 * anything with it. SEC-2 says a refused caller is told when to come back, and
 * a nonstandard header tells them nothing, so the value is copied onto
 * `Retry-After` as it leaves.
 *
 * The original is left in place rather than removed: something may already be
 * reading it, and removing a header is a change with no upside.
 */
export function withStandardRetryAfter(response: Response): Response {
  if (response.status !== 429) return response
  if (response.headers.has("Retry-After")) return response

  const nonstandard = response.headers.get("X-Retry-After")
  if (!nonstandard) return response

  const seconds = Number.parseInt(nonstandard, 10)
  if (!Number.isFinite(seconds) || seconds < 0) return response

  const headers = new Headers(response.headers)
  headers.set("Retry-After", String(Math.max(1, seconds)))
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
