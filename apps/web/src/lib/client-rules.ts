/**
 * The OAuth-client rules both sides need (FR-OIDC-3, **D62**).
 *
 * `/admin/clients`'s registration form and `oauth_clients.jsonc`'s zod schema
 * apply the same constraints, and until now only the schema knew them: the
 * form posted whatever was typed and the server answered
 * `invalid_client_definition` — one code for a wildcard, a missing scheme, a
 * fragment and a plain-http host alike, with the dialog closed and the fields
 * emptied on the way back.
 *
 * **This module is deliberately not in `server/`.** The obvious shortcut was to
 * import `server/config/schema/clients-schema.ts` into the dialog, and it would
 * have passed `check-client-bundle.ts` — that gate greps for six marker strings
 * and a size ceiling, and zod carries none of them — while quietly eroding the
 * seam those markers stand for. So the rules live here, as pure functions with
 * no zod and no imports, and both sides call them.
 *
 * The answers are **codes, not sentences**. The schema turns them into the
 * operator-facing messages a startup failure has always printed; the dialog
 * turns them into catalog strings (FR-I18N-1). Neither wording travels.
 */

export const CLIENT_TYPES = ["web", "spa", "native"] as const
export type ClientType = (typeof CLIENT_TYPES)[number]

/** Public client types cannot keep a secret, so they must use PKCE (FR-OIDC-3). */
export const PUBLIC_CLIENT_TYPES: readonly ClientType[] = ["spa", "native"]

export type RedirectUriProblem =
  | "wildcard"
  | "not_absolute"
  | "fragment"
  | "http_not_loopback"
  | "private_scheme"
  | "host_template"

/**
 * The per-request host template a redirect URI may carry:
 * `https://{host}/oauth2_callback`.
 *
 * NOT a wildcard, and deliberately a different grammar from the config files'
 * `${env:…}` placeholders — those are substituted once at load time, this one
 * per request, by the IdP, from the host the authorization arrived on (only
 * meaningful under `server.dynamicIssuer`). It must stand for the ENTIRE host
 * component: `{host}` between the scheme and the path, exactly once, no port
 * of its own, no credentials — anything else is refused as `host_template`,
 * and `*` stays refused as the wildcard it is.
 */
export const HOST_TEMPLATE = "{host}"

/** A syntactically valid stand-in host, substituted for validation only. */
const TEMPLATE_PLACEHOLDER = "host-template.invalid"

export function hasHostTemplate(value: string): boolean {
  return value.includes(HOST_TEMPLATE)
}

/**
 * Substitutes the whole-host template with a real `host[:port]`.
 *
 * Callers only pass URIs that already passed {@link checkRedirectUri}, where
 * the template is constrained to the host position — so a plain string
 * replace cannot move anything anywhere else.
 */
export function expandHostTemplate(uri: string, host: string): string {
  return uri.replaceAll(HOST_TEMPLATE, host)
}

/**
 * A redirect URI must be absolute and exactly matched at authorize time
 * (FR-OIDC-3/4). Wildcards and fragments are rejected outright; plain http is
 * only allowed on loopback, and private-use schemes only for native clients.
 * The `{host}` template is substituted with a placeholder host BEFORE the
 * wildcard check, so a templated URI validates like the URI it expands to —
 * and `*` stays refused either way.
 *
 * `undefined` means the URI is acceptable for a client of that type.
 */
export function checkRedirectUri(
  value: string,
  type: ClientType
): RedirectUriProblem | undefined {
  const templated = hasHostTemplate(value)
  // First occurrence only: a second `{host}` survives into `candidate` and
  // fails the whole-host check below, which is how "exactly once" is enforced
  // without counting.
  const candidate = templated
    ? value.replace(HOST_TEMPLATE, TEMPLATE_PLACEHOLDER)
    : value
  if (candidate.includes("*")) return "wildcard"
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return "not_absolute"
  }
  if (templated) {
    // The template must BE the host component — not part of one, not a path
    // segment, not beside a userinfo block, and only once.
    const wholeHost =
      url.host === TEMPLATE_PLACEHOLDER &&
      url.username === "" &&
      url.password === "" &&
      !hasHostTemplate(candidate)
    if (!wholeHost) return "host_template"
  }
  // Both halves matter: `URL` drops an empty trailing `#`, which is still a
  // fragment as far as an exact match is concerned.
  if (url.hash !== "" || candidate.includes("#")) return "fragment"
  if (url.protocol === "https:") return undefined
  if (url.protocol === "http:") {
    const isLoopback =
      url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.hostname === "[::1]"
    return isLoopback ? undefined : "http_not_loopback"
  }
  // A private-use scheme, e.g. `com.example.app:/callback`.
  return type === "native" ? undefined : "private_scheme"
}

