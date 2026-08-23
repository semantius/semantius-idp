/**
 * The Better Auth callbacks that actually send mail (FR-MAIL-1, FR-AUTH-2/3).
 *
 * Better Auth generates the tokens and hands us a URL; the IdP decides the
 * template, the wording and — crucially — the link's origin. Better Auth builds
 * its URL from `baseURL`, which we set from `server.baseUrl`, but the callback
 * URL it appends comes from the request, so it is rebuilt here against the
 * issuer to satisfy SEC-1 without exception.
 */

import type { IdpConfig } from "../../config/derive"
import type { Mailer } from "../../email/mailer"
import { createBasePaths, APP_ROUTES } from "../../oidc/base-path"

export interface EmailCallbackDeps {
  config: IdpConfig
  mailer: Mailer
}

/**
 * Rebuilds a Better Auth link against the issuer.
 *
 * The token is the only part of the incoming URL that matters; the origin and
 * path are ours to decide, so a poisoned `Host` header cannot turn a
 * verification e-mail into a credential-harvesting link (SEC-1).
 */
export function issuerLink(
  config: IdpConfig,
  route: string,
  token: string,
  extra: Record<string, string> = {}
): string {
  const paths = createBasePaths(config.base)
  const url = new URL(paths.url(route))
  url.searchParams.set("token", token)
  for (const [key, value] of Object.entries(extra))
    url.searchParams.set(key, value)
  return url.toString()
}

export function buildEmailCallbacks(deps: EmailCallbackDeps) {
  const { config, mailer } = deps

  return {
    /** FR-AUTH-2: 24 h, single-use. */
    sendVerificationEmail: async (data: {
      user: { email: string }
      token: string
    }) => {
      await mailer.send("verifyEmail", data.user.email, {
        url: issuerLink(config, APP_ROUTES.verifyEmail, data.token),
      })
    },

    /** FR-AUTH-3: 1 h by default, single-use, invalidated by any password change. */
    sendResetPassword: async (data: {
      user: { email: string }
      token: string
    }) => {
      await mailer.send("resetPassword", data.user.email, {
        url: issuerLink(config, APP_ROUTES.resetPassword, data.token),
      })
    },

    /** FR-AUTH-3: a password change is always announced to its owner. */
    onPasswordReset: async (data: { user: { email: string } }) => {
      await mailer.send("passwordChanged", data.user.email)
    },

    /** FR-ACCT-1: changing an address confirms the new one first. */
    sendChangeEmailConfirmation: async (data: {
      newEmail: string
      token: string
    }) => {
      await mailer.send("verifyEmail", data.newEmail, {
        url: issuerLink(config, APP_ROUTES.verifyEmail, data.token),
      })
    },
  }
}
