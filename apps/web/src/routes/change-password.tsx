import { createFileRoute } from "@tanstack/react-router"

import { Button } from "@workspace/ui/components/button"

import { AuthShell } from "@/components/auth/auth-shell"
import { FormAlert, PasswordField } from "@/components/auth/form-parts"
import { messageForErrorCode } from "@/lib/auth-errors"
import { getCatalog } from "@/server/i18n"
import {
  callAuth,
  errorCodeFor,
  readForm,
  redirectWithCookies,
  safeReturnTo,
  withError,
} from "@/server/http/auth-proxy"
import { APP_ROUTES } from "@/server/oidc/base-path"
import { getRuntime } from "@/server/runtime"
import { buildUiContext } from "@/server/ui-context"

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
  loader: async ({ location }) => {
    const runtime = await getRuntime()
    const search = location.search as Record<string, string | undefined>
    return {
      ui: buildUiContext(
        runtime.config,
        runtime.config.file.site.defaultLocale
      ),
      forced: search.forced === "1",
      returnTo: safeReturnTo(search.returnTo, APP_ROUTES.account),
      error: search.error,
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
        const returnTo = safeReturnTo(form.returnTo, APP_ROUTES.account)

        const here =
          `${base}${APP_ROUTES.changePassword}?returnTo=${encodeURIComponent(returnTo)}` +
          (forced ? "&forced=1" : "")

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

        return redirectWithCookies(`${base}${returnTo}`, result.cookies)
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
        <input type="hidden" name="returnTo" value={returnTo} />
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
