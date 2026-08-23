import { createFileRoute, Link, notFound } from "@tanstack/react-router"

import { Button } from "@workspace/ui/components/button"

import { AuthShell } from "@/components/auth/auth-shell"
import {
  FormAlert,
  PasswordField,
  TextField,
} from "@/components/auth/form-parts"
import { messageForErrorCode } from "@/lib/auth-errors"
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
import { buildUiContext } from "@/server/ui-context"

/**
 * `/signup` — self-registration (FR-SIGNUP-1..5).
 *
 * **404 when `signUp.enabled` is false**, not a disabled form: the requirement
 * is that the page does not exist, so an invite-only deployment gives a curious
 * visitor nothing to work with.
 *
 * Where the new account lands depends on configuration, and the page says which
 * before the user commits: approval pending, confirm your address, or straight in.
 */
export const Route = createFileRoute("/signup")({
  loader: async ({ location }) => {
    const runtime = await getRuntime()
    // FR-SIGNUP-1.
    if (!runtime.config.file.signUp.enabled) throw notFound()

    const search = location.search as Record<string, string | undefined>
    return {
      ui: buildUiContext(
        runtime.config,
        runtime.config.file.site.defaultLocale
      ),
      error: search.error,
    }
  },
  component: SignUpPage,
  server: {
    handlers: {
      POST: async ({ request }) => {
        const runtime = await getRuntime()
        const base = runtime.config.base.basePath

        if (!runtime.config.file.signUp.enabled) {
          // FR-SIGNUP-1: the endpoint is as absent as the page.
          return new Response("Not found", { status: 404 })
        }

        const form = await readForm(request)
        const here = `${base}${APP_ROUTES.signup}`

        const firstName = form.firstName ?? ""
        const lastName = form.lastName ?? ""
        const result = await callAuth(
          runtime,
          "/sign-up/email",
          {
            email: form.email ?? "",
            password: form.password ?? "",
            // FR-SIGNUP-5: `name` falls back to "firstName lastName" in the
            // database hook; sending it keeps Better Auth's own validation happy.
            name:
              [firstName, lastName].filter(Boolean).join(" ") ||
              (form.email ?? ""),
            ...(firstName ? { firstName } : {}),
            ...(lastName ? { lastName } : {}),
          },
          request
        )

        if (!result.ok) {
          return redirectWithCookies(withError(here, errorCodeFor(result)))
        }

        // FR-SIGNUP-2: approval comes after verification, so the page the user
        // lands on is whichever gate is actually next.
        if (runtime.config.file.signUp.requireApproval) {
          return redirectWithCookies(`${base}${APP_ROUTES.pendingApproval}`)
        }
        if (runtime.config.requireEmailVerification) {
          return redirectWithCookies(
            `${base}${APP_ROUTES.verifyEmail}?sent=1&email=${encodeURIComponent(form.email ?? "")}`
          )
        }
        return redirectWithCookies(
          `${base}${APP_ROUTES.login}?notice=account_created`
        )
      },
    },
  },
})

function SignUpPage() {
  const { ui, error } = Route.useLoaderData()
  const t = getCatalog(ui.locale)

  return (
    <AuthShell
      ui={ui}
      title={t.auth.signUp.title}
      description={
        <>
          {ui.requireApproval ? <p>{t.auth.signUp.approvalNotice}</p> : null}
          {ui.requireEmailVerification ? (
            <p>{t.auth.signUp.verifyNotice}</p>
          ) : null}
        </>
      }
    >
      <FormAlert>{messageForErrorCode(error, t)}</FormAlert>

      <form method="post" className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            name="firstName"
            label={t.common.firstName}
            autoComplete="given-name"
            required={false}
          />
          <TextField
            name="lastName"
            label={t.common.lastName}
            autoComplete="family-name"
            required={false}
          />
        </div>

        <TextField
          name="email"
          type="email"
          inputMode="email"
          label={t.common.email}
          autoComplete="username"
        />
        <PasswordField
          name="password"
          label={t.common.password}
          autoComplete="new-password"
          minLength={ui.passwordMinLength}
          hint={t.auth.signUp.passwordHint(ui.passwordMinLength)}
          showLabel={t.common.showPassword}
          hideLabel={t.common.hidePassword}
        />

        <Button type="submit" className="w-full">
          {t.auth.signUp.submit}
        </Button>
      </form>

      <p className="mt-6 text-sm text-muted-foreground">
        {t.auth.signUp.haveAccount}{" "}
        <Link to={APP_ROUTES.login} className="underline underline-offset-4">
          {t.common.signIn}
        </Link>
      </p>
    </AuthShell>
  )
}
