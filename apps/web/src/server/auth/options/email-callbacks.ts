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
import { AUTH_BASE_PATH, createBasePaths, APP_ROUTES } from "../../oidc/base-path"

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

/**
 * The link a verification e-mail carries.
 *
 * **It points at Better Auth's own endpoint, not at `/verify-email`.** The
 * app route of that name renders the *outcome* — confirmed, expired, already
 * used — and has no way to spend a token; a link straight to it opened a page
 * that offered to send another one, and the address was never confirmed. The
 * e2e suite is what finally noticed, because it is the only layer that opens
 * the link the way a person does.
 *
 * So the token goes where it is consumed, and `callbackURL` brings the browser
 * back to the branded page afterwards. That also keeps the mutation inside
 * Better Auth's handler, where the SEC-6 audit hook for `/verify-email`
 * already lives, and out of a route loader — loaders are isomorphic and run on
 * client navigations too, which is no place for something that spends a
 * single-use token.
 *
 * On failure Better Auth appends `&error=<code>` to this URL rather than
 * replacing it, which is why the page reads `error` in preference to
 * `status` (`routes/verify-email.tsx`).
 *
 * Still built from `server.baseUrl` only, so a poisoned `Host` header cannot
 * redirect the confirmation anywhere (SEC-1).
 */
export function verificationLink(config: IdpConfig, token: string): string {
  const paths = createBasePaths(config.base)
  const url = new URL(paths.url(`${AUTH_BASE_PATH}/verify-email`))
  url.searchParams.set("token", token)
  url.searchParams.set(
    "callbackURL",
    `${paths.path(APP_ROUTES.verifyEmail)}?status=success`
  )
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
        url: verificationLink(config, data.token),
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
        url: verificationLink(config, data.token),
      })
    },
  }
}
