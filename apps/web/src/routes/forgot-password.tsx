import { createFileRoute, Link, notFound } from "@tanstack/react-router"

import { Button } from "@workspace/ui/components/button"

import { AuthShell } from "@/components/auth/auth-shell"
import { FormAlert, TextField } from "@/components/auth/form-parts"
import { messageForNoticeCode } from "@/lib/auth-errors"
import { searchString } from "@/lib/search-params"
import { getCatalog } from "@/server/i18n"
import {
  callAuth,
  readForm,
  redirectWithCookies,
} from "@/server/http/auth-proxy"
import { APP_ROUTES } from "@/server/oidc/base-path"
import { getRuntime } from "@/server/runtime"

/**
 * `/forgot-password` (FR-AUTH-3, SEC-7).
 *
 * Absent entirely in degraded mode (FR-MAIL-2) — with no transport there is
 * nothing this page could do, and offering it would be a lie.
 *
 * The answer is the **same whatever happened**: the same redirect, the same
 * notice, whether the address exists, does not exist, or the send failed. That
 * uniformity is the requirement, so the handler deliberately ignores the result.
 */
export const Route = createFileRoute("/forgot-password")({
  loader: ({ context, location }) => {
    if (!context.ui.emailEnabled) throw notFound()

    const search = location.search as Record<string, unknown>
    return {
      ui: context.ui,
      notice: searchString(search.notice),
    }
  },
  component: ForgotPasswordPage,
  server: {
    handlers: {
      POST: async ({ request }) => {
        const runtime = await getRuntime()
        const base = runtime.config.base.basePath
        if (!runtime.config.emailEnabled)
          return new Response("Not found", { status: 404 })

        const form = await readForm(request)

        // SEC-7: the outcome is not inspected, so it cannot leak into the
        // response. A rate limit still applies underneath (SEC-2).
        await callAuth(
          runtime,
          "/request-password-reset",
          { email: form.email ?? "", redirectTo: APP_ROUTES.resetPassword },
          request
        )

        return redirectWithCookies(
          `${base}${APP_ROUTES.forgotPassword}?notice=reset_sent`
        )
      },
    },
  },
})

function ForgotPasswordPage() {
  const { ui, notice } = Route.useLoaderData()
  const t = getCatalog(ui.locale)

  return (
    <AuthShell
      ui={ui}
      title={t.auth.forgotPassword.title}
      description={t.auth.forgotPassword.description}
    >
      <FormAlert variant="default">{messageForNoticeCode(notice, t)}</FormAlert>

      <form method="post" className="grid gap-4">
        <TextField
          name="email"
          type="email"
          inputMode="email"
          label={t.common.email}
          autoComplete="username"
          autoFocus
        />
        <Button type="submit" className="w-full">
          {t.auth.forgotPassword.submit}
        </Button>
      </form>

      <p className="mt-6 text-sm text-muted-foreground">
        <Link to={APP_ROUTES.login} className="underline underline-offset-4">
          {t.common.back}
        </Link>
      </p>
    </AuthShell>
  )
}
