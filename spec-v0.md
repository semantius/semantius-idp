we need a light weight idp which can be delivered as a docker container. it should provide plug able user management and authentication for a internal apps requiring jwt and jwks validation, like neon. it should be lean, secure, self contained and complete.

it should use bun, tanstack start, shadn latest with base ui, drizzle with postgres, pnpm, mono repo, better auth latest 

the idp server should manage users and roles, provide oidc and oauth2 endpoints, be not multi tenant, so no organizations needed

we need login ui, the option to enable social signins like google or github, password reset, option to allow sign up, option to approve new sign ups

we need admin plugin, api key

we need the user facing ui with login, reset password page

we need the admin ui where an admin can manage users and roles, approve new users

for the oauth_client and for the role we need special handling, the tables can be defined in postgres BUT we need a config folder where we store oauth_clients.json and roles.json  the idp server should use these and ignore the 2 tables in the database, goal is to configure/customize the server with files and env. so when a docker container is build it will be configured. for client secret and probably all values in the config we need a way to replace a value from the config file with env variables like ${env:CLIENT1_SECRET} will insert env variable CLIENT1_SECRET in the oauth_clients.json file. when there is any common way of doing that we should follow it.

we should also have a generic  config.json in that folder, which allows to set variables like better auth secret or site name, so everything needed to configure the server.

the site will run either stand alone or behind a caddy proxy. so it should not expected specific paths.

we need the common wellknown files.

we need automated tests

we need a docker container to run the idp

readme.md must be written for users with features and benefits and configuration information.

the following schema contains tables name and field names to be reused, but use only what is need for the above requirements and all orm should be created with the better auth cli


/**
 * baschema.ts — Better Auth Drizzle schema (BA tables + BA columns ONLY)
 *
 * Source: semantius-cloud packages/database/src/schema/{core,schema}.ts
 * App-only tables/columns stripped.
 *
 * Versions:
 *   better-auth 1.5.5 (pinned), @better-auth/drizzle-adapter ^1.5.5,
 *   @better-auth/oauth-provider ^1.5.5, @better-auth/stripe 1.5.5,
 *   drizzle-orm ^0.45.1, postgres
 *
 * Adapter: drizzleAdapter(db, { provider: 'pg' }); db = drizzle(client, { schema })
 *
 * Plugin -> table map:
 *   core                 user, session, account, verification
 *   admin                user.role/banned/banReason/banExpires, session.impersonatedBy
 *   organization         organization, organizationRole, member, invitation,
 *                        session.activeOrganizationId
 *   twoFactor            twoFactor, user.twoFactorEnabled
 *   @better-auth/stripe  subscription, user.stripeCustomerId, organization.stripeCustomerId
 *   rateLimit (db)       rateLimit
 *   jwt                  jwks
 *   oauthProvider        oauthClient, oauthRefreshToken, oauthAccessToken, oauthConsent
 *
 * BA additionalFields (declared in auth config, stored by BA):
 *   user.firstName / lastName
 *   invitation.firstName / lastName
 *   organizationRole.metadata
 */

import { relations } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// core
// ---------------------------------------------------------------------------

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  firstName: text('first_name'),
  lastName: text('last_name'),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  image: text('image'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
  role: text('role'),
  banned: boolean('banned').default(false),
  banReason: text('ban_reason'),
  banExpires: timestamp('ban_expires'),
  twoFactorEnabled: boolean('two_factor_enabled').default(false),
  stripeCustomerId: text('stripe_customer_id'),
});

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at').notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    impersonatedBy: text('impersonated_by'),
    activeOrganizationId: text('active_organization_id'),
  },
  (table) => [index('session_userId_idx').on(table.userId)],
);

export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at'),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index('account_userId_idx').on(table.userId)],
);

export const verification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)],
);

// ---------------------------------------------------------------------------
// organization plugin
// ---------------------------------------------------------------------------

export const organization = pgTable(
  'organization',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    logo: text('logo'),
    createdAt: timestamp('created_at').notNull(),
    metadata: text('metadata'),
    stripeCustomerId: text('stripe_customer_id'),
  },
  (table) => [uniqueIndex('organization_slug_uidx').on(table.slug)],
);