/** `clientId` may only contain letters, digits and `. _ ~ -` (FR-OIDC-3). */
export const CLIENT_ID_PATTERN = "[A-Za-z0-9._~\\-]+"

/**
 * The two ids that are legal characters and unusable as a path segment
 * (**D93**).
 *
 * The client id is part of this application's own address for the row —
 * `/admin/clients/<id>/edit` — and a browser resolves `/admin/clients/../edit`
 * to `/admin/edit` before the request ever leaves it, so a client called `..`
 * has an edit link that goes somewhere else entirely. `gateway-rules.ts` gives
 * exactly this reasoning for gateway names and bans dots outright; a client id
 * cannot afford that, because `com.example.app` is an ordinary one. **Two
 * exact values, not a rule about dots.**
 *
 * In `isValidClientId`, so `oauth_clients.jsonc` cannot declare one either —
 * that row would be just as unroutable.
 */
export const RESERVED_CLIENT_IDS: readonly string[] = [".", ".."]

export function isReservedClientId(value: string): boolean {
  return RESERVED_CLIENT_IDS.includes(value)
}

export function isValidClientId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 128 &&
    !isReservedClientId(value) &&
    new RegExp(`^${CLIENT_ID_PATTERN}$`).test(value)
  )
}

/** A textarea of URIs, one per line, blank lines dropped. */
export function uriLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
}

/**
 * The registration form asks "Require consent"; the wire field is
 * `skipConsent` (FR-OIDC-3, and **D50** for the history).
 *
 * The inversion is deliberate and is the owner's call: the column and the
 * checkbox both read as the thing an administrator is deciding — *does this
 * application ask the user?* — rather than as the negation stored underneath.
 * It is a real triple negative in the making, which is exactly why the mapping
 * is one exported function with a test on it rather than a `!` in a handler.
 *
 * An unticked box means "do not ask", which is FR-OIDC-3's documented default
 * of `skipConsent: true` and what a file-declared client gets.
 */
export function skipConsentFromForm(requireConsent: string | undefined): boolean {
  return requireConsent !== "on"
}

export interface ClientFormValues {
  clientId: string
  name: string
  type: string
  /** Raw textarea contents, one URI per line. */
  redirectUris: string
  postLogoutRedirectUris: string
  enableEndSession: boolean
}

/**
 * Everything the registration form can decide for itself.
 *
 * Keyed by field name so the caller can hang each message under its own input.
 * A `uri:<problem>` value carries the offending URI after a second colon, so
 * the dialog can name it: `uri:wildcard:https://app/*`.
 *
 * Scopes are deliberately absent: they are checkboxes generated from
 * `ui.oauthScopes`, so `scope_not_allowed` is not reachable from this form.
 */
export type ClientFormErrors = Partial<Record<keyof ClientFormValues, string>>

export function validateClientForm(values: ClientFormValues): ClientFormErrors {
  const errors: ClientFormErrors = {}
  const type = (
    (CLIENT_TYPES as readonly string[]).includes(values.type)
      ? values.type
      : "spa"
  ) as ClientType

  if (isReservedClientId(values.clientId)) {
    // Named separately from `invalid`: "use letters, digits and `. _ ~ -`" is
    // exactly what `.` already is, so the generic message would be a refusal
    // that describes the value as acceptable.
    errors.clientId = "reserved"
  } else if (!isValidClientId(values.clientId)) {
    errors.clientId = "invalid"
  }
  if (values.name.trim() === "") errors.name = "required"

  const redirects = uriLines(values.redirectUris)
  if (redirects.length === 0) {
    errors.redirectUris = "required"
  } else {
    for (const uri of redirects) {
      const problem = checkRedirectUri(uri, type)
      if (problem) {
        errors.redirectUris = `uri:${problem}:${uri}`
        break
      }
    }
  }

  const postLogout = uriLines(values.postLogoutRedirectUris)
  for (const uri of postLogout) {
    const problem = checkRedirectUri(uri, type)
    if (problem) {
      errors.postLogoutRedirectUris = `uri:${problem}:${uri}`
      break
    }
  }
  // The schema refuses `enableEndSession` with no post-logout URI, so the form
  // has to as well — otherwise ticking the box is a guaranteed rejection.
  if (
    values.enableEndSession &&
    postLogout.length === 0 &&
    errors.postLogoutRedirectUris === undefined
  ) {
    errors.postLogoutRedirectUris = "endSessionNeedsUri"
  }

  return errors
}
