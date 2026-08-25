import { createFileRoute, Link } from "@tanstack/react-router"

import { Button } from "@workspace/ui/components/button"

import { AuthShell } from "@/components/auth/auth-shell"
import { FormAlert, TextField } from "@/components/auth/form-parts"
import { searchFlag, searchString } from "@/lib/search-params"
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
    const search = location.search as Record<string, unknown>
    return {
      ui: context.ui,
      /** Set after sign-up: "we sent you a link". */
      sent: searchFlag(search.sent),
      email: searchString(search.email),
      /**
       * Set by the verification endpoint's redirect.
       *
       * `error` wins over `status`: the `callbackURL` the link carries already
       * says `status=success`, and Better Auth signals a refusal by *appending*
       * its own code rather than by rewriting the URL — so a page that read
       * `status` alone would tell someone their expired link had worked.
       */
      status: verificationStatus(search),
      notice: searchString(search.notice),
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

/**
 * Better Auth's four refusals, in this page's vocabulary.
 *
 * `TOKEN_EXPIRED` is the one worth separating: "that link has expired" tells
 * the reader to ask for another, and everything else tells them the link is
 * not one we issued.
 */
function verificationStatus(
  search: Record<string, unknown>
): string | undefined {
  const error = searchString(search.error)
  if (!error) return searchString(search.status)
  return /EXPIRED/i.test(error) ? "expired" : "invalid"
}

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
