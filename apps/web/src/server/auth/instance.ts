/**
 * The one Better Auth instance (§3, §4).
 *
 * `createAuthOptions()` is deliberately separable from `createAuth()`: schema
 * generation (DM-1) needs the *options* — the plugin list is what decides which
 * tables exist — but has no database to connect to. Everything else takes the
 * built instance.
 *
 * Which requirement each block serves is noted inline; the rule is that no
 * option is set here without one.
 */

import { apiKey } from "@better-auth/api-key"
import { oauthProvider } from "@better-auth/oauth-provider"
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { admin } from "better-auth/plugins/admin"
import { jwt } from "better-auth/plugins/jwt"
import { twoFactor } from "better-auth/plugins/two-factor"

import type { BetterAuthOptions } from "better-auth"

import type { IdpConfig } from "../config/derive"
import type { DbHandle } from "../db/client"
import type { Audit } from "../audit"
import type { Mailer } from "../email/mailer"
import type { Logger } from "../logger"
import { APP_ROUTES, createBasePaths } from "../oidc/base-path"
import { idpPlugin } from "./plugins/idp-plugin"
import { buildDatabaseHooks } from "./options/database-hooks"
import { buildEmailCallbacks } from "./options/email-callbacks"
import { buildAfterHook, buildBeforeHook } from "./options/hooks"
import { buildSocialProviders } from "./options/social"
import { buildValidateUserInfo } from "./options/social-sync"
import { userAdditionalFields } from "./options/user-fields"

export interface AuthDeps {
  config: IdpConfig
  /**
   * Omitted only when generating the schema, which needs no connection. The
   * handle carries the tables already bound to `database.schema`.
   */
  database?: DbHandle
  logger?: Logger
  /**
   * Sends the FR-MAIL-1 templates. Omitted during schema generation, and a
   * disabled mailer in degraded mode (FR-MAIL-2).
   */
  mailer?: Mailer
  /** Writes the SEC-6 trail for the approval endpoints. */
  audit?: Audit
  /**
   * Schema generation (DM-1), which needs every table a deployment could ever
   * have — so the config-gated plugins stay registered regardless of what the
   * config file says. Never set for a running instance.
   */
  forSchema?: boolean
}

/** Seconds → the `maxAge`/`expiresIn` units Better Auth expects. */
const minutes = (value: number) => value * 60
const days = (value: number) => value * 86_400

