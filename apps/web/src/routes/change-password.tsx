import { createFileRoute } from "@tanstack/react-router"

import { Button } from "@workspace/ui/components/button"

import { AuthShell } from "@/components/auth/auth-shell"
import { FormAlert, PasswordField } from "@/components/auth/form-parts"
import { messageForErrorCode } from "@/lib/auth-errors"
import { searchFlag, searchString } from "@/lib/search-params"
import { getCatalog } from "@/server/i18n"
import {
  callAuth,
  errorCodeFor,
  readForm,
  redirectWithCookies,
  safeReturnTo,
  withError,
} from "@/server/http/auth-proxy"
import { resolveSignInDestination } from "@/server/http/post-login"
import { APP_ROUTES } from "@/server/oidc/base-path"
import { getRuntime } from "@/server/runtime"

/**
 * `/change-password` — including the forced variant (FR-AUTH-4).
 *
 * A user flagged `mustChangePassword` is interposed here before anything else
 * completes, and `returnTo` carries where they were going — including an OAuth
 * continuation, which is why the parameter is validated as a same-origin
 * relative path rather than trusted (SEC-3).
 *
 * The forced variant has no way out: no cancel link, no navigation. Leaving it
 * available would make the flag advisory.
 */
export const Route = createFileRoute("/change-password")({
  loader: ({ context, location }) => {
    const search = location.search as Record<string, unknown>
    return {
      ui: context.ui,
      forced: searchFlag(search.forced),
      // Empty, not `/account`: an absent value has to fall through to
      // `auth.defaultRedirect` when the form is submitted (D28).
      returnTo: safeReturnTo(searchString(search.returnTo), ""),
      error: searchString(search.error),
    }
  },
  component: ChangePasswordPage,
  server: {
    handlers: {
      POST: async ({ request }) => {
        const runtime = await getRuntime()
        const base = runtime.config.base.basePath
        const form = await readForm(request)
        const forced = form.forced === "1"
        const returnTo = safeReturnTo(form.returnTo, "")

        // Built from parts because `returnTo` is now optional — an absent one
        // must not leave a stray `?&` behind (D28).
        const params = new URLSearchParams()
        if (returnTo) params.set("returnTo", returnTo)
        if (forced) params.set("forced", "1")
        const query = params.toString()
        const here =
          `${base}${APP_ROUTES.changePassword}` + (query ? `?${query}` : "")

        if (form.password !== form.confirmPassword) {
          return redirectWithCookies(withError(here, "password_mismatch"))
        }

        const result = await callAuth(
          runtime,
          "/change-password",
          {
            currentPassword: form.currentPassword ?? "",
            newPassword: form.password ?? "",
            // FR-AUTH-3: a change revokes the user's other sessions.
            revokeOtherSessions: true,
          },
          request
        )

        if (!result.ok) {
          const code =
            typeof result.body.code === "string" ? result.body.code : ""
          const mapped = /INVALID_PASSWORD|INCORRECT/i.test(code)
            ? "wrong_current_password"
            : errorCodeFor(result)
          return redirectWithCookies(withError(here, mapped))
        }

        // Re-resolved rather than round-tripped: this is the far end of the
        // FR-AUTH-4 interposition, and an absolute `auth.defaultRedirect`
        // never travelled through the query to get here (D28).
        return redirectWithCookies(
          resolveSignInDestination({ config: runtime.config, returnTo }),
          result.cookies
        )
      },
    },
  },
})

function ChangePasswordPage() {
  const { ui, forced, returnTo, error } = Route.useLoaderData()
  const t = getCatalog(ui.locale)

  return (
    <AuthShell
      ui={ui}
      title={
        forced ? t.auth.changePassword.forcedTitle : t.auth.changePassword.title
      }
      description={forced ? t.auth.changePassword.forcedDescription : undefined}
    >
      <FormAlert>{messageForErrorCode(error, t)}</FormAlert>

      <form method="post" className="grid gap-4">
        {returnTo ? (
          <input type="hidden" name="returnTo" value={returnTo} />
        ) : null}
        {forced ? <input type="hidden" name="forced" value="1" /> : null}

        <PasswordField
          name="currentPassword"
          label={t.common.currentPassword}
          autoComplete="current-password"
          showLabel={t.common.showPassword}
          hideLabel={t.common.hidePassword}
          autoFocus
        />
        <PasswordField
          name="password"
          label={t.common.newPassword}
          autoComplete="new-password"
          minLength={ui.passwordMinLength}
          hint={t.auth.signUp.passwordHint(ui.passwordMinLength)}
          showLabel={t.common.showPassword}
          hideLabel={t.common.hidePassword}
        />
        <PasswordField
          name="confirmPassword"
          label={t.common.confirmPassword}
          autoComplete="new-password"
          minLength={ui.passwordMinLength}
          showLabel={t.common.showPassword}
          hideLabel={t.common.hidePassword}
        />

        <Button type="submit" className="w-full">
          {t.auth.changePassword.submit}
        </Button>
      </form>
    </AuthShell>
  )
}
