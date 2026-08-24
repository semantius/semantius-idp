import { createFileRoute, Link } from "@tanstack/react-router"

import { Button } from "@workspace/ui/components/button"
import { Separator } from "@workspace/ui/components/separator"

import { AuthShell } from "@/components/auth/auth-shell"
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
  safeReturnTo,
  withError,
} from "@/server/http/auth-proxy"
import { resolveSignInDestination } from "@/server/http/post-login"
import { readOauthQuery } from "@/lib/oauth-query"
import {
  OAUTH_QUERY_FIELD,
  resumeAuthorization,
} from "@/server/oidc/continuation"
import { APP_ROUTES } from "@/server/oidc/base-path"
import { getRuntime } from "@/server/runtime"
import type { UiContext } from "@/server/ui-context"

/**
 * `/login` — password sign-in plus whichever social providers are configured
 * (FR-AUTH-1, FR-ACCT-2).
 *
 * A plain form posting to this same route, so the page is usable on the first
 * paint rather than after a hydration round trip. (Surviving scripting being
 * off is no longer a requirement — D31 — but the shape is worth keeping: it
 * is what makes the POST a real form submission.) It forwards to Better Auth
 * with the original
 * headers, so the CSRF origin check applies unchanged (SEC-3), and answers with
 * a 303 — a refresh cannot re-post a password.
 *
 * Failures redirect back with a **code**; the wording comes from the catalog.
 * Wrong password and unknown address produce the same code (SEC-7).
 */
export const Route = createFileRoute("/login")({
  loader: ({ context, location }) => {
    const search = location.search as Record<string, unknown>
    return {
      ui: context.ui,
      error: searchString(search.error),
      notice: searchString(search.notice),
      returnTo: safeReturnTo(searchString(search.returnTo), ""),
      // The provider puts the whole signed authorization request in the query
      // when it sends someone here to sign in (FR-OIDC-9). Carried through
      // the form unread: only the provider can verify it.
      oauthQuery: readOauthQuery({ search, searchStr: location.searchStr }),
    }
  },
  component: LoginPage,
  server: {
    handlers: {
      POST: async ({ request }) => {
        const runtime = await getRuntime()
        const form = await readForm(request)
        // Empty rather than `/account`: an absent `returnTo` must fall through
        // to `auth.defaultRedirect`, not pre-empt it (D28).
        const returnTo = safeReturnTo(form.returnTo, "")
        // The signed authorization request, when the provider sent the user
        // here from `/oauth2/authorize` (FR-OIDC-9). Opaque to this handler:
        // it is verified by the provider, not by us.
        const oauthQuery = form[OAUTH_QUERY_FIELD]
        const here = `${runtime.config.base.basePath}${APP_ROUTES.login}`

        const result = await callAuth(
          runtime,
          "/sign-in/email",
          { email: form.email ?? "", password: form.password ?? "" },
          request
        )

        if (!result.ok) {
          const code = errorCodeFor(result)
          // The status gate has its own pages rather than an inline message,
          // because "wait for approval" and "you are suspended" are states, not
          // input errors (FR-SIGNUP-2, FR-ADMIN-4).
          if (code === "pending_approval") {
            return redirectWithCookies(
              `${runtime.config.base.basePath}${APP_ROUTES.pendingApproval}`
            )
          }
          if (code === "banned") {
            return redirectWithCookies(
              `${runtime.config.base.basePath}${APP_ROUTES.banned}`
            )
          }
          return redirectWithCookies(
            withError(
              returnTo
                ? `${here}?returnTo=${encodeURIComponent(returnTo)}`
                : here,
              code
            )
          )
        }

        // FR-2FA-1: a correct password with 2FA on is not a session yet.
        // Better Auth answers 200 with `twoFactorRedirect` and sets the
        // short-lived challenge cookie, which is the only thing that
        // authorises `/two-factor` — so the cookies have to be replayed.
        if (result.body.twoFactorRedirect === true) {
          const challenge = `${runtime.config.base.basePath}${APP_ROUTES.twoFactor}`
          const params = new URLSearchParams()
          if (returnTo) params.set("returnTo", returnTo)
          if (oauthQuery) params.set(OAUTH_QUERY_FIELD, oauthQuery)
          const query = params.toString()
          return redirectWithCookies(
            query ? `${challenge}?${query}` : challenge,
            result.cookies
          )
        }

        // FR-AUTH-4: a temporary password is changed before anything else
        // completes, including an OAuth continuation.
        const user = result.body.user as
          | { mustChangePassword?: boolean }
          | undefined

        if (user?.mustChangePassword) {
          // FR-AUTH-4 ahead of FR-OIDC-9: the authorization is carried to the
          // change-password page rather than resumed here, so a temporary
          // password can never buy an authorization code.
          //
          // Only a *relative* returnTo round-trips through the query — an
          // absolute `auth.defaultRedirect` would not survive `safeReturnTo`
          // at the other end, so the change-password handler re-resolves it
          // there instead (D28).
          const params = new URLSearchParams({ forced: "1" })
          if (returnTo) params.set("returnTo", returnTo)
          if (oauthQuery) params.set(OAUTH_QUERY_FIELD, oauthQuery)
          return redirectWithCookies(
            `${runtime.config.base.basePath}${APP_ROUTES.changePassword}?${params.toString()}`,
            result.cookies
          )
        }

        // Every gate is satisfied, so the authorization may proceed.
        const resumed = await resumeAuthorization(
          runtime,
          request,
          oauthQuery,
          result.cookies
        )

        return redirectWithCookies(
          resolveSignInDestination({
            config: runtime.config,
            returnTo,
            pendingContinuation: resumed.destination,
          }),
          result.cookies
        )
      },
    },
  },
})

