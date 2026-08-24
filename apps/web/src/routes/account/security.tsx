import { Link, createFileRoute } from "@tanstack/react-router"

import { Button } from "@workspace/ui/components/button"

import {
  AccountSection,
  AccountShell,
} from "@/components/account/account-shell"
import {
  FormAlert,
  PasswordField,
  TextField,
} from "@/components/auth/form-parts"
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
import { requireFreshSession } from "@/server/http/fresh-session"
import { stash } from "@/server/http/one-shot"
import { claimEnrolment } from "@/server/functions/account"
import type { EnrolmentView } from "@/server/functions/account"
import { APP_ROUTES } from "@/server/oidc/base-path"
import { getRuntime } from "@/server/runtime"
import type { Runtime } from "@/server/runtime"

const HERE = "/account/security"

/**
 * `/account/security` — password, e-mail address and the second factor
 * (FR-ACCT-1, FR-2FA-1).
 *
 * Everything on this page is a sensitive action, so every POST goes through
 * the freshness gate (FR-AUTH-5): each one changes what it takes to get back
 * into the account, which is exactly what someone who has borrowed an unlocked
 * browser would go for.
 *
 * The password change itself lives on `/change-password`, which already exists
 * and is also the forced-change page (FR-AUTH-4). Duplicating it here would
 * mean two forms to keep in step for no gain, so this links to it.
 *
 * Enrolment is two steps because Better Auth stores the secret unverified
 * until a code from it is accepted — which is what stops someone locking
 * themselves out with a mistyped secret. The secret and the backup codes reach
 * the confirmation page through the one-shot stash, never through the URL.
 */
export const Route = createFileRoute("/account/security")({
  loader: async ({ context, location }) => {
    const search = location.search as Record<string, unknown>
    return {
      ui: context.ui,
      profile: context.profile,
      enrolment: await claimEnrolment({
        data: searchString(search.enrolling) ?? "",
      }),
      notice: searchString(search.notice),
      error: searchString(search.error),
    }
  },
  component: SecurityPage,
  server: {
    handlers: {
      POST: async ({ request }) => {
        const runtime = await getRuntime()
        const base = runtime.config.base.basePath
        const here = `${base}${HERE}`

        const fresh = await requireFreshSession(runtime, request, HERE)
        if (!fresh.ok) return fresh.response

        const form = await readForm(request)

        switch (form.action) {
          case "change-email":
            return changeEmail(runtime, request, form, here)
          case "enable-2fa":
            return enableTwoFactor(
              runtime,
              request,
              form,
              here,
              fresh.session.user.id
            )
          case "confirm-2fa":
            return confirmTwoFactor(runtime, request, form, here)
          case "disable-2fa":
            return disableTwoFactor(runtime, request, form, here)
          default:
            return redirectWithCookies(withError(here, "not_found"))
        }
      },
    },
  },
})

// `Runtime` is imported as a type rather than derived from `typeof
// getRuntime`: deriving it kept a live reference to the runtime module in the
// *client* graph, and the whole server — Drizzle, the schema, the config
// loader — came with it. 200 KB of database code in the browser bundle, which
// is the R-4 failure all over again. The client-bundle gate caught it.
type Form = Record<string, string | undefined>

async function changeEmail(
  runtime: Runtime,
  request: Request,
  form: Form,
  here: string
): Promise<Response> {
  // FR-MAIL-2: without a transport there is no confirmation to send, so the
  // feature does not exist rather than half-working.
  if (!runtime.config.emailEnabled) {
    return redirectWithCookies(withError(here, "not_found"))
  }

  const result = await callAuth(
    runtime,
    "/change-email",
    { newEmail: (form.newEmail ?? "").trim() },
    request
  )
  if (!result.ok) {
    return redirectWithCookies(withError(here, errorCodeFor(result)))
  }
  return redirectWithCookies(`${here}?notice=email_change_sent`)
}

async function enableTwoFactor(
  runtime: Runtime,
  request: Request,
  form: Form,
  here: string,
  userId: string
): Promise<Response> {
  const result = await callAuth(
    runtime,
    "/two-factor/enable",
    { password: form.password ?? "" },
    request
  )
  if (!result.ok) {
    const code = typeof result.body.code === "string" ? result.body.code : ""
    return redirectWithCookies(
      withError(
        here,
        /INVALID_PASSWORD/i.test(code)
          ? "wrong_current_password"
          : errorCodeFor(result)
      )
    )
  }

  const totpUri =
    typeof result.body.totpURI === "string" ? result.body.totpURI : ""
  const backupCodes = Array.isArray(result.body.backupCodes)
    ? (result.body.backupCodes as string[])
    : []

  const handle = await stash(
    runtime,
    JSON.stringify({ userId, totpUri, backupCodes }),
    // Long enough to fetch an authenticator app, short enough that an
    // abandoned enrolment does not sit in the table for the day.
    { ttlSeconds: 900 }
  )

  return redirectWithCookies(
    `${here}?enrolling=${encodeURIComponent(handle)}`,
    result.cookies
  )
}

async function confirmTwoFactor(
  runtime: Runtime,
  request: Request,
  form: Form,
  here: string
): Promise<Response> {
  const result = await callAuth(
    runtime,
    "/two-factor/verify-totp",
    { code: (form.code ?? "").trim() },
    request
  )
  if (!result.ok) {
    return redirectWithCookies(withError(here, "two_factor_invalid"))
  }
  return redirectWithCookies(`${here}?notice=twofactor_on`, result.cookies)
}

