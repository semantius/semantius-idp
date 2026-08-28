/**
 * zod schema for `config.jsonc` — the full CFG-4 key inventory.
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

/**
 * An entry of `server.trustedOrigins`: an absolute origin, a wildcard pattern
 * Better Auth understands (`https://*.example.com` — `absoluteUrl` parses one,
 * because `URL` accepts `*` in a hostname), or the bare `*` that turns the
 * origin check off entirely (**D68**).
 *
 * `*` is spelled out here rather than through a union so the exported JSON
 * schema stays a plain `string[]`, which is what an editor's completion and
 * the generated reference both read.
 */
const trustedOrigin = z.string().superRefine((value, ctx) => {
  if (value === "*") return
  const result = absoluteUrl().safeParse(value)
  if (result.success) return
  for (const issue of result.error.issues) {
    ctx.addIssue({ code: "custom", message: issue.message })
  }
})

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
  trustedOrigins: flexArray(trustedOrigin)
    .optional()
    .describe(
      "CSRF origin allow-list. Empty by default, which trusts the address each request actually arrived on (its X-Forwarded-Host, or its Host) — what a deployment behind a reverse proxy needs when its public URL is not known at configuration time. Set it to pin the check to named origins instead; `https://*.example.com` matches a subdomain and `*` turns the check off."
    ),
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
    .optional()
    .describe(
      "Connection string for ordinary application traffic. A transaction-mode pooler belongs here and nowhere else. Optional: when it is absent, `directUrl` serves both roles, which is the single-endpoint deployment (**D74**). Fallback env: DATABASE_URL."
    ),
  directUrl: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Direct, non-pooled connection string, used by every step that holds a session advisory lock — startup, migrations, the CLI and the cleanup job — because session locks do not hold through a transaction-mode pooler. This is the connection that must always work; `url` is the optional optimisation beside it. At least one of the two must be set, and when `url` looks pooled this one is required. Fallback env: DATABASE_URL_ADMIN."
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
  poolMax: flexInt({ min: 1, max: 200 })
    .default(10)
    .describe(
      "Maximum pooled connections. One instance is the supported topology, so this is the whole deployment's budget." // OPS-11
    ),
  connectTimeoutSeconds: flexInt({ min: 1, max: 300 })
    .default(30)
    .describe("How long a new connection may take before start-up gives up."),
  migrateOnBoot: flexBoolean()
    .default(true)
    .describe("Also settable with IDP_MIGRATE_ON_BOOT."),
}).superRefine((database, ctx) => {
  // Both fields are optional individually and at least one is mandatory
  // together, because which of the two a deployment has depends on its
  // Postgres and not on this schema (**D74**). Neon hands out a pooled and a
  // direct endpoint; a plain Postgres or the bundled compose one is a single
  // endpoint that is already direct. Making `url` the required field — as it
  // was — meant an operator who had only the direct endpoint had to put it
  // under the name that describes the pooled one, and one who set only
  // `DATABASE_URL_ADMIN` was refused outright for a configuration that is
  // perfectly serviceable.
  if (database.url === undefined && database.directUrl === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["url"],
      message:
        "Set `database.url`, `database.directUrl`, or both — at least one connection string is required. A single-endpoint deployment can use either name; `directUrl` is the one that must be a direct, non-pooled connection. Fallback env: DATABASE_URL, DATABASE_URL_ADMIN.",
    })
  }
})

const siteSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .describe("Branding name; also the default TOTP issuer label."),
  adminTitle: z
    .string()
    .min(1)
    .optional()
    .describe(
      "What the administration area calls itself, when that is not `site.name` — a deployment whose users think of it as \"User Manager\" rather than as the identity provider (D61). Branding only: it never reaches the TOTP issuer label, the e-mails or anything a token carries. Defaults to `site.name`."
    ),
  logo: z
    .string()
    .optional()
    .describe("Path under `branding/` or an absolute URL."),
  favicon: z
    .string()
    .optional()
    .describe(
      "As `site.logo`. Both `icon.png` and `branding/icon.png` name the same file (D44)."
    ),
  supportEmail: z
    .email()
    .optional()
    .describe(
      "Shown to someone who cannot get in — on the suspended-account page, and in the rejection e-mail."
    ),
  termsUrl: absoluteUrl()
    .optional()
    .describe("Linked from the sign-up form and the consent screen."),
  privacyUrl: absoluteUrl()
    .optional()
    .describe("Linked from the sign-up form and the consent screen."),
  theme: z
    .enum(["system", "light", "dark"])
    .default("system")
    .describe(
      "`system` follows the browser. The built-in themes are the only ones; there is no custom CSS hook in v1."
    ),
  defaultLocale: z
    .string()
    .default("en-US")
    .describe("Only `en-US` ships in v1."), // FR-I18N-1
  nameFormat: z
    .enum(["first-last", "last-first"])
    .default("first-last")
    .describe(
      'How a display name is composed from the first and last name that were captured (D49). `first-last` gives "Jane Smith"; `last-first` gives "Smith, Jane". The name itself is never an input field.'
    ),
})

const emailSchema = z.strictObject({
  resend: z
    .strictObject({
      apiKey: z
        .string()
        .optional()
        .describe(
          "Absent ⇒ degraded mode: every e-mail feature is disabled." // FR-MAIL-2
        ),
    })
    .prefault({}),
  from: z
    .string()
    .optional()
    .describe("Required whenever an API key is configured."),
  replyTo: z
    .string()
    .optional()
    .describe(
      "Where a reply goes. Absent, replies go to `email.from`, which is usually a mailbox nobody reads."
    ),
})

const signUpSchema = z.strictObject({
  enabled: flexBoolean()
    .default(false)
    .describe("Governs password and social registration alike."), // FR-SIGNUP-1
  requireApproval: flexBoolean()
    .default(true)
    .describe("Self-registrations land as `pending`."), // FR-SIGNUP-2
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
    const reject = (message: string) =>
      ctx.addIssue({ code: "custom", message })

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
      minLength: flexInt({ min: 8, max: 128 })
        .default(10)
        .describe(
          "Length is the only strength rule here. Composition rules push people towards P@ssw0rd1 and are not worth the support load."
        ),
      maxLength: flexInt({ min: 12, max: 512 })
        .default(128)
        .describe(
          "An upper bound exists because the hash is computed over the whole value; it is not a strength policy."
        ),
      breachCheck: flexBoolean()
        .default(false)
        .describe(
          "Check the password against Have I Been Pwned at sign-up and change."
        ),
    })
    .prefault({}),
  passwordReset: z
    .strictObject({
      tokenTtlMinutes: flexInt({ min: 1, max: 1440 })
        .default(60)
        .describe(
          "Reset links expire after this; verification links are fixed at 24 h."
        ),
    })
    .prefault({}),
})

const sessionSchema = z.strictObject({
  expiresIn: duration({ min: 60 })
    .prefault("7d")
    .describe("How long a browser session lives without being renewed."),
  updateAge: duration({ min: 60 })
    .prefault("1d")
    .describe("A session older than this is extended on the next request."),
  cookieCacheMinutes: flexInt({ min: 0, max: 5 })
    .default(5)
    .describe("Capped at 5 so revocations bite quickly."), // FR-AUTH-5
  revokeOAuthTokensOnLogout: flexBoolean()
    .default(false)
    .describe(
      "Whether signing out of the IdP also kills the OAuth tokens issued to clients from that session. Off by default: a user closing this tab does not usually mean to sign out of every application they use." // FR-AUTH-6
    ),
})

/**
 * Social providers are loose objects: `enabled`/`clientId`/`clientSecret` and
 * the IdP's own knobs are typed, everything else is passed to the Better Auth
 * provider verbatim (FR-SOC-1).
 */
