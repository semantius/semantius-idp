/**
 * zod schema for `config.json` — the full CFG-4 key inventory.
 *
 * Rules that hold across the whole file:
 * - every object is strict (`additionalProperties: false`, CFG-5) except the
 *   social-provider entries, which pass provider-specific options through;
 * - keys with a default are optional here and resolved in `derive.ts`, because
 *   several defaults depend on other keys (`trustedOrigins` ← `baseUrl`,
 *   `twoFactor.issuer` ← `site.name`, `jwt.gracePeriod` ← token lifetimes);
 * - cross-file and cross-key rules live in `cross-checks.ts`, not here, so that
 *   a single validation pass can report every problem at once.
 */

import { z } from "zod"

import {
  absoluteUrl,
  duration,
  flexArray,
  flexBoolean,
  flexInt,
  flexRecord,
} from "../zod-helpers"

/**
 * Claim names the IdP owns. `jwt.claims` may not redefine them (FR-OIDC-8):
 * they are either protocol-reserved or produced by the claims builder.
 */
export const RESERVED_CLAIM_NAMES = [
  "iss",
  "sub",
  "aud",
  "exp",
  "iat",
  "nbf",
  "jti",
  "scope",
  "auth_time",
  "azp",
  "sid",
  "client_id",
  "roles",
  "email",
  "name",
  "given_name",
  "family_name",
] as const

/** Optional user claims selectable through `jwt.userClaims` (FR-OIDC-7). */
export const USER_CLAIM_NAMES = [
  "email",
  "name",
  "given_name",
  "family_name",
  "roles",
] as const
export type UserClaimName = (typeof USER_CLAIM_NAMES)[number]

/** Signing algorithms Neon accepts (V5). Anything else fails validation (FR-OIDC-5). */
export const SUPPORTED_JWT_ALGORITHMS = ["ES256", "RS256"] as const

/** Entra pseudo-tenants that would defeat the FR-SOC-5 tenant lock. */
export const REJECTED_ENTRA_TENANTS = [
  "common",
  "organizations",
  "consumers",
] as const

const cidr = z
  .string()
  .regex(
    /^[0-9a-fA-F.:]+\/\d{1,3}$/,
    "Expected a CIDR range, e.g. `10.0.0.0/8`."
  )

const serverSchema = z.strictObject({
  baseUrl: absoluteUrl().describe(
    "Issuer. Scheme + host[:port] + optional path, no trailing slash. Every absolute URL the IdP emits derives from this value only."
  ),
  host: z
    .string()
    .default("0.0.0.0")
    .describe("Listen address. Also settable with HOST."),
  port: flexInt({ min: 1, max: 65535 })
    .default(3000)
    .describe("Listen port. Also settable with PORT."),
  trustProxy: z
    .union([flexBoolean(), flexArray(cidr)])
    .default(false)
    .describe(
      "Honour X-Forwarded-* from the immediate upstream (true) or from the listed CIDR ranges. Client IP is the rightmost untrusted hop."
    ),
  trustedOrigins: flexArray(absoluteUrl())
    .optional()
    .describe("CSRF origin allow-list. Defaults to [server.baseUrl]."),
  allowInsecureHttp: flexBoolean()
    .default(false)
    .describe(
      "Permit a non-https baseUrl outside localhost. Development only."
    ),
  shutdownTimeoutSeconds: flexInt({ min: 0, max: 300 })
    .default(10)
    .describe("SIGTERM drain budget."),
})

const databaseSchema = z.strictObject({
  url: z
    .string()
    .min(1)
    .describe("Postgres connection string. Fallback env: DATABASE_URL."),
  directUrl: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Connection string for steps that hold a session advisory lock — startup, migrations, the CLI and the cleanup job. Required when `database.url` points at a transaction-mode connection pooler (Neon's `-pooler` endpoint, PgBouncer), where session locks do not hold. Fallback env: DIRECT_DATABASE_URL."
    ),
  schema: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/, "Schema names must match [a-z_][a-z0-9_]*.")
    .default("idp")
    .describe(
      "All IdP tables and the drizzle migrations table live here; nothing is created in `public`."
    ),
  ssl: z
    .enum(["disable", "require", "verify-full"])
    .optional()
    .describe(
      "Overrides the connection string's sslmode. Defaults to `require` unless the host is localhost."
    ),
  sslCa: z
    .string()
    .optional()
    .describe(
      "PEM certificate authority, typically `${file:/run/secrets/ca.pem}`."
    ),
  poolMax: flexInt({ min: 1, max: 200 }).default(10),
  connectTimeoutSeconds: flexInt({ min: 1, max: 300 }).default(30),
  migrateOnBoot: flexBoolean()
    .default(true)
    .describe("Also settable with IDP_MIGRATE_ON_BOOT."),
})

const siteSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .describe("Branding name; also the default TOTP issuer label."),
  logo: z
    .string()
    .optional()
    .describe("Path under `branding/` or an absolute URL."),
  favicon: z.string().optional(),
  supportEmail: z.email().optional(),
  termsUrl: absoluteUrl().optional(),
  privacyUrl: absoluteUrl().optional(),
  theme: z.enum(["system", "light", "dark"]).default("system"),
  defaultLocale: z
    .string()
    .default("en-US")
    .describe("Only `en-US` ships in v1 (FR-I18N-1)."),
})