async function disableTwoFactor(
  runtime: Runtime,
  request: Request,
  form: Form,
  here: string
): Promise<Response> {
  const result = await callAuth(
    runtime,
    "/two-factor/disable",
    { password: form.password ?? "" },
    request
  )
  if (!result.ok) {
    const code = typeof result.body.code === "string" ? result.body.code : ""
    return redirectWithCookies(
      withError(
        here,
        /INVALID_PASSWORD/i.test(code)
          ? "wrong_current_password"
          : errorCodeFor(result)
      )
    )
  }
  return redirectWithCookies(`${here}?notice=twofactor_off`, result.cookies)
}

function SecurityPage() {
  const { ui, profile, enrolment, notice, error } = Route.useLoaderData()
  const t = getCatalog(ui.locale)

  return (
    <AccountShell
      ui={ui}
      t={t}
      title={t.account.security.title}
      impersonated={profile.impersonated}
    >
      <FormAlert variant="default">{messageForNoticeCode(notice, t)}</FormAlert>
      <FormAlert>{messageForErrorCode(error, t)}</FormAlert>

      <AccountSection
        title={t.account.security.changePassword.title}
        description={t.account.security.changePassword.description}
      >
        <Link
          to={APP_ROUTES.changePassword}
          search={{ returnTo: HERE }}
          className="text-sm underline underline-offset-4"
        >
          {t.account.security.changePassword.submit}
        </Link>
      </AccountSection>

      {/* FR-MAIL-2: with no transport there is no confirmation to send. */}
      {ui.emailEnabled ? (
        <AccountSection
          title={t.account.changeEmail.title}
          description={t.account.changeEmail.description}
        >
          <form method="post" className="grid gap-4">
            <input type="hidden" name="action" value="change-email" />
            <TextField
              name="newEmail"
              type="email"
              inputMode="email"
              label={t.account.changeEmail.newEmail}
              autoComplete="email"
            />
            <div>
              <Button type="submit">{t.account.changeEmail.submit}</Button>
            </div>
          </form>
        </AccountSection>
      ) : null}

      {/* FR-2FA-1: with 2FA off there is nothing to enrol in. */}
      {ui.twoFactorEnabled ? (
        <AccountSection
          title={t.account.twoFactor.title}
          description={t.account.twoFactor.description}
        >
          {enrolment ? (
            <TwoFactorEnrolment enrolment={enrolment} t={t} />
          ) : profile.twoFactorEnabled ? (
            <form method="post" className="grid gap-4">
              <input type="hidden" name="action" value="disable-2fa" />
              <p className="text-sm">{t.account.twoFactor.enabled}</p>
              <PasswordField
                name="password"
                label={t.account.twoFactor.passwordToDisable}
                autoComplete="current-password"
                showLabel={t.common.showPassword}
                hideLabel={t.common.hidePassword}
              />
              <div>
                <Button type="submit" variant="outline">
                  {t.account.twoFactor.disable}
                </Button>
              </div>
            </form>
          ) : (
            <form method="post" className="grid gap-4">
              <input type="hidden" name="action" value="enable-2fa" />
              <p className="text-sm">{t.account.twoFactor.disabled}</p>
              <PasswordField
                name="password"
                label={t.common.password}
                autoComplete="current-password"
                showLabel={t.common.showPassword}
                hideLabel={t.common.hidePassword}
              />
              <div>
                <Button type="submit">{t.account.twoFactor.enable}</Button>
              </div>
            </form>
          )}
        </AccountSection>
      ) : null}
    </AccountShell>
  )
}

function TwoFactorEnrolment({
  enrolment,
  t,
}: {
  enrolment: EnrolmentView
  t: ReturnType<typeof getCatalog>
}) {
  return (
    <div className="grid gap-4">
      <p className="text-sm">{t.account.twoFactor.scanQr}</p>

      {/* Rendered on the server from the `otpauth://` URI, which never leaves
          it: the browser gets a picture, not the shared secret in a link. */}
      <div
        className="w-[200px] [&_svg]:h-auto [&_svg]:w-full [&_svg]:rounded-lg [&_svg]:bg-white [&_svg]:p-2"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: enrolment.qrSvg }}
      />

      <p className="text-sm text-muted-foreground">
        {t.account.twoFactor.manualEntry}{" "}
        <code className="font-mono break-all">{enrolment.manualKey}</code>
      </p>

      <div>
        <h4 className="text-sm font-medium">
          {t.account.twoFactor.backupCodes}
        </h4>
        <p className="text-sm text-muted-foreground">
          {t.account.twoFactor.backupCodesNotice}
        </p>
        <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-sm">
          {enrolment.backupCodes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
      </div>

      <form method="post" className="grid gap-4">
        <input type="hidden" name="action" value="confirm-2fa" />
        <TextField
          name="code"
          label={t.account.twoFactor.confirm}
          inputMode="numeric"
          autoComplete="one-time-code"
        />
        <div>
          <Button type="submit">{t.account.twoFactor.confirmSubmit}</Button>
        </div>
      </form>
    </div>
  )
}