export const organizationRole = pgTable(
  'organization_role',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    permission: text('permission').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').$onUpdate(
      () => /* @__PURE__ */ new Date(),
    ),
    metadata: text('metadata'),
  },
  (table) => [
    index('organizationRole_organizationId_idx').on(table.organizationId),
    index('organizationRole_role_idx').on(table.role),
  ],
);

export const member = pgTable(
  'member',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text('role').default('member').notNull(),
    createdAt: timestamp('created_at').notNull(),
  },
  (table) => [
    index('member_organizationId_idx').on(table.organizationId),
    index('member_userId_idx').on(table.userId),
  ],
);

export const invitation = pgTable(
  'invitation',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    firstName: text('first_name'),
    lastName: text('last_name'),
    role: text('role'),
    status: text('status').default('pending').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    inviterId: text('inviter_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [
    index('invitation_organizationId_idx').on(table.organizationId),
    index('invitation_email_idx').on(table.email),
  ],
);

// ---------------------------------------------------------------------------
// twoFactor plugin
// ---------------------------------------------------------------------------

export const twoFactor = pgTable(
  'two_factor',
  {
    id: text('id').primaryKey(),
    secret: text('secret').notNull(),
    backupCodes: text('backup_codes').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [
    index('twoFactor_secret_idx').on(table.secret),
    index('twoFactor_userId_idx').on(table.userId),
  ],
);

// ---------------------------------------------------------------------------
// @better-auth/stripe plugin
// ---------------------------------------------------------------------------

export const subscription = pgTable('subscription', {
  id: text('id').primaryKey(),
  plan: text('plan').notNull(),
  referenceId: text('reference_id').notNull(),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  status: text('status').default('incomplete'),
  periodStart: timestamp('period_start'),
  periodEnd: timestamp('period_end'),
  trialStart: timestamp('trial_start'),
  trialEnd: timestamp('trial_end'),
  cancelAtPeriodEnd: boolean('cancel_at_period_end').default(false),
  cancelAt: timestamp('cancel_at'),
  canceledAt: timestamp('canceled_at'),
  endedAt: timestamp('ended_at'),
  seats: integer('seats'),
  billingInterval: text('billing_interval'),
  stripeScheduleId: text('stripe_schedule_id'),
});

// ---------------------------------------------------------------------------
// rateLimit (database storage)
// ---------------------------------------------------------------------------

export const rateLimit = pgTable('rate_limit', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
});

// ---------------------------------------------------------------------------
// jwt plugin
// ---------------------------------------------------------------------------

export const jwks = pgTable('jwks', {
  id: text('id').primaryKey(),
  publicKey: text('public_key').notNull(),
  privateKey: text('private_key').notNull(),
  createdAt: timestamp('created_at').notNull(),
  expiresAt: timestamp('expires_at'),
});

// ---------------------------------------------------------------------------
// @better-auth/oauth-provider plugin
// ---------------------------------------------------------------------------

export const oauthClient = pgTable('oauth_client', {
  id: text('id').primaryKey(),
  clientId: text('client_id').notNull().unique(),
  clientSecret: text('client_secret'),
  disabled: boolean('disabled').default(false),
  skipConsent: boolean('skip_consent'),
  enableEndSession: boolean('enable_end_session'),
  subjectType: text('subject_type'),
  scopes: text('scopes').array(),
  userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at'),
  updatedAt: timestamp('updated_at'),
  name: text('name'),
  uri: text('uri'),
  icon: text('icon'),
  contacts: text('contacts').array(),
  tos: text('tos'),
  policy: text('policy'),
  softwareId: text('software_id'),
  softwareVersion: text('software_version'),
  softwareStatement: text('software_statement'),
  redirectUris: text('redirect_uris').array().notNull(),
  postLogoutRedirectUris: text('post_logout_redirect_uris').array(),
  tokenEndpointAuthMethod: text('token_endpoint_auth_method'),
  grantTypes: text('grant_types').array(),
  responseTypes: text('response_types').array(),
  public: boolean('public'),
  type: text('type'),
  requirePKCE: boolean('require_pkce'),
  referenceId: text('reference_id'),
  metadata: jsonb('metadata'),
});

