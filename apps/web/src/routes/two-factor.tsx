import { createFileRoute, notFound } from "@tanstack/react-router"

import { Button } from "@workspace/ui/components/button"

import { AuthShell } from "@/components/auth/auth-shell"
import { FormAlert, TextField } from "@/components/auth/form-parts"
import { messageForErrorCode } from "@/lib/auth-errors"
import { searchFlag, searchString } from "@/lib/search-params"
import { getCatalog } from "@/server/i18n"
import {
  callAuth,
  readForm,
  redirectWithCookies,
  safeReturnTo,
  withError,
} from "@/server/http/auth-proxy"
import { resolveSignInDestination } from "@/server/http/post-login"
import { readOauthQuery } from "@/lib/oauth-query"
import {
  OAUTH_QUERY_FIELD,
  resumeAuthorization,
} from "@/server/oidc/continuation"
import { APP_ROUTES } from "@/server/oidc/base-path"
import { getRuntime } from "@/server/runtime"

/**
 * `/two-factor` — the second-factor challenge (FR-2FA-1, TST-3).
 *
 * `/login` sends the browser here when Better Auth answers a correct password
 * with `twoFactorRedirect` instead of a session. At that moment there is *no*
 * session: what authorises this page is the short-lived `two_factor` cookie
 * the sign-in set, and completing the challenge is what creates the session.
 * So a failure cannot fall back to "you are already signed in" — it goes back
 * to `/login`.
 *
 * Two ways through, one form each: a TOTP code, or one of the one-time backup
 * codes. `?backup=1` swaps which is shown; the POST decides from the field
 * name, so the two can never be confused for one another.
 *
 * `trustDevice` is offered only when `twoFactor.trustDeviceDays` is greater
 * than zero — an operator who set it to zero meant "always ask", and a
 * checkbox that silently does nothing would be worse than no checkbox.
 */
export const Route = createFileRoute("/two-factor")({
  loader: ({ context, location }) => {
    // FR-2FA-1: with 2FA off the plugin is not registered, there is no
    // challenge to answer, and the page does not exist.
    if (!context.ui.twoFactorEnabled) throw notFound()

    const search = location.search as Record<string, unknown>
    return {
      ui: context.ui,
      backup: searchFlag(search.backup),
      returnTo: safeReturnTo(searchString(search.returnTo), ""),
      oauthQuery: readOauthQuery({ search, searchStr: location.searchStr }),
      error: searchString(search.error),
    }
  },
  component: TwoFactorPage,
  server: {
    handlers: {
      POST: async ({ request }) => {
        const runtime = await getRuntime()
        if (!runtime.config.file.twoFactor.enabled) {
          return new Response(null, { status: 404 })
        }

        const base = runtime.config.base.basePath
        const form = await readForm(request)
        const returnTo = safeReturnTo(form.returnTo, "")
        const oauthQuery = form[OAUTH_QUERY_FIELD]
        const backup = form.backupCode !== undefined

        const params = new URLSearchParams()
        if (returnTo) params.set("returnTo", returnTo)
        if (oauthQuery) params.set(OAUTH_QUERY_FIELD, oauthQuery)
        if (backup) params.set("backup", "1")
        const query = params.toString()
        const here =
          `${base}${APP_ROUTES.twoFactor}` + (query ? `?${query}` : "")

        const result = await callAuth(
          runtime,
          backup ? "/two-factor/verify-backup-code" : "/two-factor/verify-totp",
          {
            code: (backup ? form.backupCode : form.code)?.trim() ?? "",
            // Better Auth reads `trustDevice` from the body of either verify
            // endpoint and honours `trustDeviceMaxAge` from the plugin.
            trustDevice: form.trustDevice === "1",
          },
          request
        )

        if (!result.ok) {
          const code =
            typeof result.body.code === "string" ? result.body.code : ""
          // An expired or consumed challenge cookie is not a wrong code — the
          // user has to sign in again, and saying "that code is not correct"
          // would send them hunting for a typo that is not there.
          if (/TWO_FACTOR_COOKIE|SESSION/i.test(code)) {
            return redirectWithCookies(
              withError(`${base}${APP_ROUTES.login}`, "two_factor_expired"),
              result.cookies
            )
          }
          if (/TOO_MANY|LOCKED|RATE/i.test(code)) {
            return redirectWithCookies(
              withError(here, "two_factor_locked"),
              result.cookies
            )
          }
          return redirectWithCookies(
            withError(here, "two_factor_invalid"),
            result.cookies
          )
        }

        // The sign-in settles here, so this is where the destination is
        // resolved — same rules as `/login`, including an absolute
        // `auth.defaultRedirect` that could not travel through `returnTo`,
        // and any authorization request that was waiting on the challenge.
        const resumed = await resumeAuthorization(
          runtime,
          request,
          oauthQuery,
          result.cookies
        )
        return redirectWithCookies(
          resolveSignInDestination({
            config: runtime.config,
            returnTo,
            pendingContinuation: resumed.destination,
          }),
          result.cookies
        )
      },
    },
  },
})

function TwoFactorPage() {
  const { ui, backup, returnTo, oauthQuery, error } = Route.useLoaderData()
  const t = getCatalog(ui.locale)
  const trustDays = ui.twoFactorTrustDeviceDays

  const otherModeQuery = new URLSearchParams()
  if (returnTo) otherModeQuery.set("returnTo", returnTo)
  if (oauthQuery) otherModeQuery.set(OAUTH_QUERY_FIELD, oauthQuery)
  if (!backup) otherModeQuery.set("backup", "1")
  const otherModeHref =
    `${ui.basePath}${APP_ROUTES.twoFactor}` +
    (otherModeQuery.size ? `?${otherModeQuery.toString()}` : "")

  return (
    <AuthShell
      ui={ui}
      title={t.auth.twoFactor.title}
      description={
        backup
          ? t.auth.twoFactor.backupDescription
          : t.auth.twoFactor.description
      }
    >
      <FormAlert>{messageForErrorCode(error, t)}</FormAlert>

      <form method="post" className="grid gap-4">
        {returnTo ? (
          <input type="hidden" name="returnTo" value={returnTo} />
        ) : null}
        {oauthQuery ? (
          <input type="hidden" name={OAUTH_QUERY_FIELD} value={oauthQuery} />
        ) : null}

        {backup ? (
          <TextField
            name="backupCode"
            label={t.auth.twoFactor.backupCode}
            autoComplete="one-time-code"
            autoFocus
          />
        ) : (
          <TextField
            name="code"
            label={t.auth.twoFactor.code}
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
          />
        )}

        {trustDays > 0 ? (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="trustDevice"
              value="1"
              className="size-4 rounded border-input"
            />
            {t.auth.twoFactor.trustDevice(trustDays)}
          </label>
        ) : null}

        <Button type="submit" className="w-full">
          {t.auth.twoFactor.submit}
        </Button>
      </form>

      <p className="mt-4 text-sm">
        {/* A plain anchor, not a `<Link>`: the challenge cookie is what makes
            this page work, and a full navigation keeps the two forms from
            sharing any client state. */}
        <a
          href={otherModeHref}
          className="text-muted-foreground underline underline-offset-4"
        >
          {backup
            ? t.auth.twoFactor.useAuthenticator
            : t.auth.twoFactor.useBackupCode}
        </a>
      </p>
    </AuthShell>
  )
}
