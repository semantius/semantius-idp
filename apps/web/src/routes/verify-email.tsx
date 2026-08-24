import { createFileRoute, Link } from "@tanstack/react-router"

import { Button } from "@workspace/ui/components/button"

import { AuthShell } from "@/components/auth/auth-shell"
import { FormAlert, TextField } from "@/components/auth/form-parts"
import { getCatalog } from "@/server/i18n"
import {
  callAuth,
  readForm,
  redirectWithCookies,
} from "@/server/http/auth-proxy"
import { APP_ROUTES } from "@/server/oidc/base-path"
import { getRuntime } from "@/server/runtime"

/**
 * `/verify-email` (FR-AUTH-2, FR-ACCT-2).
 *
 * Three states on one route, because the user arrives here from three
 * directions: told to check their inbox, back from a link that worked, or back
 * from one that did not. The resend form is the only action, and — like
 * `/forgot-password` — it answers identically whatever happened (SEC-7).
 *
 * The link itself is consumed by Better Auth's own endpoint; this page shows
 * the outcome it redirected to.
 */
export const Route = createFileRoute("/verify-email")({
  loader: ({ context, location }) => {
    const search = location.search as Record<string, string | undefined>
    return {
      ui: context.ui,
      /** Set after sign-up: "we sent you a link". */
      sent: search.sent === "1",
      email: search.email,
      /** Set by the verification endpoint's redirect. */
      status: search.status,
      notice: search.notice,
    }
  },
  component: VerifyEmailPage,
  server: {
    handlers: {
      POST: async ({ request }) => {
        const runtime = await getRuntime()
        const base = runtime.config.base.basePath
        if (!runtime.config.emailEnabled)
          return new Response("Not found", { status: 404 })

        const form = await readForm(request)

        // SEC-7: the result is not inspected, so the response cannot reveal
        // whether that address exists or still needs confirming.
        await callAuth(
          runtime,
          "/send-verification-email",
          { email: form.email ?? "", callbackURL: APP_ROUTES.login },
          request
        )

        return redirectWithCookies(
          `${base}${APP_ROUTES.verifyEmail}?notice=verification_sent`
        )
      },
    },
  },
})

function VerifyEmailPage() {
  const { ui, sent, email, status, notice } = Route.useLoaderData()
  const t = getCatalog(ui.locale)

  const outcome =
    status === "success"
      ? { variant: "default" as const, message: t.auth.verifyEmail.success }
      : status === "expired"
        ? {
            variant: "destructive" as const,
            message: t.auth.verifyEmail.expired,
          }
        : status === "used"
          ? {
              variant: "destructive" as const,
              message: t.auth.verifyEmail.used,
            }
          : status === "invalid"
            ? {
                variant: "destructive" as const,
                message: t.auth.verifyEmail.invalid,
              }
            : undefined

  return (
    <AuthShell
      ui={ui}
      title={t.auth.verifyEmail.title}
      description={
        sent && email ? t.auth.verifyEmail.pending(email) : undefined
      }
    >
      {outcome ? (
        <FormAlert variant={outcome.variant}>{outcome.message}</FormAlert>
      ) : null}
      {notice === "verification_sent" ? (
        <FormAlert variant="default">{t.auth.verifyEmail.resent}</FormAlert>
      ) : null}

      {status === "success" ? (
        <p className="text-sm">
          <Link to={APP_ROUTES.login} className="underline underline-offset-4">
            {t.common.signIn}
          </Link>
        </p>
      ) : (
        <form method="post" className="grid gap-4">
          <TextField
            name="email"
            type="email"
            inputMode="email"
            label={t.common.email}
            autoComplete="username"
            defaultValue={email}
          />
          <Button type="submit" className="w-full">
            {t.auth.verifyEmail.resend}
          </Button>
        </form>
      )}
    </AuthShell>
  )
}
