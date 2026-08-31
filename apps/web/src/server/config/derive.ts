/**
 * Turns the validated files into the single effective configuration object that
 * the rest of the process reads (CFG-5: "configuration is read once").
 *
 * Everything that depends on another key is resolved here rather than in the
 * zod schemas: `trustedOrigins` ← `baseUrl`, `twoFactor.issuer` ← `site.name`,
 * `database.ssl` ← host, `jwt.gracePeriod` ← longest token lifetime, the
 * degraded-e-mail overrides of FR-MAIL-2, and the effective resource registry
 * of FR-OIDC-6.
 */

import { USER_CLAIM_NAMES } from "./schema/config-schema"
import type { ClientEntry } from "./schema/clients-schema"
import type {
  ConfigFile,
  OAuthResourceConfig,
  UserClaimName,
} from "./schema/config-schema"
import type { RoleEntry } from "./schema/roles-schema"

export interface BasePathInfo {
  /** Issuer origin, e.g. `https://apps.example.com`. */
  origin: string
  /** Mount path with a leading slash and no trailing slash, `""` at the host root. */
  basePath: string
  /** Cookie `Path` attribute — `server.cookiePath`, `/` unless it is set (**D97**). */
  cookiePath: string
  /** Cookie `Domain` attribute — `server.cookieDomain`, absent (host-only) unless it is set (**D97**). */
  cookieDomain?: string
  /** True when `server.baseUrl` uses https, which drives `Secure` cookies (FR-AUTH-5). */
  secure: boolean
  /**
   * `server.dynamicIssuer`: derive the issuer per request from the arriving
   * host instead of always from `baseUrl`. Consumed by
   * `oidc/request-issuer.ts`; `false` keeps every issuer decision exactly what
   * it was before the flag existed.
   */
  dynamicIssuer: boolean
}

export interface EffectiveResource {
  identifier: string
  name: string
  allowedScopes?: string[]
  accessTokenTtl?: number
}

export interface IdpConfig {
  readonly file: ConfigFile
  readonly clients: readonly ClientEntry[]
  readonly roles: readonly RoleEntry[]

  /** Parsed view of `server.baseUrl`, shared by every URL/cookie/route decision. */
  readonly base: BasePathInfo
  /** CSRF origin allow-list, always containing the issuer origin. */
  readonly trustedOrigins: readonly string[]
  /**
   * True when `server.trustedOrigins` named nothing, which since **D68** means
   * the check follows the request — the `Origin` has to match the host the
   * request arrived on — rather than the issuer alone. Configuring the
   * allow-list turns it off and pins the check to what it lists.
   */
  readonly trustRequestOrigin: boolean
  /** `true` when a Resend API key is configured; `false` puts the IdP in degraded mode (FR-MAIL-2). */
  readonly emailEnabled: boolean
  /** `auth.requireEmailVerification`, forced to false when e-mail is off. */
  readonly requireEmailVerification: boolean
  /** TOTP issuer label, defaulting to `site.name`. */
  readonly twoFactorIssuer: string
  /**
   * The connection string for ordinary traffic, resolved (**D74**).
   *
   * `database.url` when it is set, and `database.directUrl` when it is not —
   * a deployment with one endpoint uses that endpoint for everything. Always
   * a string: the schema refuses a `database` block with neither, so the
   * fallback below cannot end up undefined.
   */
  readonly databaseUrl: string
  /**
   * The connection string for anything holding a session advisory lock —
   * startup, migrations, the CLI, the cleanup job (**D27**, **D74**).
   *
   * `database.directUrl` when it is set, and `database.url` when it is not.
   * The pair collapses to the same string on a single-endpoint deployment,
   * which is correct: a plain Postgres endpoint is already direct.
   */
  readonly databaseDirectUrl: string
  /** `disable | require | verify-full`, defaulting to `require` off localhost. */
  readonly databaseSsl: "disable" | "require" | "verify-full"
  /** Retired keys stay published this long; defaults to the longest token lifetime + 1 h (FR-OIDC-16). */
  readonly jwksGracePeriodSeconds: number
  /** Default audience as an array, however it was written. */
  readonly defaultAudience: readonly string[]
  /** `oauth.resources` ∪ `jwt.audience` ∪ every per-client `audience` (FR-OIDC-6). */
  readonly resources: readonly EffectiveResource[]
  /** Which optional user claims the claims builder emits (FR-OIDC-7). */
  readonly userClaims: readonly UserClaimName[]
  /** The single `default: true` role, assigned at self-registration. */
  readonly defaultRole: string
  /** Roles that unlock `/admin/*` and the admin API. */
  readonly adminRoles: readonly string[]
  /** FR-ADMIN-5: impersonation is off unless the operator turns it on. */
  readonly allowImpersonation: boolean
  /** True when the deployment is treated as production (https issuer) — drives the CFG-5 literal-secret rule. */
  readonly isProduction: boolean
}

