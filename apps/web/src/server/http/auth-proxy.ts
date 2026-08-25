/**
 * Calling Better Auth from a server route that handles an HTML form.
 *
 * The public pages are plain `<form method="post">`, so a sign-in is a real
 * form submission rather than a scripted fetch. Not because scripting-off has
 * to work — it does not, D31 — but because it keeps the login page correct on
 * the first paint, which is what FR-ACCT-2's "no JS flash" asks for.
 *
 * So the flow is: browser posts form-encoded fields → this module turns them
 * into the JSON request Better Auth expects, forwards the original headers so
 * the CSRF origin check still applies (SEC-3), and translates the answer back
 * into a redirect. Errors travel as a **code** in the query string, never as a
 * message — the wording comes from the catalog (FR-I18N-1) and user input is
 * never echoed into a URL.
 */

import type { Runtime } from "../runtime"

export interface AuthCallResult {
  ok: boolean
  status: number
  body: Record<string, unknown>
  /** `Set-Cookie` values Better Auth produced, to replay onto our redirect. */
  cookies: string[]
}

/**
 * Posts a JSON body to a Better Auth endpoint, preserving the caller's headers.
 *
 * `headers` comes from the incoming request so `Origin`, `Cookie` and
 * `User-Agent` all reach Better Auth unchanged — the origin check, the session
 * lookup and the audit trail all depend on them being real.
 */
export async function callAuth(
  runtime: Runtime,
  path: string,
  body: Record<string, unknown>,
  request: Request
): Promise<AuthCallResult> {
  const headers = new Headers(request.headers)
  headers.set("content-type", "application/json")
  // The form's own content-length no longer applies to the JSON body.
  headers.delete("content-length")

  const issuer = `${runtime.config.base.origin}${runtime.config.base.basePath}`
  const response = await runtime.auth.handler(
    new Request(`${issuer}/api/auth${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })
  )

  let parsed: Record<string, unknown> = {}
  try {
    parsed = (await response.clone().json()) as Record<string, unknown>
  } catch {
    parsed = {}
  }

  return {
    ok: response.ok,
    status: response.status,
    body: parsed,
    cookies: response.headers.getSetCookie(),
  }
}

/** A 303 redirect that carries any cookies Better Auth set. */
export function redirectWithCookies(
  location: string,
  cookies: string[] = []
): Response {
  const headers = new Headers({ location, "cache-control": "no-store" })
  for (const cookie of cookies) headers.append("set-cookie", cookie)
  // 303 so the browser follows with GET and a refresh cannot re-post.
  return new Response(null, { status: 303, headers })
}

/**
 * Maps a Better Auth failure onto one of our own error codes.
 *
 * The mapping is deliberately lossy: several distinct failures collapse into
 * `invalid_credentials` so the page cannot be used to tell a wrong password
 * from an unknown address (SEC-7).
 */
export function errorCodeFor(result: AuthCallResult): string {
  const code =
    typeof result.body.code === "string" ? result.body.code : undefined

  switch (code) {
    case "ACCOUNT_PENDING_APPROVAL":
      return "pending_approval"
    case "ACCOUNT_REJECTED":
      return "unavailable"
    // Two codes, one page. The admin plugin has a ban check of its own on
    // `session.create` that runs before this deployment's gate, so an account
    // suspended from /admin/users is refused with `BANNED_USER` and never
    // reaches `ACCOUNT_BANNED`. Unmapped, it collapsed into
    // `invalid_credentials` and told a suspended user their password was wrong.
    case "ACCOUNT_BANNED":
    case "BANNED_USER":
      return "banned"
    case "EMAIL_DOMAIN_NOT_ALLOWED":
      return "domain_not_allowed"
    case "EMAIL_NOT_VERIFIED":
      return "email_not_verified"
    case "PASSWORD_TOO_SHORT":
    case "PASSWORD_TOO_LONG":
      return "password_length"
    // The admin invariants (`admin/guard.ts`) answer with their own codes.
    // They are echoed through rather than collapsed into "server error",
    // because each one names a different thing the administrator can do next.
    case "ADMIN_CANNOT_CHANGE_OWN_ROLES":
    case "ADMIN_CANNOT_BAN_SELF":
    case "ADMIN_CANNOT_DELETE_SELF":
    case "ADMIN_CANNOT_IMPERSONATE_SELF":
    case "LAST_ADMIN_PROTECTED":
    case "ONLY_ADMINS_GRANT_ADMIN_ROLES":
    case "IMPERSONATION_DISABLED":
      return code.toLowerCase()
    // D50: the client endpoints answer with their own codes, each of which
    // names something the administrator can change.
    case "CLIENT_ALREADY_EXISTS":
    case "CLIENT_MANAGED_BY_FILE":
    case "CLIENT_NOT_FOUND":
    case "INVALID_CLIENT_DEFINITION":
    case "SCOPE_NOT_ALLOWED":
      return code.toLowerCase()
    case "USER_ALREADY_EXISTS":
      // SEC-7: sign-up must not confirm that an address is taken.
      return "signup_failed"
    default:
      break
  }

  if (result.status === 429) return "rate_limited"
  if (result.status >= 500) return "server_error"
  return "invalid_credentials"
}

/** Appends `error=<code>` to a path, replacing any existing one. */
export function withError(path: string, code: string): string {
  const [base, query = ""] = path.split("?")
  const params = new URLSearchParams(query)
  params.set("error", code)
  return `${base}?${params.toString()}`
}

/**
 * Validates a `returnTo` / `callbackURL` parameter (SEC-3).
 *
 * Only a same-origin **relative path** is ever accepted. Anything absolute,
 * protocol-relative or backslash-smuggled is discarded in favour of the
 * fallback, so this parameter can never become an open redirect.
 */
export function safeReturnTo(
  value: string | null | undefined,
  fallback: string
): string {
  if (!value) return fallback
  const candidate = value.trim()
  if (candidate === "") return fallback
  // `//evil.com` and `/\evil.com` are both protocol-relative in some browsers.
  if (!candidate.startsWith("/")) return fallback
  if (candidate.startsWith("//") || candidate.startsWith("/\\")) return fallback
  if (candidate.includes("://")) return fallback
  return candidate
}

/** Reads a form body into a plain record, trimming whitespace off every value. */
export async function readForm(
  request: Request
): Promise<Record<string, string>> {
  const form = await request.formData()
  const result: Record<string, string> = {}
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") result[key] = value.trim()
  }
  return result
}

/**
 * The same, plus the repeated fields {@link readForm} collapses.
 *
 * A checkbox group posts its name once per ticked box, and the record above
 * keeps only the last one — which is correct for every other form here and
 * exactly wrong for "roles". Rather than change a helper a dozen handlers rely
 * on, this returns both views of the same body: `fields` for the ordinary
 * ones, `list(name)` for the repeated ones.
 *
 * The body can only be read once, so a handler picks one of the two and never
 * both.
 */
export async function readFormMulti(request: Request): Promise<{
  fields: Record<string, string>
  list: (name: string) => string[]
}> {
  const form = await request.formData()
  const fields: Record<string, string> = {}
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") fields[key] = value.trim()
  }
  return {
    fields,
    list: (name) =>
      form
        .getAll(name)
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value !== ""),
  }
}