export function createAuthOptions(deps: AuthDeps): BetterAuthOptions {
  const { config } = deps
  const paths = createBasePaths(config.base)
  const file = config.file
  // FR-MAIL-2: without a transport there are no callbacks to register, so the
  // features that depend on them cannot half-work.
  const email =
    deps.mailer && deps.mailer.enabled
      ? buildEmailCallbacks({ config, mailer: deps.mailer })
      : undefined

  return {
    appName: file.site.name,

    // SEC-1: every absolute URL derives from `server.baseUrl`, never from a
    // request header.
    //
    // The split matters. Better Auth 1.7.1's `withPath` appends `basePath`
    // **only when `baseURL` has no path of its own** — give it the issuer
    // `https://host/idp` and it mounts every endpoint at `/idp/*` and ignores
    // `basePath` entirely, so `/idp/api/auth/sign-in/email` 404s and a
    // sub-path deployment cannot sign anyone in (found by spike S3). Passing
    // the origin and carrying the mount path in `basePath` makes the sub-path
    // case resolve to exactly what the host root resolves to.
    baseURL: paths.origin,
    basePath: paths.authBasePath,
    secret: file.secret,
    trustedOrigins: [...config.trustedOrigins],

    // SEC-8: no third-party origins at runtime.
    telemetry: { enabled: false },

    database: deps.database
      ? drizzleAdapter(deps.database.db, {
          provider: "pg",
          schema: deps.database.schema,
          usePlural: false,
        })
      : undefined,

    // ---------------------------------------------------------------- user --
    user: {
      additionalFields: userAdditionalFields,

      // FR-SOC-2/3 + D24: what a provider identity is allowed to do to a
      // local account. The only hook that sees the fresh provider profile on
      // every arrival — registration, link and returning sign-in.
      validateUserInfo: buildValidateUserInfo({
        config,
        database: deps.database,
        audit: deps.audit,
        logger: deps.logger,
      }),

      changeEmail: {
        // FR-ACCT-1: changing an address always verifies the new one. With no
        // transport the whole feature is hidden, so this never runs.
        enabled: config.emailEnabled,
        ...(email
          ? { sendChangeEmailConfirmation: email.sendChangeEmailConfirmation }
          : {}),
      },
      deleteUser: {
        // FR-ACCT-1: no self-deletion; admins delete (FR-ADMIN-2).
        enabled: false,
      },
    },

    // ------------------------------------------------------------- password --
    emailAndPassword: {
      enabled: true,
      // FR-SIGNUP-1: the global switch governs password registration too.
      disableSignUp: !file.signUp.enabled,
      // FR-AUTH-2: gates password sign-in only; forced false without e-mail.
      requireEmailVerification: config.requireEmailVerification,
      minPasswordLength: file.auth.password.minLength,
      maxPasswordLength: file.auth.password.maxLength,
      resetPasswordTokenExpiresIn: minutes(
        file.auth.passwordReset.tokenTtlMinutes
      ),
      // FR-AUTH-3: a completed reset revokes every other session. OAuth token
      // revocation is layered on in M8 through `onPasswordReset`.
      revokeSessionsOnPasswordReset: true,
      ...(email
        ? {
            sendResetPassword: email.sendResetPassword,
            onPasswordReset: email.onPasswordReset,
          }
        : {}),
      // FR-SIGNUP-2: a fresh sign-up is `pending` and must not be signed in.
      autoSignIn: false,
      // SEC-10: Better Auth's default scrypt hashing is kept.
    },

    emailVerification: {
      // FR-AUTH-2: 24 h, single-use.
      expiresIn: days(1),
      sendOnSignUp: config.emailEnabled,
      // FR-SIGNUP-2: verification precedes approval, so verifying must not sign
      // the user in.
      autoSignInAfterVerification: false,
      ...(email ? { sendVerificationEmail: email.sendVerificationEmail } : {}),
    },

    // ------------------------------------------------------------- accounts --
    account: {
      // FR-SOC-2 (D8): account linking is off entirely. An identity is
      // (providerId, provider subject) and nothing else, so a social sign-in can
      // never attach itself to an existing password user.
      accountLinking: {
        enabled: false,
        disableImplicitLinking: true,
        trustedProviders: [],
        allowDifferentEmails: false,
      },
      // FR-SOC-4: profile sync on every sign-in of an existing account.
      updateAccountOnSignIn: true,
      encryptOAuthTokens: true,
    },

    // ------------------------------------------------------------- sessions --
    session: {
      expiresIn: file.session.expiresIn,
      updateAge: file.session.updateAge,
      // FR-AUTH-5: capped at 5 minutes so a revocation bites quickly.
      cookieCache: {
        enabled: file.session.cookieCacheMinutes > 0,
        maxAge: minutes(file.session.cookieCacheMinutes),
      },
      // FR-AUTH-5: sensitive actions need a session fresher than this.
      freshAge: minutes(file.session.freshAgeMinutes),
    },

    socialProviders: buildSocialProviders(config),

    // --------------------------------------------------------------- cookies --
    advanced: {
      // FR-AUTH-5: `Secure` follows the *issuer's* scheme, not the internal
      // one — behind a TLS-terminating proxy the app itself speaks http.
      useSecureCookies: paths.secureCookies,
      cookiePrefix: paths.secureCookies ? "__Secure-idp" : "idp",
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
        // Host-only: no `domain`, so only same-host apps share the session,
        // which is precisely what makes `firstParty` meaningful (FR-OIDC-14).
        path: paths.cookiePath,
        secure: paths.secureCookies,
      },
      crossSubDomainCookies: { enabled: false },
      ipAddress: {
        // SEC-2: only honour forwarded headers when a proxy is trusted.
        disableIpTracking: false,
        ...(file.server.trustProxy === false
          ? { ipAddressHeaders: [] }
          : {
              ipAddressHeaders: ["x-forwarded-for"],
              ...(Array.isArray(file.server.trustProxy)
                ? { trustedProxies: file.server.trustProxy }
                : {}),
            }),
      },
    },

    // ----------------------------------------------------------- rate limits --
    rateLimit: {
      enabled: file.rateLimit.enabled,
      // SEC-2: database storage survives restarts and is replica-safe.
      storage: file.rateLimit.storage,
    },

    // ------------------------------------------------------------- plugins ---
    plugins: [
      admin({
        // FR-ROLE-1: the `default: true` entry of the catalog.
        defaultRole: config.defaultRole,
        adminRoles: [...config.adminRoles],
        // FR-ADMIN-5: at most 1 h, and never against another admin.
        impersonationSessionDuration: 3600,
        allowImpersonatingAdmins: false,
      }),

      jwt({
        jwks: {
          // FR-OIDC-5: ES256 by default; RS256 is the only alternative Neon takes.
          keyPairConfig: { alg: file.jwt.algorithm },
          // SEC-10 / FR-OIDC-16: private keys are encrypted at rest with `secret`.
          disablePrivateKeyEncryption: false,
          rotationInterval: file.jwt.rotationInterval,
          gracePeriod: config.jwksGracePeriodSeconds,
        },
        jwt: {
          issuer: paths.issuer,
          audience:
            config.defaultAudience.length === 1
              ? config.defaultAudience[0]
              : [...config.defaultAudience],
          expirationTime: file.jwt.sessionToken.ttl,
        },
      }),

      // FR-2FA-1 / FR-KEY-1: a capability that is switched off has no
      // endpoints at all, not merely a hidden button. `deps.forSchema` keeps
      // both plugins on for schema generation, because the tables they own
      // must exist in every deployment or the DM-1 drift gate would flip with
      // an operator's config file.
      ...(file.twoFactor.enabled || deps.forSchema
        ? [
            twoFactor({
              // FR-2FA-1: the TOTP issuer label shown in the authenticator app.
              issuer: config.twoFactorIssuer,
              // Config says days; 1.7.1 wants seconds. 0 disables the
              // trust-this-device option rather than trusting for ever.
              trustDeviceMaxAge: days(file.twoFactor.trustDeviceDays),
            }),
          ]
        : []),

      ...(file.apiKeys.enabled || deps.forSchema
        ? [
            apiKey({
              // FR-KEY-1: hashed at rest, prefixed for recognisability.
              defaultPrefix: "idp_",
              disableKeyHashing: false,
              requireName: true,
              keyExpiration: {
                // Better Auth quirk: `defaultExpiresIn` is in seconds while
                // `min`/`maxExpiresIn` are in days. Converted here so the
                // config file can express both as durations.
                defaultExpiresIn: file.apiKeys.defaultExpiresIn,
                minExpiresIn: 1,
                maxExpiresIn: Math.ceil(file.apiKeys.maxExpiresIn / 86_400),
                disableCustomExpiresTime: false,
              },
              // FR-KEY-1: per-key rate limiting.
              rateLimit: {
                enabled: true,
                timeWindow: 60_000,
                maxRequests: 120,
              },
              // FR-KEY-2: a key authenticates *as the owning user*, same roles.
              enableSessionForAPIKeys: true,
              storage: "database",
            }),
          ]
        : []),

      oauthProvider({
        // FR-OIDC-9: the gate chain starts at these two pages.
        loginPage: paths.path(APP_ROUTES.login),
        consentPage: paths.path(APP_ROUTES.consent),

        // FR-OIDC-1 (D26): these two grants and nothing else. `client_credentials`
        // is absent here, so the token endpoint rejects it and discovery never
        // advertises it.
        grantTypes: ["authorization_code", "refresh_token"],

        // FR-OIDC-13.
        accessTokenExpiresIn: file.oauth.accessTokenTtl,
        idTokenExpiresIn: file.oauth.idTokenTtl,
        codeExpiresIn: file.oauth.codeTtl,
        refreshTokenExpiresIn: file.oauth.refreshTokenTtl,

        // FR-OIDC-2: no dynamic registration, and client CRUD is denied for
        // every caller — the file is the source of truth.
        allowDynamicClientRegistration: false,
        allowUnauthenticatedClientRegistration: false,
        clientPrivileges: () => false,
        resourcePrivileges: () => false,
        cachedTrustedClients: new Set(
          config.clients.map((client) => client.clientId)
        ),

        // FR-OIDC-6 / risk R2: resources are seeded from the effective registry
        // and each client is linked to the ones it may ask for.
        resources: config.resources.map((resource) => ({
          identifier: resource.identifier,
          name: resource.name,
          ...(resource.allowedScopes
            ? { allowedScopes: resource.allowedScopes }
            : {}),
          ...(resource.accessTokenTtl
            ? { accessTokenTtl: resource.accessTokenTtl }
            : {}),
        })),
        resourceSeedMode: "merge",
        enforcePerClientResources: true,

        scopes: file.oauth.scopes,

        // SEC-10: secrets and tokens are hashed at rest. The hash function is
        // ours so reconciliation can produce byte-identical values (risk R4).
        storeClientSecret: "hashed",
        storeTokens: "hashed",

        // SEC-2: per-endpoint limits on top of the global ones.
        rateLimit: {
          token: { window: 60, max: 30 },
          authorize: { window: 60, max: 30 },
          introspect: { window: 60, max: 120 },
          revoke: { window: 60, max: 30 },
          register: false,
          userinfo: { window: 60, max: 60 },
        },
      }),

      // DM-1: contributes `audit_log` and `pending_authorization` to the
      // generated schema, plus the approval endpoints Better Auth has no
      // equivalent for (FR-SIGNUP-2).
      idpPlugin({
        config,
        audit: deps.audit,
        mailer: deps.mailer,
        // Registered last on purpose: the SEC-6 trail has to see the response
        // the caller gets, after every other plugin has had its say.
        afterHook: buildAfterHook({ config, audit: deps.audit }),
      }),
    ],

    // FR-SIGNUP-2/3, FR-AUTH-1: the approval gate, the domain restriction and
    // e-mail normalisation, enforced beneath every path that creates a user or
    // a session.
    // FR-AUTH-1: normalise addresses before Better Auth validates them.
    hooks: {
      before: buildBeforeHook(config),
    },

    databaseHooks: buildDatabaseHooks({
      config,
      database: deps.database,
      mailer: deps.mailer,
      logger: deps.logger,
    }),

    logger: deps.logger
      ? {
          disabled: false,
          log: (level, message, ...args) => {
            const fields = args.length > 0 ? { details: args } : undefined
            if (level === "error") deps.logger!.error(message, fields)
            else if (level === "warn") deps.logger!.warn(message, fields)
            else if (level === "debug") deps.logger!.debug(message, fields)
            else deps.logger!.info(message, fields)
          },
        }
      : undefined,
  }
}

export type Auth = ReturnType<typeof betterAuth<BetterAuthOptions>>

export function createAuth(deps: AuthDeps) {
  return betterAuth(createAuthOptions(deps))
}