/**
 * Splits `server.baseUrl` into the origin, the mount path and the cookie
 * attributes every URL and cookie decision reads.
 *
 * **The cookie scope is configuration, not a consequence of the mount path
 * (D97).** It used to be derived — `Path` was the mount path, so a `/idp`
 * deployment scoped its session to `/idp`. That is a defensible default for
 * isolation and the wrong one here: it silently withholds the session from
 * every route outside the mount, and `/gateway`, which FR-GW-4 reads the
 * session cookie for, is exactly such a route once it is aliased to the origin
 * root. A withheld cookie there does not fail loudly — D92 makes a missing
 * session fall through to anonymous. `/` is the default now, which is also
 * Better Auth's own; an operator who wants the old isolation sets
 * `server.cookiePath` to the mount path and gets it back.
 */
export function parseBasePath(
  baseUrl: string,
  cookies: { path?: string; domain?: string; dynamicIssuer?: boolean } = {}
): BasePathInfo {
  const url = new URL(baseUrl)
  const rawPath = url.pathname.replace(/\/+$/, "")
  const basePath = rawPath === "" || rawPath === "/" ? "" : rawPath
  return {
    origin: url.origin,
    basePath,
    cookiePath: cookies.path ?? "/",
    ...(cookies.domain ? { cookieDomain: cookies.domain } : {}),
    secure: url.protocol === "https:",
    dynamicIssuer: cookies.dynamicIssuer ?? false,
  }
}

export function isLocalhostUrl(value: string): boolean {
  try {
    const { hostname } = new URL(value)
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]" ||
      hostname === "::1"
    )
  } catch {
    return false
  }
}

/**
 * The `sslmode` a connection string states, if it states one unambiguously.
 *
 * **Why this is consulted at all.** The fallback below assumes "not localhost
 * means the wire is untrusted", which is right for a hosted database and wrong
 * for the reference deployment, where the host is `postgres` on a private
 * compose network. Every operator following the quick start would have hit
 * `Client network socket disconnected before secure TLS connection was
 * established` — a message that says nothing about SSL settings — against a
 * URL that already said `sslmode=disable`. The smoke test hit it first.
 *
 * `prefer` and `allow` are deliberately *not* honored. They mean "try, then
 * fall back", which this deployment has no way to express: it either verifies
 * or it does not, and silently downgrading a connection because a URL said
 * `prefer` is the opposite of what a security-relevant default should do.
 * Those two fall through to the host heuristic.
 *
 * `verify-ca` maps to `verify-full`. libpq distinguishes them by whether the
 * hostname is checked; skipping that check is not something worth offering a
 * spelling for.
 */
function sslModeFromUrl(
  value: string
): "disable" | "require" | "verify-full" | undefined {
  let mode: string | null
  try {
    mode = new URL(value).searchParams.get("sslmode")
  } catch {
    return undefined
  }
  switch (mode) {
    case "disable":
      return "disable"
    case "require":
      return "require"
    case "verify-ca":
    case "verify-full":
      return "verify-full"
    default:
      return undefined
  }
}

function toArray(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value]
}

function normalizeResource(entry: OAuthResourceConfig): EffectiveResource {
  if (typeof entry === "string") return { identifier: entry, name: entry }
  return {
    identifier: entry.identifier,
    name: entry.name ?? entry.identifier,
    allowedScopes: entry.allowedScopes,
    accessTokenTtl: entry.accessTokenTtl,
  }
}

