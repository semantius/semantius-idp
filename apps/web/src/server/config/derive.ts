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
  /** Cookie `Path` attribute — the mount path, or `/` at the host root. */
  cookiePath: string
  /** True when `server.baseUrl` uses https, which drives `Secure` cookies (FR-AUTH-5). */
  secure: boolean
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
  /** `true` when a Resend API key is configured; `false` puts the IdP in degraded mode (FR-MAIL-2). */
  readonly emailEnabled: boolean
  /** `auth.requireEmailVerification`, forced to false when e-mail is off. */
  readonly requireEmailVerification: boolean
  /** TOTP issuer label, defaulting to `site.name`. */
  readonly twoFactorIssuer: string
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

export function parseBasePath(baseUrl: string): BasePathInfo {
  const url = new URL(baseUrl)
  const rawPath = url.pathname.replace(/\/+$/, "")
  const basePath = rawPath === "" || rawPath === "/" ? "" : rawPath
  return {
    origin: url.origin,
    basePath,
    cookiePath: basePath === "" ? "/" : basePath,
    secure: url.protocol === "https:",
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
  const base = parseBasePath(file.server.baseUrl)
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

  const trustedOrigins = new Set<string>([
    base.origin,
    ...(file.server.trustedOrigins ?? []),
  ])

  const defaultRole =
    roles.find((role) => role.default)?.name ?? roles[0]?.name ?? "user"

  return {
    file,
    clients,
    roles,
    base,
    trustedOrigins: [...trustedOrigins],
    emailEnabled,
    // FR-MAIL-2: without a transport there is no way to verify an address.
    requireEmailVerification: emailEnabled
      ? file.auth.requireEmailVerification
      : false,
    twoFactorIssuer: file.twoFactor.issuer ?? file.site.name,
    databaseSsl:
      file.database.ssl ??
      (isLocalhostUrl(file.database.url) ? "disable" : "require"),
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