const emailSchema = z.strictObject({
  resend: z
    .strictObject({
      apiKey: z
        .string()
        .optional()
        .describe(
          "Absent ⇒ degraded mode: every e-mail feature is disabled (FR-MAIL-2)."
        ),
    })
    .prefault({}),
  from: z
    .string()
    .optional()
    .describe("Required whenever an API key is configured."),
  replyTo: z.string().optional(),
})

const signUpSchema = z.strictObject({
  enabled: flexBoolean()
    .default(false)
    .describe("Governs password and social registration alike (FR-SIGNUP-1)."),
  requireApproval: flexBoolean()
    .default(true)
    .describe("Self-registrations land as `pending` (FR-SIGNUP-2)."),
  allowedEmailDomains: flexArray(z.string().min(1))
    .default([])
    .describe("Empty = no restriction. Admin-created users always bypass it."),
})

/**
 * `auth.defaultRedirect` (D28) — a same-origin relative path, or an absolute
 * http(s) URL on any origin.
 *
 * Cross-origin is allowed here and nowhere else: this value comes from the
 * operator's own configuration file, not from a request, so it cannot be an
 * open redirect. The runtime `returnTo` parameter is a different thing
 * entirely and stays same-origin-relative-only — see `safeReturnTo` (SEC-3).
 *
 * A bare hostname (`example.com`) is the trap this guards: it is neither, and
 * silently resolving it as a relative path would send everyone to
 * `/example.com`.
 */
function postSignInDestination() {
  return z.string().superRefine((value, ctx) => {
    const reject = (message: string) => ctx.addIssue({ code: "custom", message })

    if (value.startsWith("/")) {
      // The same three shapes `safeReturnTo` refuses: both are read by a
      // browser as an origin, whatever the leading slash suggests.
      if (value.startsWith("//") || value.startsWith("/\\")) {
        reject(`\`${value}\` is protocol-relative, not a path on this origin.`)
      } else if (value.includes("://")) {
        reject(`\`${value}\` looks like a URL smuggled into a path.`)
      }
      return
    }

    let url: URL
    try {
      url = new URL(value)
    } catch {
      reject(
        `\`${value}\` is neither a path starting with \`/\` nor an absolute http(s) URL.`
      )
      return
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      reject(`\`${value}\` must use http or https.`)
    }
  })
}

const authSchema = z.strictObject({
  defaultRedirect: postSignInDestination()
    .default("/account")
    .describe(
      "Where a completed sign-in lands when no OAuth continuation and no validated returnTo apply. Relative path, or an absolute URL when the IdP sits beside the product."
    ),
  requireEmailVerification: flexBoolean()
    .default(true)
    .describe(
      "Gates password sign-in only. Forced false when e-mail is not configured."
    ),
  password: z
    .strictObject({
      minLength: flexInt({ min: 8, max: 128 }).default(12),
      maxLength: flexInt({ min: 12, max: 512 }).default(128),
      breachCheck: flexBoolean()
        .default(false)
        .describe(
          "Check the password against Have I Been Pwned at sign-up and change."
        ),
    })
    .prefault({}),
  passwordReset: z
    .strictObject({
      tokenTtlMinutes: flexInt({ min: 1, max: 1440 }).default(60),
    })
    .prefault({}),
})

const sessionSchema = z.strictObject({
  expiresIn: duration({ min: 60 }).prefault("7d"),
  updateAge: duration({ min: 60 }).prefault("1d"),
  cookieCacheMinutes: flexInt({ min: 0, max: 5 })
    .default(5)
    .describe("Capped at 5 so revocations bite quickly (FR-AUTH-5)."),
  freshAgeMinutes: flexInt({ min: 1, max: 1440 })
    .default(15)
    .describe("Sensitive actions require a session fresher than this."),
  revokeOAuthTokensOnLogout: flexBoolean().default(false),
})

/**
 * Social providers are loose objects: `enabled`/`clientId`/`clientSecret` and
 * the IdP's own knobs are typed, everything else is passed to the Better Auth
 * provider verbatim (FR-SOC-1).
 */
const socialProviderSchema = z.looseObject({
  enabled: flexBoolean().default(true),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  syncProfile: flexBoolean()
    .default(true)
    .describe(
      "Refresh profile fields from the provider on every sign-in (FR-SOC-4)."
    ),
  allowedEmailDomains: flexArray(z.string().min(1)).default([]),
  tenantId: z
    .string()
    .optional()
    .describe(
      "Required for `microsoft`: a tenant GUID or verified domain (FR-SOC-5)."
    ),
})

const twoFactorSchema = z.strictObject({
  enabled: flexBoolean().default(true),
  issuer: z
    .string()
    .optional()
    .describe("TOTP issuer label. Defaults to site.name."),
  trustDeviceDays: flexInt({ min: 0, max: 365 }).default(30),
})

