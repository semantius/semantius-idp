import { createFileRoute, Link } from "@tanstack/react-router"

import { Button } from "@workspace/ui/components/button"

import { AuthShell } from "@/components/auth/auth-shell"
import { FormAlert, PasswordField } from "@/components/auth/form-parts"
import { messageForErrorCode } from "@/lib/auth-errors"
import { searchString } from "@/lib/search-params"
import { getCatalog } from "@/server/i18n"
import {
  callAuth,
  errorCodeFor,
  readForm,
  redirectWithCookies,
  withError,
} from "@/server/http/auth-proxy"
import { APP_ROUTES } from "@/server/oidc/base-path"
import { getRuntime } from "@/server/runtime"

/**
 * `/reset-password` (FR-AUTH-3).
 *
 * The token arrives in the query string and is carried through the form as a
 * hidden field rather than being validated up front: Better Auth consumes it
 * once, at submission, and asking it twice would burn a single-use token just
 * to render a page.
 *
 * Completing a reset revokes every other session and — from M8 — the user's
 * OAuth tokens too (FR-OIDC-12), so the page says so before the user commits.
 */
export const Route = createFileRoute("/reset-password")({
  loader: ({ context, location }) => {
    const search = location.search as Record<string, unknown>
    return {
      ui: context.ui,
      token: searchString(search.token) ?? "",
      error: searchString(search.error),
    }
  },
  component: ResetPasswordPage,
  server: {
    handlers: {
      POST: async ({ request }) => {
        const runtime = await getRuntime()
        const base = runtime.config.base.basePath
        const form = await readForm(request)
        const token = form.token ?? ""
        const here = `${base}${APP_ROUTES.resetPassword}?token=${encodeURIComponent(token)}`

        if (form.password !== form.confirmPassword) {
          return redirectWithCookies(withError(here, "password_mismatch"))
        }

        const result = await callAuth(
          runtime,
          "/reset-password",
          { token, newPassword: form.password ?? "" },
          request
        )

        if (!result.ok) {
          const code =
            typeof result.body.code === "string" ? result.body.code : ""
          const mapped = /EXPIRED/i.test(code)
            ? "token_expired"
            : /INVALID|NOT_FOUND/i.test(code)
              ? "token_invalid"
              : errorCodeFor(result)
          return redirectWithCookies(withError(here, mapped))
        }

        // Straight to sign-in: the reset revoked the old sessions, so there is
        // nothing to resume.
        return redirectWithCookies(
          `${base}${APP_ROUTES.login}?notice=password_changed`
        )
      },
    },
  },
})

function ResetPasswordPage() {
  const { ui, token, error } = Route.useLoaderData()
  const t = getCatalog(ui.locale)

  if (!token) {
    return (
      <AuthShell ui={ui} title={t.auth.resetPassword.title}>
        <FormAlert>{t.auth.resetPassword.invalid}</FormAlert>
        <p className="text-sm">
          <Link
            to={APP_ROUTES.forgotPassword}
            className="underline underline-offset-4"
          >
            {t.auth.forgotPassword.submit}
          </Link>
        </p>
      </AuthShell>
    )
  }

  return (
    <AuthShell
      ui={ui}
      title={t.auth.resetPassword.title}
      description={t.auth.resetPassword.revokedNotice}
    >
      <FormAlert>{messageForErrorCode(error, t)}</FormAlert>

      <form method="post" className="grid gap-4">
        <input type="hidden" name="token" value={token} />
        <PasswordField
          name="password"
          label={t.common.newPassword}
          autoComplete="new-password"
          minLength={ui.passwordMinLength}
          hint={t.auth.signUp.passwordHint(ui.passwordMinLength)}
          showLabel={t.common.showPassword}
          hideLabel={t.common.hidePassword}
          autoFocus
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
          {t.auth.resetPassword.submit}
        </Button>
      </form>
    </AuthShell>
  )
}