export const oauthRefreshToken = pgTable('oauth_refresh_token', {
  id: text('id').primaryKey(),
  token: text('token').notNull(),
  clientId: text('client_id')
    .notNull()
    .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
  sessionId: text('session_id').references(() => session.id, {
    onDelete: 'set null',
  }),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  referenceId: text('reference_id'),
  expiresAt: timestamp('expires_at'),
  createdAt: timestamp('created_at'),
  revoked: timestamp('revoked'),
  authTime: timestamp('auth_time'),
  scopes: text('scopes').array().notNull(),
});

export const oauthAccessToken = pgTable('oauth_access_token', {
  id: text('id').primaryKey(),
  token: text('token').unique(),
  clientId: text('client_id')
    .notNull()
    .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
  sessionId: text('session_id').references(() => session.id, {
    onDelete: 'set null',
  }),
  userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
  referenceId: text('reference_id'),
  refreshId: text('refresh_id').references(() => oauthRefreshToken.id, {
    onDelete: 'cascade',
  }),
  expiresAt: timestamp('expires_at'),
  createdAt: timestamp('created_at'),
  scopes: text('scopes').array().notNull(),
});

export const oauthConsent = pgTable('oauth_consent', {
  id: text('id').primaryKey(),
  clientId: text('client_id')
    .notNull()
    .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
  userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
  referenceId: text('reference_id'),
  scopes: text('scopes').array().notNull(),
  createdAt: timestamp('created_at'),
  updatedAt: timestamp('updated_at'),
});

// ---------------------------------------------------------------------------
// relations
// ---------------------------------------------------------------------------

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  members: many(member),
  invitations: many(invitation),
  twoFactors: many(twoFactor),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));

export const organizationRelations = relations(organization, ({ many }) => ({
  organizationRoles: many(organizationRole),
  members: many(member),
  invitations: many(invitation),
}));

export const organizationRoleRelations = relations(
  organizationRole,
  ({ one }) => ({
    organization: one(organization, {
      fields: [organizationRole.organizationId],
      references: [organization.id],
    }),
  }),
);

export const memberRelations = relations(member, ({ one }) => ({
  organization: one(organization, {
    fields: [member.organizationId],
    references: [organization.id],
  }),
  user: one(user, {
    fields: [member.userId],
    references: [user.id],
  }),
}));

export const invitationRelations = relations(invitation, ({ one }) => ({
  organization: one(organization, {
    fields: [invitation.organizationId],
    references: [organization.id],
  }),
  user: one(user, {
    fields: [invitation.inviterId],
    references: [user.id],
  }),
}));

export const twoFactorRelations = relations(twoFactor, ({ one }) => ({
  user: one(user, {
    fields: [twoFactor.userId],
    references: [user.id],
  }),
}));

export const oauthClientRelations = relations(oauthClient, ({ one, many }) => ({
  user: one(user, {
    fields: [oauthClient.userId],
    references: [user.id],
  }),
  oauthRefreshTokens: many(oauthRefreshToken),
  oauthAccessTokens: many(oauthAccessToken),
  oauthConsents: many(oauthConsent),
}));

export const oauthRefreshTokenRelations = relations(
  oauthRefreshToken,
  ({ one, many }) => ({
    oauthClient: one(oauthClient, {
      fields: [oauthRefreshToken.clientId],
      references: [oauthClient.clientId],
    }),
    session: one(session, {
      fields: [oauthRefreshToken.sessionId],
      references: [session.id],
    }),
    user: one(user, {
      fields: [oauthRefreshToken.userId],
      references: [user.id],
    }),
    oauthAccessTokens: many(oauthAccessToken),
  }),
);

export const oauthAccessTokenRelations = relations(
  oauthAccessToken,
  ({ one }) => ({
    oauthClient: one(oauthClient, {
      fields: [oauthAccessToken.clientId],
      references: [oauthClient.clientId],
    }),
    session: one(session, {
      fields: [oauthAccessToken.sessionId],
      references: [session.id],
    }),
    user: one(user, {
      fields: [oauthAccessToken.userId],
      references: [user.id],
    }),
    oauthRefreshToken: one(oauthRefreshToken, {
      fields: [oauthAccessToken.refreshId],
      references: [oauthRefreshToken.id],
    }),
  }),
);

export const oauthConsentRelations = relations(oauthConsent, ({ one }) => ({
  oauthClient: one(oauthClient, {
    fields: [oauthConsent.clientId],
    references: [oauthClient.clientId],
  }),
  user: one(user, {
    fields: [oauthConsent.userId],
    references: [user.id],
  }),
}));
