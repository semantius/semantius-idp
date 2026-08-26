import { createFileRoute, Link } from "@tanstack/react-router"

import { AuthShell } from "@/components/auth/auth-shell"
import { FormAlert } from "@/components/auth/form-parts"
import {
  ConfirmedPasswordFields,
  usePasswordConfirm,
} from "@/components/auth/confirmed-password"
import { messageForErrorCode } from "@/lib/auth-errors"
import { searchFlag, searchString } from "@/lib/search-params"
import { getCatalog } from "@/server/i18n"
import {
  callAuth,
  errorCodeFor,
  readForm,
  redirectWithCookies,
  withError,
} from "@/server/http/auth-proxy"
import { fetchResetToken } from "@/server/functions/reset-token"
import { APP_ROUTES } from "@/server/oidc/base-path"
import { getRuntime } from "@/server/runtime"
import { PendingForm, SubmitButton } from "@/components/common/pending-form"

/**
 * `/reset-password` — and, with `welcome=1`, the invitation (FR-AUTH-3,
 * FR-ADMIN-2, **D65**).
 *
 * The token is carried through the form as a hidden field and spent at
 * submission. It is now also **read** before the form is rendered, which is
 * not the same thing: `findVerificationValue` does not consume anything, and
 * it is what lets this page name the account the link is for and refuse an
 * expired or spent link up front rather than after a password has been typed.
 * The old comment here said a lookup would burn the token; that is true of the
 * POST and was never true of a read
 * (`server/functions/reset-token.ts` sets out the oracle argument).
 *
 * One page, two variants, on the `searchFlag` precedent `/change-password`
 * already sets with `forced`. A reset revokes every other session and — from
 * M8 — the user's OAuth tokens too (FR-OIDC-12), so the page says so before
 * the user commits. An **invitation** says nothing of the sort: that sentence
 * comes from `revokeSessionsOnPasswordReset` and means nothing for an account
 * nobody has ever signed in to. It tells them who made the account instead,
 * which is the copy `email.setPassword` has always used and which never
 * reached the page they land on.
 */
export const Route = createFileRoute("/reset-password")({
  loader: async ({ context, location }) => {
    const search = location.search as Record<string, unknown>
    const token = searchString(search.token) ?? ""
    return {
      ui: context.ui,
      token,
      welcome: searchFlag(search.welcome),
      error: searchString(search.error),
      // A server function, not a direct lookup: this loader is isomorphic and
      // runs in the browser on every client-side navigation, which is the
      // exact mistake `check-client-bundle.ts` exists to catch.
      account: await fetchResetToken({ data: token }),
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
        // The variant survives a refusal, or a mistyped confirmation would
        // turn an invitation back into a password reset (D65).
        const here =
          `${base}${APP_ROUTES.resetPassword}?token=${encodeURIComponent(token)}` +
          (form.welcome === "1" ? "&welcome=1" : "")

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
  const { ui, token, welcome, error, account } = Route.useLoaderData()
  const t = getCatalog(ui.locale)
  const confirm = usePasswordConfirm(t)
  const title = welcome
    ? t.auth.resetPassword.welcomeTitle
    : t.auth.resetPassword.title

  // The link does not work, and saying so here is the whole point: the form
  // used to render regardless and the refusal arrived after a password had
  // been typed twice.
  if (account.state !== "valid") {
    const expired = account.state === "expired"
    // "Request a new one" is self-service, and an invited user may have no
    // self-service to reach: `/forgot-password` is 404 in degraded mode
    // (FR-MAIL-2), and they were not the one who asked for this link.
    const selfService = !welcome && ui.emailEnabled
    return (
      <AuthShell ui={ui} title={title}>
        <FormAlert>
          {selfService
            ? expired
              ? t.auth.resetPassword.expired
              : t.auth.resetPassword.invalid
            : expired
              ? t.auth.resetPassword.expiredAdmin
              : t.auth.resetPassword.invalidAdmin}
        </FormAlert>
        {selfService ? (
          <p className="text-sm">
            <Link
              to={APP_ROUTES.forgotPassword}
              className="underline underline-offset-4"
            >
              {t.auth.forgotPassword.submit}
            </Link>
          </p>
        ) : null}
      </AuthShell>
    )
  }

  return (
    <AuthShell
      ui={ui}
      title={title}
      description={
        <>
          {welcome
            ? t.auth.resetPassword.welcomeDescription(ui.siteName)
            : t.auth.resetPassword.revokedNotice}{" "}
          {/* Which account, which is the first thing anyone with two
              addresses wants to know — and the thing that catches a link
              forwarded to the wrong person before a password is chosen. */}
          {account.email
            ? t.auth.resetPassword.forAccount(account.email)
            : null}
        </>
      }
    >
      <FormAlert>
        {messageForErrorCode(error, t, ui.passwordMinLength)}
      </FormAlert>

      <PendingForm
        busy={t.common.loading}
        method="post"
        className="grid gap-4"
        onSubmit={confirm.onSubmit}
      >
        <input type="hidden" name="token" value={token} />
        {welcome ? <input type="hidden" name="welcome" value="1" /> : null}
        <ConfirmedPasswordFields
          t={t}
          minLength={ui.passwordMinLength}
          error={confirm.error}
          autoFocus
        />
        <SubmitButton className="w-full">
          {welcome
            ? t.auth.resetPassword.welcomeTitle
            : t.auth.resetPassword.submit}
        </SubmitButton>
      </PendingForm>
    </AuthShell>
  )
}