function LoginPage() {
  const { ui, error, notice, returnTo, oauthQuery } = Route.useLoaderData()
  const t = getCatalog(ui.locale)

  return (
    <AuthShell ui={ui} title={t.auth.signIn.title}>
      <FormAlert variant="default">{messageForNoticeCode(notice, t)}</FormAlert>
      <FormAlert>{messageForErrorCode(error, t)}</FormAlert>

      <form method="post" className="grid gap-4">
        {returnTo ? (
          <input type="hidden" name="returnTo" value={returnTo} />
        ) : null}
        {oauthQuery ? (
          <input type="hidden" name={OAUTH_QUERY_FIELD} value={oauthQuery} />
        ) : null}

        <TextField
          name="email"
          type="email"
          inputMode="email"
          label={t.common.email}
          autoComplete="username"
          autoFocus
        />
        <PasswordField
          name="password"
          label={t.common.password}
          autoComplete="current-password"
          showLabel={t.common.showPassword}
          hideLabel={t.common.hidePassword}
        />

        <Button type="submit" className="w-full">
          {t.auth.signIn.submit}
        </Button>
      </form>

      {/* FR-MAIL-2: with no transport there is nothing "forgot password" could do. */}
      {ui.emailEnabled ? (
        <p className="mt-4 text-sm">
          <Link
            to={APP_ROUTES.forgotPassword}
            className="text-muted-foreground underline underline-offset-4"
          >
            {t.auth.signIn.forgotPassword}
          </Link>
        </p>
      ) : null}

      <SocialButtons
        ui={ui}
        label={t.auth.signIn.socialDivider}
        withProvider={t.auth.signIn.withProvider}
      />

      {/* FR-SIGNUP-1: with sign-up off the link does not exist, and neither does the page. */}
      {ui.signUpEnabled ? (
        <p className="mt-6 text-sm text-muted-foreground">
          {t.auth.signIn.noAccount}{" "}
          <Link to={APP_ROUTES.signup} className="underline underline-offset-4">
            {t.common.signUp}
          </Link>
        </p>
      ) : null}
    </AuthShell>
  )
}

function SocialButtons({
  ui,
  label,
  withProvider,
}: {
  ui: UiContext
  label: string
  withProvider: (provider: string) => string
}) {
  if (ui.socialProviders.length === 0) return null

  return (
    <>
      <div className="my-6 flex items-center gap-3">
        <Separator className="flex-1" />
        <span className="text-xs text-muted-foreground">{label}</span>
        <Separator className="flex-1" />
      </div>
      <div className="grid gap-2">
        {ui.socialProviders.map((provider) => (
          // A GET form rather than a link: the callback URL is fixed by the
          // server, and the provider id is the only thing the browser chooses.
          <form
            key={provider.id}
            method="post"
            action={`${ui.basePath}/api/auth/sign-in/social`}
          >
            <input type="hidden" name="provider" value={provider.id} />
            <Button type="submit" variant="outline" className="w-full">
              {withProvider(provider.label)}
            </Button>
          </form>
        ))}
      </div>
    </>
  )
}