const socialProviderSchema = z.looseObject({
  enabled: flexBoolean().default(true),
  clientId: z.string().min(1).describe("From the provider's own console."),
  clientSecret: z
    .string()
    .min(1)
    .describe("A `${env:…}` placeholder in production; never a literal."),
  syncProfile: flexBoolean()
    .default(true)
    .describe(
      "Refresh profile fields from the provider on every sign-in." // FR-SOC-4
    ),
  allowedEmailDomains: flexArray(z.string().min(1))
    .default([])
    .describe(
      "Restricts this provider to addresses in these domains. Empty = no restriction."
    ),
  tenantId: z
    .string()
    .optional()
    .describe(
      "Required for `microsoft`: a tenant GUID or verified domain." // FR-SOC-5
    ),
})

const twoFactorSchema = z.strictObject({
  enabled: flexBoolean()
    .default(true)
    .describe(
      "Whether users may enrol at all. Enrolment is per user and always optional; turning this off hides the whole feature." // FR-2FA-1
    ),
  issuer: z
    .string()
    .optional()
    .describe("TOTP issuer label. Defaults to site.name."),
  trustDeviceDays: flexInt({ min: 0, max: 365 })
    .default(30)
    .describe(
      "How long a device stays trusted after a successful challenge. `0` asks every time and removes the checkbox."
    ),
})

