import { createFileRoute } from "@tanstack/react-router"

import {
  AccountSection,
  AccountShell,
} from "@/components/account/account-shell"
import { FormAlert, TextField } from "@/components/auth/form-parts"
import { NoticeToast } from "@/components/common/notice-toast"
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
 * with the rest of them; changing a first name does not.
 *
 * **The display name is not one of them** (**D49**). It is derived from the
 * first and last name in `site.nameFormat` order, so a deployment's user list
 * sorts and reads one way rather than however each person happened to type
 * their own name in. Saving recomputes it.
 *
 * **And it is not shown here either** (**D95**). It used to be, as a read-only
 * row directly under the two fields it is built from, with a sentence
 * underneath explaining the derivation — three lines saying what "First name"
 * and "Last name" say by sitting above them, on the one page where the derived
 * value is also on screen anyway: since **D82** the shell's footer carries it
 * on every page of both signed-in areas, and it updates with the rest of the
 * page when a save re-mints the session cookie.
 */
export const Route = createFileRoute("/account/")({
  loader: ({ context, location }) => {
    const search = location.search as Record<string, unknown>
    return {
      ui: context.ui,
      // The area index: the brand crumb the layout prepends already names it.
      crumbs: [],
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
      title={t.account.profile.title}
      description={t.account.profile.description}
    >
      {/* **D78**: whose account. Redundant when it is your own and your own
          only — and not, the moment an administrator is impersonating, which
          is the one time "Profile updated." needs to say *whose*. */}
      <NoticeToast
        message={messageForNoticeCode(notice, t)}
        subject={profile.email}
      />
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
