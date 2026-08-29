/**
 * GENERATED FILE — do not edit.
 *
 * Produced by `bun run scripts/generate-auth-schema.ts` from the installed
 * Better Auth and the plugin list in `src/server/auth/instance.ts` (DM-1).
 * CI regenerates it and fails on any difference, so the committed migrations
 * can never describe a schema the running code does not expect.
 *
 * Every table is scoped to a Postgres schema (DM-4). The name is a *runtime*
 * value — `database.schema`, default `idp` — so the tables come from a
 * factory the database client calls once, and the migrator rewrites the
 * canonical schema identifier in the committed SQL to match.
 */

import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"

/**
 * The schema name the committed migrations are written against. The runtime
 * migrator rewrites this identifier when `database.schema` differs, so it is a
 * canonical value in the SQL, not a hard-coded deployment decision.
 */
export const CANONICAL_SCHEMA_NAME = "idp"

/**
 * Builds every table inside `schemaName` (CFG-4 `database.schema`, DM-4).
 *
 * Drizzle needs the schema name when the table is *defined*, so the tables are
 * produced by a factory the database client calls once with the configured
 * name, rather than captured at module load from a constant.
 */
export function createAuthSchema(schemaName: string) {
  const idpSchema = pgSchema(schemaName)

  const user = idpSchema.table(
    "user",
    {
      id: text("id").primaryKey(),
      name: text("name").notNull(),
      email: text("email").notNull().unique(),
      emailVerified: boolean("email_verified").default(false).notNull(),
      image: text("image"),
      createdAt: timestamp("created_at").defaultNow().notNull(),
      updatedAt: timestamp("updated_at")
        .defaultNow()
        .$onUpdate(() => new Date())
        .notNull(),
      role: text("role"),
      banned: boolean("banned").default(false),
      banReason: text("ban_reason"),
      banExpires: timestamp("ban_expires"),
      twoFactorEnabled: boolean("two_factor_enabled").default(false),
      firstName: text("first_name"),
      lastName: text("last_name"),
      status: text("status", { enum: ["pending", "active", "rejected"] })
        .default("pending")
        .notNull(),
      approvedAt: timestamp("approved_at"),
      approvedBy: text("approved_by"),
      mustChangePassword: boolean("must_change_password").default(false),
    },
    (table) => [index("user_status_idx").on(table.status)]
  )

  const session = idpSchema.table(
    "session",
    {
      id: text("id").primaryKey(),
      expiresAt: timestamp("expires_at").notNull(),
      token: text("token").notNull().unique(),
      createdAt: timestamp("created_at").defaultNow().notNull(),
      updatedAt: timestamp("updated_at")
        .$onUpdate(() => new Date())
        .notNull(),
      ipAddress: text("ip_address"),
      userAgent: text("user_agent"),
      userId: text("user_id")
        .notNull()
        .references(() => user.id, { onDelete: "cascade" }),
      impersonatedBy: text("impersonated_by"),
    },
    (table) => [index("session_userId_idx").on(table.userId)]
  )

  const account = idpSchema.table(
    "account",
    {
      id: text("id").primaryKey(),
      issuer: text("issuer").notNull(),
      accountId: text("account_id").notNull(),
      providerId: text("provider_id").notNull(),
      userId: text("user_id")
        .notNull()
        .references(() => user.id, { onDelete: "cascade" }),
      accessToken: text("access_token"),
      refreshToken: text("refresh_token"),
      idToken: text("id_token"),
      accessTokenExpiresAt: timestamp("access_token_expires_at"),
      refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
      scope: text("scope"),
      password: text("password"),
      createdAt: timestamp("created_at").defaultNow().notNull(),
      updatedAt: timestamp("updated_at")
        .$onUpdate(() => new Date())
        .notNull(),
    },
    (table) => [
      uniqueIndex("account_issuer_accountId_uidx").on(
        table.issuer,
        table.accountId
      ),
      index("account_userId_idx").on(table.userId),
    ]
  )

  const verification = idpSchema.table(
    "verification",
    {
      id: text("id").primaryKey(),
      identifier: text("identifier").notNull(),
      value: text("value").notNull(),
      expiresAt: timestamp("expires_at").notNull(),
      createdAt: timestamp("created_at").defaultNow().notNull(),
      updatedAt: timestamp("updated_at")
        .defaultNow()
        .$onUpdate(() => new Date())
        .notNull(),
    },
    (table) => [index("verification_identifier_idx").on(table.identifier)]
  )

  const jwks = idpSchema.table("jwks", {
    id: text("id").primaryKey(),
    publicKey: text("public_key").notNull(),
    privateKey: text("private_key").notNull(),
    createdAt: timestamp("created_at").notNull(),
    expiresAt: timestamp("expires_at"),
    alg: text("alg"),
    crv: text("crv"),
  })

  const twoFactor = idpSchema.table(
    "two_factor",
    {
      id: text("id").primaryKey(),
      secret: text("secret").notNull(),
      backupCodes: text("backup_codes").notNull(),
      userId: text("user_id")
        .notNull()
        .references(() => user.id, { onDelete: "cascade" }),
      verified: boolean("verified").default(true),
      failedVerificationCount: integer("failed_verification_count").default(0),
      lockedUntil: timestamp("locked_until"),
    },
    (table) => [
      index("twoFactor_secret_idx").on(table.secret),
      index("twoFactor_userId_idx").on(table.userId),
    ]
  )

  const apikey = idpSchema.table(
    "apikey",
    {
      id: text("id").primaryKey(),
      configId: text("config_id").default("default").notNull(),
      name: text("name"),
      start: text("start"),
      referenceId: text("reference_id").notNull(),
      prefix: text("prefix"),
      key: text("key").notNull(),
      refillInterval: integer("refill_interval"),
      refillAmount: integer("refill_amount"),
      lastRefillAt: timestamp("last_refill_at"),
      enabled: boolean("enabled").default(true),
      rateLimitEnabled: boolean("rate_limit_enabled").default(true),
      rateLimitTimeWindow: integer("rate_limit_time_window").default(60000),
      rateLimitMax: integer("rate_limit_max").default(120),
      requestCount: integer("request_count").default(0),
      remaining: integer("remaining"),
      lastRequest: timestamp("last_request"),
      expiresAt: timestamp("expires_at"),
      createdAt: timestamp("created_at").notNull(),
      updatedAt: timestamp("updated_at").notNull(),
      permissions: text("permissions"),
      metadata: text("metadata"),
    },
    (table) => [
      index("apikey_configId_idx").on(table.configId),
      index("apikey_referenceId_idx").on(table.referenceId),
      index("apikey_key_idx").on(table.key),
    ]
  )

  const oauthClient = idpSchema.table(
    "oauth_client",
    {
      id: text("id").primaryKey(),
      clientId: text("client_id").notNull().unique(),
      clientSecret: text("client_secret"),
      clientDiscoveryId: text("client_discovery_id"),
      disabled: boolean("disabled").default(false),
      skipConsent: boolean("skip_consent"),
      enableEndSession: boolean("enable_end_session"),
      subjectType: text("subject_type"),
      scopes: text("scopes").array(),
      clientCredentialsScopes: text("client_credentials_scopes")
        .array()
        .default([]),
      userId: text("user_id").references(() => user.id, {
        onDelete: "cascade",
      }),
      createdAt: timestamp("created_at"),
      updatedAt: timestamp("updated_at"),
      name: text("name"),
      uri: text("uri"),
      icon: text("icon"),
      contacts: text("contacts").array(),
      tos: text("tos"),
      policy: text("policy"),
      softwareId: text("software_id"),
      softwareVersion: text("software_version"),
      softwareStatement: text("software_statement"),
      redirectUris: text("redirect_uris").array().notNull(),
      postLogoutRedirectUris: text("post_logout_redirect_uris").array(),
      backchannelLogoutUri: text("backchannel_logout_uri"),
      backchannelLogoutSessionRequired: boolean(
        "backchannel_logout_session_required"
      ),
      tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
      applicationType: text("application_type"),
      jwks: text("jwks"),
      jwksUri: text("jwks_uri"),
      grantTypes: text("grant_types").array(),
      responseTypes: text("response_types").array(),
      requirePKCE: boolean("require_pkce"),
      dpopBoundAccessTokens: boolean("dpop_bound_access_tokens").default(false),
      referenceId: text("reference_id"),
      metadata: jsonb("metadata"),
    },
    (table) => [index("oauthClient_userId_idx").on(table.userId)]
  )

  const oauthResource = idpSchema.table("oauth_resource", {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull().unique(),
    name: text("name").notNull(),
    accessTokenTtl: integer("access_token_ttl"),
    refreshTokenTtl: integer("refresh_token_ttl"),
    signingAlgorithm: text("signing_algorithm"),
    signingKeyId: text("signing_key_id"),
    allowedScopes: text("allowed_scopes").array(),
    customClaims: jsonb("custom_claims"),
    dpopBoundAccessTokensRequired: boolean(
      "dpop_bound_access_tokens_required"
    ).default(false),
    disabled: boolean("disabled").default(false),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
    policyVersion: integer("policy_version").default(1),
    metadata: jsonb("metadata"),
  })

  const oauthClientResource = idpSchema.table(
    "oauth_client_resource",
    {
      id: text("id").primaryKey(),
      clientId: text("client_id")
        .notNull()
        .references(() => oauthClient.clientId, { onDelete: "cascade" }),
      resourceId: text("resource_id")
        .notNull()
        .references(() => oauthResource.identifier, { onDelete: "cascade" }),
      metadata: jsonb("metadata"),
      createdAt: timestamp("created_at"),
    },
    (table) => [
      uniqueIndex("oauthClientResource_clientId_resourceId_uidx").on(
        table.clientId,
        table.resourceId
      ),
      index("oauthClientResource_clientId_idx").on(table.clientId),
      index("oauthClientResource_resourceId_idx").on(table.resourceId),
    ]
  )

  const oauthRefreshToken = idpSchema.table(
    "oauth_refresh_token",
    {
      id: text("id").primaryKey(),
      token: text("token").notNull().unique(),
      clientId: text("client_id")
        .notNull()
        .references(() => oauthClient.clientId, { onDelete: "cascade" }),
      sessionId: text("session_id").references(() => session.id, {
        onDelete: "set null",
      }),
      userId: text("user_id")
        .notNull()
        .references(() => user.id, { onDelete: "cascade" }),
      referenceId: text("reference_id"),
      authorizationCodeId: text("authorization_code_id"),
      resources: text("resources").array(),
      requestedUserInfoClaims: text("requested_user_info_claims").array(),
      expiresAt: timestamp("expires_at").notNull(),
      createdAt: timestamp("created_at").notNull(),
      revoked: timestamp("revoked"),
      rotatedAt: timestamp("rotated_at"),
      rotationReplayResponse: text("rotation_replay_response"),
      rotationReplayExpiresAt: timestamp("rotation_replay_expires_at"),
      authTime: timestamp("auth_time"),
      confirmation: jsonb("confirmation"),
      scopes: text("scopes").array().notNull(),
    },
    (table) => [
      index("oauthRefreshToken_clientId_idx").on(table.clientId),
      index("oauthRefreshToken_sessionId_idx").on(table.sessionId),
      index("oauthRefreshToken_userId_idx").on(table.userId),
      index("oauthRefreshToken_authorizationCodeId_idx").on(
        table.authorizationCodeId
      ),
    ]
  )

  const oauthAccessToken = idpSchema.table(
    "oauth_access_token",
    {
      id: text("id").primaryKey(),
      token: text("token").notNull().unique(),
      clientId: text("client_id")
        .notNull()
        .references(() => oauthClient.clientId, { onDelete: "cascade" }),
      sessionId: text("session_id").references(() => session.id, {
        onDelete: "set null",
      }),
      userId: text("user_id").references(() => user.id, {
        onDelete: "cascade",
      }),
      referenceId: text("reference_id"),
      authorizationCodeId: text("authorization_code_id"),
      resources: text("resources").array(),
      requestedUserInfoClaims: text("requested_user_info_claims").array(),
      refreshId: text("refresh_id").references(() => oauthRefreshToken.id, {
        onDelete: "cascade",
      }),
      expiresAt: timestamp("expires_at").notNull(),
      createdAt: timestamp("created_at").notNull(),
      revoked: timestamp("revoked"),
      confirmation: jsonb("confirmation"),
      scopes: text("scopes").array().notNull(),
    },
    (table) => [
      index("oauthAccessToken_clientId_idx").on(table.clientId),
      index("oauthAccessToken_sessionId_idx").on(table.sessionId),
      index("oauthAccessToken_userId_idx").on(table.userId),
      index("oauthAccessToken_authorizationCodeId_idx").on(
        table.authorizationCodeId
      ),
      index("oauthAccessToken_refreshId_idx").on(table.refreshId),
    ]
  )

  const oauthConsent = idpSchema.table(
    "oauth_consent",
    {
      id: text("id").primaryKey(),
      clientId: text("client_id")
        .notNull()
        .references(() => oauthClient.clientId, { onDelete: "cascade" }),
      userId: text("user_id").references(() => user.id, {
        onDelete: "cascade",
      }),
      referenceId: text("reference_id"),
      resources: text("resources").array(),
      requestedUserInfoClaims: text("requested_user_info_claims").array(),
      scopes: text("scopes").array().notNull(),
      createdAt: timestamp("created_at").notNull(),
      updatedAt: timestamp("updated_at").notNull(),
    },
    (table) => [
      index("oauthConsent_clientId_idx").on(table.clientId),
      index("oauthConsent_userId_idx").on(table.userId),
    ]
  )

  const oauthClientAssertion = idpSchema.table("oauth_client_assertion", {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
  })

  const auditLog = idpSchema.table(
    "audit_log",
    {
      id: text("id").primaryKey(),
      action: text("action").notNull(),
      outcome: text("outcome").notNull(),
      actorUserId: text("actor_user_id"),
      actorType: text("actor_type"),
      targetType: text("target_type"),
      targetId: text("target_id"),
      ipAddress: text("ip_address"),
      userAgent: text("user_agent"),
      requestId: text("request_id"),
      metadata: jsonb("metadata"),
      createdAt: timestamp("created_at").defaultNow().notNull(),
    },
    (table) => [
      index("auditLog_action_idx").on(table.action),
      index("auditLog_actorUserId_idx").on(table.actorUserId),
      index("auditLog_targetId_idx").on(table.targetId),
      index("auditLog_createdAt_idx").on(table.createdAt),
    ]
  )

  const pendingAuthorization = idpSchema.table(
    "pending_authorization",
    {
      id: text("id").primaryKey(),
      handle: text("handle").notNull().unique(),
      clientId: text("client_id").notNull(),
      query: jsonb("query").notNull(),
      sessionId: text("session_id"),
      stage: text("stage").notNull(),
      createdAt: timestamp("created_at").defaultNow().notNull(),
      expiresAt: timestamp("expires_at").notNull(),
    },
    (table) => [index("pendingAuthorization_expiresAt_idx").on(table.expiresAt)]
  )

  const gateway = idpSchema.table(
    "gateway",
    {
      id: text("id").primaryKey(),
      name: text("name").notNull().unique(),
      url: text("url").notNull(),
      requireAuth: boolean("require_auth").default(false),
      trustProxy: boolean("trust_proxy").default(false),
      source: text("source").notNull(),
      enabled: boolean("enabled").default(true),
      createdAt: timestamp("created_at").defaultNow().notNull(),
      updatedAt: timestamp("updated_at")
        .defaultNow()
        .$onUpdate(() => new Date())
        .notNull(),
    },
    (table) => [index("gateway_source_idx").on(table.source)]
  )

  const rateLimit = idpSchema.table("rate_limit", {
    id: text("id").primaryKey(),
    key: text("key").notNull().unique(),
    count: integer("count").notNull(),
    lastRequest: bigint("last_request", { mode: "number" }).notNull(),
  })

  return {
    idpSchema,
    user,
    session,
    account,
    verification,
    jwks,
    twoFactor,
    apikey,
    oauthClient,
    oauthResource,
    oauthClientResource,
    oauthRefreshToken,
    oauthAccessToken,
    oauthConsent,
    oauthClientAssertion,
    auditLog,
    pendingAuthorization,
    gateway,
    rateLimit,
  }
}

export type AuthSchema = ReturnType<typeof createAuthSchema>

/**
 * A default instance under the canonical name. drizzle-kit needs statically
 * exported tables to diff against, and `db:generate` runs with the canonical
 * name so the committed SQL is canonical too.
 */
const canonicalSchema = createAuthSchema(
  process.env.IDP_SCHEMA_NAME ?? CANONICAL_SCHEMA_NAME
)

export const {
  idpSchema,
  user,
  session,
  account,
  verification,
  jwks,
  twoFactor,
  apikey,
  oauthClient,
  oauthResource,
  oauthClientResource,
  oauthRefreshToken,
  oauthAccessToken,
  oauthConsent,
  oauthClientAssertion,
  auditLog,
  pendingAuthorization,
  gateway,
  rateLimit,
} = canonicalSchema