export function deriveConfig(
  file: ConfigFile,
  clients: readonly ClientEntry[],
  roles: readonly RoleEntry[]
): IdpConfig {
  const base = parseBasePath(file.server.baseUrl, {
    path: file.server.cookiePath,
    domain: file.server.cookieDomain,
    dynamicIssuer: file.server.dynamicIssuer,
  })
  const emailEnabled = Boolean(file.email.resend.apiKey)
  const defaultAudience = toArray(file.jwt.audience)

  // FR-OIDC-6: the registry is the union of the configured resources, the
  // default audience, and every per-client audience. First declaration wins so
  // an explicit `oauth.resources` entry keeps its TTL and scope policy.
  const resources = new Map<string, EffectiveResource>()
  for (const entry of file.oauth.resources) {
    const resource = normalizeResource(entry)
    if (!resources.has(resource.identifier))
      resources.set(resource.identifier, resource)
  }
  for (const identifier of defaultAudience) {
    if (!resources.has(identifier))
      resources.set(identifier, { identifier, name: identifier })
  }
  for (const client of clients) {
    if (client.audience === undefined) continue
    for (const identifier of toArray(client.audience)) {
      if (!resources.has(identifier))
        resources.set(identifier, { identifier, name: identifier })
    }
  }

  const longestTokenLifetime = Math.max(
    file.oauth.accessTokenTtl,
    file.oauth.idTokenTtl,
    file.oauth.refreshTokenTtl,
    file.oauth.refreshTokenMaxLifetime,
    file.jwt.sessionToken.ttl,
    file.apiKeys.tokenTtl
  )

  // D68: an empty list is not "trust only the issuer" — it is "nothing was
  // configured", and a deployment behind a reverse proxy usually cannot
  // configure it. `[]` written out is the same statement as the key being
  // absent, so both land in the same place rather than one of them meaning a
  // stricter thing than an operator could have intended.
  const configuredOrigins = file.server.trustedOrigins ?? []
  const trustedOrigins = new Set<string>([base.origin, ...configuredOrigins])

  const defaultRole =
    roles.find((role) => role.default)?.name ?? roles[0]?.name ?? "user"

  // D74: two names, one or two endpoints. Each role falls back to the other,
  // so a deployment that has only a direct endpoint uses it for everything and
  // one that has only a pooled endpoint is warned by `runCrossChecks` rather
  // than silently taking session locks that do not hold.
  //
  // The `??` chain cannot produce `undefined` — `databaseSchema` refuses a
  // block with neither — but the schema's guarantee is not visible in the
  // inferred type, and a `!` here would be a claim with nothing behind it if
  // that refinement is ever removed. So it is checked, once, at the only
  // point where both values are in scope.
  const databaseUrl = file.database.url ?? file.database.directUrl
  const databaseDirectUrl = file.database.directUrl ?? file.database.url
  if (databaseUrl === undefined || databaseDirectUrl === undefined) {
    throw new Error(
      "database.url and database.directUrl are both unset; the config schema should have refused this."
    )
  }

  return {
    file,
    clients,
    roles,
    base,
    trustedOrigins: [...trustedOrigins],
    trustRequestOrigin: configuredOrigins.length === 0,
    emailEnabled,
    // FR-MAIL-2: without a transport there is no way to verify an address.
    requireEmailVerification: emailEnabled
      ? file.auth.requireEmailVerification
      : false,
    twoFactorIssuer: file.twoFactor.issuer ?? file.site.name,
    // Three sources, most explicit first: what the config says, what the
    // connection string says, and — only if neither said anything — the
    // assumption that a non-local host means an untrusted wire.
    databaseUrl,
    databaseDirectUrl,
    databaseSsl:
      file.database.ssl ??
      sslModeFromUrl(databaseUrl) ??
      (isLocalhostUrl(databaseUrl) ? "disable" : "require"),
    jwksGracePeriodSeconds: file.jwt.gracePeriod ?? longestTokenLifetime + 3600,
    defaultAudience,
    resources: [...resources.values()],
    userClaims: file.jwt.includeUserData
      ? (file.jwt.userClaims ?? [...USER_CLAIM_NAMES])
      : [],
    defaultRole,
    adminRoles: file.admin.adminRoles,
    allowImpersonation: file.admin.allowImpersonation,
    isProduction: base.secure,
  }
}
