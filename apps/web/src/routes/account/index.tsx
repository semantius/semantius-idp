import { createFileRoute } from "@tanstack/react-router"

import { Button } from "@workspace/ui/components/button"

import {
  AccountSection,
  AccountShell,
} from "@/components/account/account-shell"
import { FormAlert, TextField } from "@/components/auth/form-parts"
import { messageForErrorCode, messageForNoticeCode } from "@/lib/auth-errors"
import { searchString } from "@/lib/search-params"
import { getCatalog } from "@/server/i18n"
import {
  callAuth,
  errorCodeFor,
  readForm,
  redirectWithCookies,
  withError,
} from "@/server/http/auth-proxy"
import { readSession } from "@/server/http/session"
import { APP_ROUTES } from "@/server/oidc/base-path"
import { getRuntime } from "@/server/runtime"

/**
 * `/account` — name and address (FR-ACCT-1).
 *
 * Only the display fields are editable here. The address is a *security*
 * change (it is what a reset link goes to), so it lives on `/account/security`
 * behind the freshness gate; changing a first name does not need one.
 */
export const Route = createFileRoute("/account/")({
  loader: ({ context, location }) => {
    const search = location.search as Record<string, unknown>
    return {
      ui: context.ui,
      profile: context.profile,
      notice: searchString(search.notice),
      error: searchString(search.error),
    }
  },
  component: ProfilePage,
  server: {
    handlers: {
      POST: async ({ request }) => {
        const runtime = await getRuntime()
        const base = runtime.config.base.basePath
        const here = `${base}${APP_ROUTES.account}`

        const session = await readSession(runtime, request)
        if (!session) {
          return redirectWithCookies(
            `${base}${APP_ROUTES.login}?notice=signin_required`
          )
        }

        const form = await readForm(request)
        // `name` is what applications display; the two parts feed the
        // `given_name`/`family_name` claims (FR-SIGNUP-5, FR-OIDC-7).
        const result = await callAuth(
          runtime,
          "/update-user",
          {
            name: (form.name ?? "").trim(),
            firstName: (form.firstName ?? "").trim(),
            lastName: (form.lastName ?? "").trim(),
          },
          request
        )

        if (!result.ok) {
          return redirectWithCookies(withError(here, errorCodeFor(result)))
        }
        return redirectWithCookies(`${here}?notice=profile_saved`)
      },
    },
  },
})

function ProfilePage() {
  const { ui, profile, notice, error } = Route.useLoaderData()
  const t = getCatalog(ui.locale)

  return (
    <AccountShell
      ui={ui}
      t={t}
      title={t.account.profile.title}
      description={t.account.profile.description}
      impersonated={profile.impersonated}
    >
      <FormAlert variant="default">{messageForNoticeCode(notice, t)}</FormAlert>
      <FormAlert>{messageForErrorCode(error, t)}</FormAlert>

      <AccountSection title={t.account.profile.title}>
        <form method="post" className="grid gap-4">
          <TextField
            name="name"
            label={t.common.name}
            defaultValue={profile.name}
            autoComplete="name"
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              name="firstName"
              label={t.common.firstName}
              defaultValue={profile.firstName}
              autoComplete="given-name"
              required={false}
            />
            <TextField
              name="lastName"
              label={t.common.lastName}
              defaultValue={profile.lastName}
              autoComplete="family-name"
              required={false}
            />
          </div>
          <div>
            <Button type="submit">{t.account.profile.submit}</Button>
          </div>
        </form>
      </AccountSection>

      <AccountSection title={t.common.email}>
        <p className="text-sm">
          {profile.email}{" "}
          <span className="text-muted-foreground">
            {profile.emailVerified
              ? `· ${t.account.profile.emailVerified}`
              : `· ${t.account.profile.emailUnverified}`}
          </span>
        </p>
      </AccountSection>

      <AccountSection title={t.account.profile.roles}>
        <p className="text-sm text-muted-foreground">
          {profile.roles.length > 0
            ? profile.roles.join(", ")
            : t.account.profile.noRoles}
        </p>
      </AccountSection>
    </AccountShell>
  )
}