const apiKeysSchema = z.strictObject({
  enabled: flexBoolean()
    .default(true)
    .describe("Off hides the account page and 404s its route."), // FR-KEY-1
  defaultExpiresIn: duration({ min: 60 })
    .prefault("365d")
    .describe("Pre-filled expiry on the create form."),
  maxExpiresIn: duration({ min: 60 })
    .prefault("730d")
    .describe("The longest expiry a user may choose."),
  tokenClientId: z
    .string()
    .min(1)
    .default("idp")
    .describe("`azp` of JWTs exchanged from an API key."), // FR-KEY-3
  tokenTtl: duration({ min: 60, max: 86400 })
    .prefault(3600)
    .describe("Lifetime of a JWT exchanged from a key."), // FR-KEY-3
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
  includeUserData: flexBoolean()
    .default(true)
    .describe(
      "Whether access tokens carry the user's name, address and roles at all. Off removes exactly that set." // FR-OIDC-7
    ),
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
  claimsInIdToken: flexBoolean()
    .default(false)
    .describe(
      "Also merge `jwt.claims` into ID tokens. Off by default: an ID token asserts authentication, and profile data belongs at userinfo."
    ),
  rotationInterval: duration({ min: 3600 })
    .prefault("90d")
    .describe(
      "How often a new signing key is created. The old one keeps verifying for `jwt.gracePeriod`." // FR-OIDC-16
    ),
  gracePeriod: duration({ min: 60 })
    .optional()
    .describe(
      "Retired keys stay published for this long. Defaults to the longest token lifetime + 1 h."
    ),
  sessionToken: z
    .strictObject({
      ttl: duration({ min: 60, max: 86400 })
        .prefault(3600)
        .describe(
          "Lifetime of a JWT from `GET /api/auth/token`, the first-party session exchange." // FR-OIDC-14
        ),
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
  accessTokenTtl: duration({ min: 60 })
    .prefault("15m")
    .describe(
      "Also the window in which a revoked token still verifies for a stateless resource server." // FR-OIDC-12
    ),
  idTokenTtl: duration({ min: 60 }).prefault("1h"),
  codeTtl: duration({ min: 10, max: 600 })
    .prefault("60s")
    .describe("Authorization codes are single-use as well as short-lived."),
  refreshTokenTtl: duration({ min: 60 })
    .prefault("30d")
    .describe("Sliding: every use rotates the token and restarts this clock."),
  refreshTokenMaxLifetime: duration({ min: 60 })
    .prefault("90d")
    .describe(
      "The ceiling the sliding window cannot pass. After this the user signs in again."
    ),
  scopes: flexArray(z.string().min(1))
    .default(["openid", "profile", "email", "offline_access"])
    .describe(
      "Every scope any client may request. A client's own `scopes` must be a subset."
    ),
  resources: flexArray(oauthResourceSchema)
    .default([])
    .describe(
      "Extra RFC 8707 resources beyond `jwt.audience` and the per-client ones, each optionally with its own allowed scopes and token lifetime."
    ),
  reconcile: z
    .strictObject({
      prune: flexBoolean()
        .default(false)
        .describe(
          "Delete rows for clients no longer in the file instead of disabling them." // FR-OIDC-2
        ),
    })
    .prefault({}),
})

const adminSchema = z.strictObject({
  adminRoles: flexArray(z.string().min(1))
    .default(["admin"])
    .describe(
      "Holding any of these opens `/admin` and the admin API. Every name must exist in the role catalog."
    ),
  allowImpersonation: flexBoolean()
    .default(false)
    .describe(
      "Lets an administrator act as another user, ≤ 1 h, never against another administrator, every action audited." // FR-ADMIN-5
    ),
  database: z
    .enum(["disabled", "read-only", "read-write"])
    .default("disabled")
    .describe(
      "`/admin/database`, a schema explorer and SQL console over this deployment's own Postgres. `read-only` runs every statement in a READ ONLY transaction; `read-write` adds a mode toggle and commits when it is set. `disabled` removes the page, the nav entry and both endpoints. One statement per run, 10 s timeout, 500-row cap, every execution audited as `database.queried`. An administrator who can run SQL can read every row at rest — password hashes and session tokens included — so leave it off unless that is intended." // FR-ADMIN-7
    ),
})

const rateLimitSchema = z.strictObject({
  enabled: flexBoolean()
    .default(true)
    .describe(
      "Turning this off removes the rate limits on sign-in, reset, 2FA and the token endpoint. For tests."
    ), // SEC-2
  storage: z
    .enum(["database", "memory"])
    .default("database")
    .describe(
      "`database` survives a restart, which is the point of a limit. `memory` is for a single process nobody restarts to get past it."
    ),
})

const loggingSchema = z.strictObject({
  level: z
    .enum(["trace", "debug", "info", "warn", "error"])
    .default("info")
    .describe("Also settable with LOG_LEVEL."),
  format: z
    .enum(["json", "pretty"])
    .default("json")
    .describe(
      "`json` for anything that collects logs; `pretty` for a terminal. Also settable with LOG_FORMAT."
    ),
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
  social: z
    .record(z.string(), socialProviderSchema)
    .prefault({})
    .describe(
      "Keyed by provider id — `google`, `github`, `microsoft`. Each entry needs `clientId` and `clientSecret`; `microsoft` also needs `tenantId`." // FR-SOC-5
    ),
  twoFactor: twoFactorSchema.prefault({}),
  apiKeys: apiKeysSchema.prefault({}),
  jwt: jwtSchema,
  oauth: oauthSchema.prefault({}),
  admin: adminSchema.prefault({}),
  rateLimit: rateLimitSchema.prefault({}),
  logging: loggingSchema.prefault({}),
  cleanup: z
    .strictObject({
      intervalMinutes: flexInt({ min: 1, max: 1440 })
        .default(60)
        .describe(
          "How often the retention job runs: expired sessions, spent verification rows, dead tokens, stale rate-limit rows and retired keys." // OPS-8, DM-5
        ),
    })
    .prefault({}),
  audit: z
    .strictObject({
      retentionDays: flexInt({ min: 1, max: 3650 })
        .default(90)
        .describe(
          "How long audit rows are kept. They are the answer to what happened, so a short window is a decision, not a saving."
        ),
    })
    .prefault({}),
})

export type ConfigFile = z.infer<typeof configFileSchema>
export type SocialProviderConfig = z.infer<typeof socialProviderSchema>
export type OAuthResourceConfig = z.infer<typeof oauthResourceSchema>
