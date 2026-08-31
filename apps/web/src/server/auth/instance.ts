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
import { buildUserClaims } from "../claims/build-claims"
import type { ClaimsUser } from "../claims/build-claims"
import { clientSecretStorage } from "../oidc/secret-hash"
import { IDP_PLUGIN_ID, idpPlugin } from "./plugins/idp-plugin"
import {
  assertUserMaySignIn,
  buildDatabaseHooks,
} from "./options/database-hooks"
import type { AdminContext } from "../admin/context"
import { buildAdminEndpoints } from "../admin/endpoints"
import { buildAdminAfterHook, buildAdminGuard } from "../admin/guard"
import { SOCKET_ADDRESS_HEADER } from "../http/client-ip"
import { requestOrigins } from "../http/request-origin"
import { currentRequestIssuer, recordAuthApiError } from "../http/request-log"
import { buildEmailCallbacks } from "./options/email-callbacks"
import { gateApiKeyPlugin, isApiKeySession } from "./options/api-key-gate"
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
  /**
   * Filled in by `runtime.ts` after this instance exists — the system page and
   * the rotate button need the instance and the startup result, neither of
   * which is available while the instance is being built.
   */
  adminContext?: AdminContext
  /**
   * Injected by tests so the FR-AUTH-1 breach check never leaves the process.
   * Production leaves it unset and the module uses the global `fetch`.
   */
  breachFetch?: (input: string, init?: RequestInit) => Promise<Response>
  logger?: Logger
  /**
   * Sends the FR-MAIL-1 templates. Omitted during schema generation, and a
   * disabled mailer in degraded mode (FR-MAIL-2).
   */
  mailer?: Mailer
  /** Writes the SEC-6 trail for the approval endpoints. */
  audit?: Audit
  /**
   * `/admin/database`'s own connections (FR-ADMIN-7), built in `runtime.ts`
   * and absent when `admin.database` is `disabled`.
   *
   * Never `database`: a single statement can change session state that a
   * pooled connection then hands to ordinary application traffic. See
   * `admin/database.ts`'s header. `consoleDb` is the pooled endpoint and
   * serves `read`; `consoleDirectDb` is the direct one and exists only in a
   * `read-write` deployment.
   */
  consoleDb?: DbHandle
  consoleDirectDb?: DbHandle
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
    // sub-path deployment cannot sign anyone in — observed, not deduced. Passing
    // the origin and carrying the mount path in `basePath` makes the sub-path
    // case resolve to exactly what the host root resolves to.
    baseURL: paths.origin,
    basePath: paths.authBasePath,
    secret: file.secret,
    // SEC-3. Two shapes, and which one is in force is a configuration fact:
    // a static list when `server.trustedOrigins` names origins, and otherwise
    // a per-request one that adds the address the request arrived on (D68 —
    // `http/request-origin.ts` has the reasoning and the limits). Better Auth
    // resolves the function once per request and keeps the issuer origin in
    // front of whatever it returns, so the deployment's own address is trusted
    // either way.
    trustedOrigins: config.trustRequestOrigin
      ? (request) => [...config.trustedOrigins, ...requestOrigins(request)]
      : [...config.trustedOrigins],

    // SEC-8: no third-party origins at runtime.
    telemetry: { enabled: false },

    // FR-OIDC-9: an authorization that cannot be redirected back to the
    // client — unknown client, unregistered redirect URI — lands on this
    // app's own error page rather than Better Auth's built-in one under
    // `/api/auth/error`, which is unbranded, untranslated and advertises the
    // auth mount that the rest of M8c works to keep out of sight.
    onAPIError: {
      errorURL: `${paths.basePath}${APP_ROUTES.error}`,
      // Better Auth's router collapses a non-APIError into a bare 500 with an
      // empty body, so the response alone cannot say what happened. The error
      // is stashed on the request context here, where it is still an object —
      // `oidc/protocol-proxy.ts` reads it to map exactly one shape (a jose
      // `iss` claim failure, the host-scoped-token case under
      // `server.dynamicIssuer`) to a 401. Registering this callback replaces
      // Better Auth's own error logging, so the line is written here too.
      onError: (error) => {
        recordAuthApiError(error)
        deps.logger?.error("auth api error", {
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        })
      },
    },

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
      // FR-AUTH-3: a completed reset revokes every other session. The OAuth
      // tokens it also has to revoke are handled by the `account.update.after`
      // database hook, which covers `/change-password` as well and does not
      // depend on an e-mail transport being configured (FR-OIDC-12).
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
      // **Zero disables it, and that is deliberate** (**D81**). Better Auth
      // runs its own freshness check on `/delete-user` and on `/update-user`'s
      // e-mail change, defaulting to a day; `0` is the documented way off
      // (`api/routes/session.mjs` guards every use with `freshAge !== 0`).
      // Left at the default it would reintroduce exactly what D81 removed —
      // and reintroduce it as a Better Auth error code rather than a bounce,
      // on accounts that authenticate through a provider and have no password
      // to re-present.
      freshAge: 0,
    },

    socialProviders: buildSocialProviders(config),

    // --------------------------------------------------------------- cookies --
    advanced: {
      // SEC-3, and it has to be said out loud: Better Auth defaults
      // `disableOriginCheck` to **true** under `NODE_ENV=test`
      // (`context/create-context.mjs`), and with it the CSRF origin check and
      // — through its backward-compatibility arm — the Fetch-Metadata one.
      // Left alone, every test in this repository ran against a build with the
      // protection off, so the suite could not have noticed the day it broke.
      // A security property nothing exercises is a security property nobody
      // has. `false` here is what production already does; it is only the test
      // runs that change.
      disableOriginCheck: false,
      // FR-AUTH-5: `Secure` follows the *issuer's* scheme, not the internal
      // one — behind a TLS-terminating proxy the app itself speaks http.
      useSecureCookies: paths.secureCookies,
      cookiePrefix: paths.secureCookies ? "__Secure-idp" : "idp",
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
        // Both are configuration since **D97**: `Path` defaults to `/` and
        // `Domain` is absent, which keeps the cookie host-only — and host-only
        // is what makes `firstParty` meaningful (FR-OIDC-14), so widening it
        // with `server.cookieDomain` widens that rule to every host under the
        // domain. Named explicitly rather than left to Better Auth, whose own
        // defaults these now match, because the value has to agree with
        // `crossSubDomainCookies` below.
        path: paths.cookiePath,
        ...(paths.cookieDomain ? { domain: paths.cookieDomain } : {}),
        secure: paths.secureCookies,
      },
      // Set in lockstep with the `domain` above. Better Auth injects its own
      // `domain` from this block *before* spreading `defaultCookieAttributes`
      // (`cookies/index.mjs`), so ours already wins and this is belt and
      // braces — but leaving the flag off while emitting a `Domain` would be a
      // deployment whose cookies say one thing and whose framework believes
      // another, and the next person to read either would be misled.
      crossSubDomainCookies: paths.cookieDomain
        ? { enabled: true, domain: paths.cookieDomain }
        : { enabled: false },
      ipAddress: {
        // SEC-2: only honor forwarded headers when a proxy is trusted.
        disableIpTracking: false,
        ...(file.server.trustProxy === false
          ? {
              // Not the empty list. With no header to read, Better Auth cannot
              // resolve an address at all and every caller shares **one**
              // rate-limit bucket — which is either so wide it limits nothing
              // or so narrow it locks the whole deployment out at once. The
              // edge stamps the real socket address into this private header
              // and overwrites whatever a client sent, so reading it here is
              // reading the socket, not the caller.
              ipAddressHeaders: [SOCKET_ADDRESS_HEADER],
            }
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
      // SEC-2's named endpoints. Better Auth keys every bucket as `ip:path`
      // and `customRules` can only change the window and the maximum, never
      // the key — so the *per-client-id* half of the `/oauth2/token` rule
      // cannot live here. It lives in `routes/oauth2/token.ts` instead, over
      // the same `rate_limit` table. See `server/http/rate-limit.ts`.
      customRules: SEC2_RULES,
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
          // A GETTER, not a value, and not something that may become unset.
          // `options.jwt.issuer` is read lazily on every sign and by the
          // provider's `getIssuer`, so this is the one seam through which
          // `server.dynamicIssuer` reaches every `iss` — tokens, discovery,
          // logout-hint verification. Outside a request (start-up key checks,
          // the CLI) it is the boot issuer. It must never be left undefined:
          // the fallback would be `ctx.context.baseURL`
          // (`https://host/idp/api/auth`), and `handleIssuerMetadataRequest`
          // derives the well-known PATH from it, so discovery would 404.
          // (defu 6.1.7 preserves the accessor descriptor and does not invoke
          // it during option merging — verified, not assumed.)
          get issuer() {
            return currentRequestIssuer() ?? paths.issuer
          },
          audience:
            config.defaultAudience.length === 1
              ? config.defaultAudience[0]
              : [...config.defaultAudience],
          // A *string* time span, not the number of seconds. Better Auth
          // passes this straight to `toExpJWT`, where "if a number is passed
          // it is used as the claim directly" — so `3600` meant an `exp` of
          // 1970-01-01T01:00:00Z and every session JWT was born expired.
          // Nothing noticed because nothing verified one until now.
          expirationTime: `${file.jwt.sessionToken.ttl} seconds`,

          // FR-OIDC-7 / FR-KEY-3: the third token shape. `GET {baseUrl}
          // /api/auth/token` mints a JWT from a session — or from an API key,
          // since the api-key plugin turns one into a session — and it has to
          // carry the same user claims as an access token, or a resource
          // server would have to special-case where a token came from.
          //
          // The protocol claims differ on purpose, and only in the ways
          // FR-OIDC-7's acceptance criterion allows: `sub`, `sid`, `azp` and
          // `scope`.
          definePayload: (session) => sessionTokenPayload(session, config),
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

      // FR-KEY-2: wrapped so the owner's ban/approval state is re-checked on
      // every use of a key, which the plugin itself never does.
      ...(file.apiKeys.enabled || deps.forSchema
        ? [
            gateApiKeyPlugin(
              apiKey({
                // FR-KEY-1: hashed at rest, prefixed for recognizability.
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
              { audit: deps.audit }
            ),
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
        // FR-OIDC-13's reuse detection: zero seconds of tolerance, so any
        // second use of a rotated refresh token is replay and revokes the
        // family. It is 1.7.1's default; stating it makes the requirement
        // visible where the other lifetimes are, rather than depending on a
        // default that could change.
        refreshTokenReuseInterval: 0,

        // FR-OIDC-7: the one claims builder, for the access token and — when
        // the deployment asks for it — the ID token. The provider spreads
        // these *first* and then writes `sub`, `aud`, `client_id`, `azp`,
        // `scope`, `sid`, `iss`, `iat`, `exp` and `jti` over the top, so
        // nothing here can shadow a protocol claim: the provider spreads
        // custom claims first and then writes its own over them.
        customAccessTokenClaims: (info) =>
          buildUserClaims(info.user as ClaimsUser | null | undefined, config),
        ...(file.jwt.claimsInIdToken
          ? {
              customIdTokenClaims: (info) =>
                buildUserClaims(info.user as ClaimsUser, config),
            }
          : {}),

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

        // FR-OIDC-15: discovery describes *this* deployment. The scope list
        // is the configured one, and the claim list is what the builder can
        // actually emit — advertising a claim no token carries sends a
        // resource server looking for something that will never be there.
        advertisedMetadata: {
          scopes_supported: file.oauth.scopes,
          claims_supported: [
            "sub",
            "iss",
            "aud",
            "exp",
            "iat",
            "sid",
            "scope",
            "azp",
            ...config.userClaims,
          ],
        },

        // SEC-10 / risk R4: **the same function object** the reconciler
        // hashes with, so a secret written by `oauth_clients.jsonc` and a
        // secret presented at the token endpoint cannot disagree about how
        // they are compared.
        storeClientSecret: clientSecretStorage,
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
        // FR-ADMIN-3: the last-admin and self-action rules, in front of Better
        // Auth's own admin endpoints — so the admin API and the admin UI are
        // refused the same things (FR-ADMIN-6).
        adminGuard: buildAdminGuard({
          config,
          database: deps.database,
          audit: deps.audit,
          logger: deps.logger,
        }),
        adminEndpoints: buildAdminEndpoints({
          config,
          database: deps.database,
          audit: deps.audit,
          logger: deps.logger,
          mailer: deps.mailer,
          context: deps.adminContext,
          consoleDb: deps.consoleDb,
          consoleDirectDb: deps.consoleDirectDb,
        }),
        adminAfterHook: buildAdminAfterHook({
          config,
          database: deps.database,
          audit: deps.audit,
          logger: deps.logger,
        }),
        // Registered last on purpose: the SEC-6 trail has to see the response
        // the caller gets, after every other plugin has had its say.
        afterHook: buildAfterHook({
          config,
          audit: deps.audit,
          database: deps.database,
          logger: deps.logger,
        }),
      }),
    ],

    // FR-SIGNUP-2/3, FR-AUTH-1: the approval gate, the domain restriction and
    // e-mail normalization, enforced beneath every path that creates a user or
    // a session.
    // FR-AUTH-1: normalize addresses before Better Auth validates them.
    hooks: {
      before: buildBeforeHook({
        config,
        database: deps.database,
        logger: deps.logger,
        breachFetch: deps.breachFetch,
      }),
    },

    databaseHooks: buildDatabaseHooks({
      config,
      database: deps.database,
      mailer: deps.mailer,
      logger: deps.logger,
      audit: deps.audit,
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

/**
 * The payload of a session JWT (FR-OIDC-7, FR-KEY-3).
 *
 * `azp` is the honest answer to "who is presenting this": an API-key exchange
 * is not the browser session it borrows, so it says so —
 * `apiKeys.tokenClientId` rather than the IdP itself.
 *
 * **The discriminator was wrong until M12.** It asked whether
 * `session.session.token` was a string, on the theory that a synthesised
 * session has no session token; in 1.7.1 the api-key plugin puts the *key
 * string* there, so the test was always false, every key-issued JWT claimed
 * `azp: "idp"`, and `apiKeys.tokenClientId` was configuration that did
 * nothing. Worse, it was invisible: `tokens.test.ts` asserted the behavior
 * the bug produced. The answer now comes from `isApiKeySession`, which reads a
 * marker our own gate stamps on the session it watched the plugin build — the
 * one place in the process that knows.
 *
 * A non-active user gets nothing, whatever the session says:
 * `assertUserMaySignIn` runs on every mint, because a session or a key can
 * outlive the ban that should have ended it (FR-SIGNUP-2, FR-KEY-2).
 */
function sessionTokenPayload(
  session: { user: Record<string, unknown>; session: Record<string, unknown> },
  config: IdpConfig
): Record<string, unknown> {
  assertUserMaySignIn(session.user)

  const fromApiKey = isApiKeySession(session)
  return {
    ...buildUserClaims(session.user, config),
    azp: fromApiKey ? config.file.apiKeys.tokenClientId : IDP_PLUGIN_ID,
    sid: String(session.session.id ?? ""),
    // Fixed rather than negotiated: a session token is not the product of an
    // authorization request, so there is no scope to have agreed on.
    scope: "openid profile email",
  }
}

/**
 * The stricter buckets SEC-2 names, in seconds and attempts.
 *
 * The numbers are chosen to be invisible to a person and expensive to a
 * script. Ten sign-in attempts a minute is more than anyone types and far less
 * than a password list needs; three password-reset requests in five minutes is
 * a user pressing the button again, not an inbox being flooded.
 *
 * A wildcard entry matches by path, so `/callback/*` covers every social
 * provider without naming them.
 */
const SEC2_RULES: Record<string, { window: number; max: number }> = {
  // Credential guessing.
  "/sign-in/email": { window: 60, max: 10 },
  "/sign-up/email": { window: 300, max: 5 },
  // Mail amplification: each of these sends a message to an address the
  // caller chose.
  "/request-password-reset": { window: 300, max: 3 },
  "/forget-password": { window: 300, max: 3 },
  "/send-verification-email": { window: 300, max: 3 },
  // FR-2FA-1: the second factor is six digits, so the attempt limit *is* the
  // security of it.
  "/two-factor/verify-totp": { window: 300, max: 10 },
  "/two-factor/verify-backup-code": { window: 300, max: 10 },
  "/two-factor/verify-otp": { window: 300, max: 10 },
  // A key is a bearer credential; verification is a guessing oracle.
  "/api-key/verify": { window: 60, max: 30 },
  // The authorization endpoint is a redirect factory, and each hit costs a
  // session read.
  "/oauth2/authorize": { window: 60, max: 60 },
  // Per IP. The per-client-id half is in the route handler.
  "/oauth2/token": { window: 60, max: 120 },
}

export type Auth = ReturnType<typeof betterAuth<BetterAuthOptions>>

export function createAuth(deps: AuthDeps) {
  return betterAuth(createAuthOptions(deps))
}
