import { createFileRoute } from "@tanstack/react-router"

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
import { displayName } from "@/server/display-name"
import { APP_ROUTES } from "@/server/oidc/base-path"
import { getRuntime } from "@/server/runtime"
import { PendingForm, SubmitButton } from "@/components/common/pending-form"

/**
 * `/account` — name and address (FR-ACCT-1).
 *
 * Only the display fields are editable here. The address is a *security*
 * change (it is what a reset link goes to), so it lives on `/account/security`
 * behind the freshness gate; changing a first name does not need one.
 *
 * **The display name is not one of them** (**D49**). It is derived from the
 * first and last name in `site.nameFormat` order and shown read-only, so a
 * deployment's user list sorts and reads one way rather than however each
 * person happened to type their own name in. Saving recomputes it.
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
        const firstName = (form.firstName ?? "").trim()
        const lastName = (form.lastName ?? "").trim()
        // The two parts feed the `given_name`/`family_name` claims
        // (FR-SIGNUP-5, FR-OIDC-7); `name` is what applications display and is
        // recomputed from them here rather than accepted from the form (D49).
        // A person with neither part keeps their address as the display name,
        // because a blank one renders as an empty row in every admin table.
        const result = await callAuth(
          runtime,
          "/update-user",
          {
            name:
              displayName(
                firstName,
                lastName,
                runtime.config.file.site.nameFormat
              ) || session.user.email,
            firstName,
            lastName,
          },
          request
        )

        if (!result.ok) {
          return redirectWithCookies(withError(here, errorCodeFor(result)))
        }
        // Replayed, like every other proxied call: `/update-user` re-mints the
        // cached session cookie with the new name, and dropping it left the
        // page rendering the old one.
        return redirectWithCookies(
          `${here}?notice=profile_saved`,
          result.cookies
        )
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
      isAdmin={profile.isAdmin}
    >
      <FormAlert variant="default">{messageForNoticeCode(notice, t)}</FormAlert>
      <FormAlert>
        {messageForErrorCode(error, t, ui.passwordMinLength)}
      </FormAlert>

      <AccountSection title={t.account.profile.title}>
        <PendingForm
          busy={t.common.loading}
          method="post"
          className="grid gap-4"
        >
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
          {/* Read-only, and recomputed on save. Not a disabled input: a
              greyed-out field invites people to try to type in it. */}
          <div className="grid gap-1.5">
            <p className="text-sm font-medium">{t.common.name}</p>
            <p className="text-sm text-muted-foreground">
              {profile.name || profile.email}
            </p>
            <p className="text-xs text-muted-foreground">
              {t.account.profile.nameDerived}
            </p>
          </div>
          <div>
            <SubmitButton>{t.account.profile.submit}</SubmitButton>
          </div>
        </PendingForm>
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