const apiKeysSchema = z.strictObject({
  enabled: flexBoolean().default(true),
  defaultExpiresIn: duration({ min: 60 }).prefault("365d"),
  maxExpiresIn: duration({ min: 60 }).prefault("730d"),
  tokenClientId: z
    .string()
    .min(1)
    .default("idp")
    .describe("`azp` of JWTs exchanged from an API key (FR-KEY-3)."),
  tokenTtl: duration({ min: 60, max: 86400 }).prefault(3600),
})

const jwtSchema = z.strictObject({
  algorithm: z
    .enum(SUPPORTED_JWT_ALGORITHMS)
    .default("ES256")
    .describe(
      "Neon validates ES256 and RS256 only; any other algorithm is rejected at startup."
    ),
  audience: z
    .union([absoluteUrl(), flexArray(absoluteUrl(), { min: 1 })])
    .describe(
      "Default RFC 8707 resource, applied whenever a client sends no `resource` parameter. Becomes the JWT `aud`."
    ),
  includeUserData: flexBoolean().default(true),
  userClaims: flexArray(z.enum(USER_CLAIM_NAMES))
    .optional()
    .describe(
      "Subset selector over {email, name, given_name, family_name, roles}. Defaults to all of them."
    ),
  claims: flexRecord(z.union([z.string(), z.number(), z.boolean()]))
    .prefault({})
    .describe(
      'Static claims merged into access tokens, e.g. `{ "role": "authenticated" }` for Neon/PostgREST.'
    ),
  claimsInIdToken: flexBoolean().default(false),
  rotationInterval: duration({ min: 3600 }).prefault("90d"),
  gracePeriod: duration({ min: 60 })
    .optional()
    .describe(
      "Retired keys stay published for this long. Defaults to the longest token lifetime + 1 h."
    ),
  sessionToken: z
    .strictObject({
      ttl: duration({ min: 60, max: 86400 }).prefault(3600),
    })
    .prefault({}),
})

const oauthResourceSchema = z.union([
  absoluteUrl(),
  z.strictObject({
    identifier: absoluteUrl(),
    name: z.string().optional(),
    allowedScopes: flexArray(z.string().min(1)).optional(),
    accessTokenTtl: duration({ min: 60 }).optional(),
  }),
])

const oauthSchema = z.strictObject({
  accessTokenTtl: duration({ min: 60 }).prefault("15m"),
  idTokenTtl: duration({ min: 60 }).prefault("1h"),
  codeTtl: duration({ min: 10, max: 600 }).prefault("60s"),
  refreshTokenTtl: duration({ min: 60 }).prefault("30d"),
  refreshTokenMaxLifetime: duration({ min: 60 }).prefault("90d"),
  scopes: flexArray(z.string().min(1)).default([
    "openid",
    "profile",
    "email",
    "offline_access",
  ]),
  resources: flexArray(oauthResourceSchema).default([]),
  reconcile: z
    .strictObject({
      prune: flexBoolean()
        .default(false)
        .describe(
          "Delete rows for clients no longer in the file instead of disabling them (FR-OIDC-2)."
        ),
    })
    .prefault({}),
})

const adminSchema = z.strictObject({
  adminRoles: flexArray(z.string().min(1)).default(["admin"]),
  bootstrap: z
    .strictObject({
      email: z.string().default(""),
      password: z.string().default(""),
      name: z.string().optional(),
    })
    .optional()
    .describe(
      "Created once, iff no user holds an admin role (FR-ADMIN-1). Empty values skip bootstrap with a warning."
    ),
  allowImpersonation: flexBoolean().default(false),
})

const rateLimitSchema = z.strictObject({
  enabled: flexBoolean().default(true),
  storage: z.enum(["database", "memory"]).default("database"),
})

const loggingSchema = z.strictObject({
  level: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  format: z.enum(["json", "pretty"]).default("json"),
})

export const configFileSchema = z.strictObject({
  server: serverSchema,
  secret: z
    .string()
    .describe(
      "≥ 32 random bytes. Fallback env: BETTER_AUTH_SECRET. Must be a placeholder in production."
    ),
  database: databaseSchema,
  site: siteSchema,
  email: emailSchema.prefault({}),
  signUp: signUpSchema.prefault({}),
  auth: authSchema.prefault({}),
  session: sessionSchema.prefault({}),
  social: z.record(z.string(), socialProviderSchema).prefault({}),
  twoFactor: twoFactorSchema.prefault({}),
  apiKeys: apiKeysSchema.prefault({}),
  jwt: jwtSchema,
  oauth: oauthSchema.prefault({}),
  admin: adminSchema.prefault({}),
  rateLimit: rateLimitSchema.prefault({}),
  logging: loggingSchema.prefault({}),
  cleanup: z
    .strictObject({
      intervalMinutes: flexInt({ min: 1, max: 1440 }).default(60),
    })
    .prefault({}),
  audit: z
    .strictObject({ retentionDays: flexInt({ min: 1, max: 3650 }).default(90) })
    .prefault({}),
})

export type ConfigFile = z.infer<typeof configFileSchema>
export type SocialProviderConfig = z.infer<typeof socialProviderSchema>
export type OAuthResourceConfig = z.infer<typeof oauthResourceSchema>
