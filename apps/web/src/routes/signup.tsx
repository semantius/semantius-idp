import { createFileRoute, Link, notFound } from "@tanstack/react-router"

import { AuthShell } from "@/components/auth/auth-shell"
import {
  FormAlert,
  PasswordField,
  TextField,
} from "@/components/auth/form-parts"
import { messageForErrorCode } from "@/lib/auth-errors"
import { searchString } from "@/lib/search-params"
import { getCatalog } from "@/server/i18n"
import {
  callAuth,
  errorCodeFor,
  readForm,
  redirectWithCookies,
  withError,
} from "@/server/http/auth-proxy"
import { consume } from "@/server/http/rate-limit"
import {
  DUPLICATE_NOTICE_RULE,
  duplicateNoticeBucket,
  signUpCreatedNothing,
} from "@/server/auth/sign-up-outcome"
import { displayName } from "@/server/display-name"
import { APP_ROUTES } from "@/server/oidc/base-path"
import { getRuntime } from "@/server/runtime"
import type { Runtime } from "@/server/runtime"
import { PendingForm, SubmitButton } from "@/components/common/pending-form"

/**
 * `/signup` — self-registration.
 *
 * **404 when `signUp.enabled` is false**, not a disabled form: the requirement
 * is that the page does not exist, so an invite-only deployment gives a curious
 * visitor nothing to work with.
 *
 * Where the new account lands depends on configuration, and the page says which
 * before the user commits: approval pending, confirm your address, or straight in.
 *
 * **With e-mail on, an address that already has an account lands on the same
 * page, and its owner is told**. Better Auth 1.7.1 answers
 * that sign-up with a generic success — see `auth/sign-up-outcome.ts` for
 * how the page tells the two apart — so the *shape* was already uniform; what
 * was missing was the "someone tried to register with your address" notice to
 * the existing owner and an honest audit row (`signup.duplicate`). Without
 * e-mail there is no owner to tell and no verification step to hide behind,
 * so the page **refuses** with `signup_failed` — the message of which is
 * "Account created." either way — and SECURITY.md says so.
 */
export const Route = createFileRoute("/signup")({
  loader: ({ context, location }) => {
    if (!context.ui.signUpEnabled) throw notFound()

    const search = location.search as Record<string, unknown>
    return {
      ui: context.ui,
      error: searchString(search.error),
    }
  },
  component: SignUpPage,
  server: {
    handlers: {
      POST: async ({ request }) => {
        const runtime = await getRuntime()
        const base = runtime.config.base.basePath

        if (!runtime.config.file.signUp.enabled) {
          // the endpoint is as absent as the page.
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
            // derived from the parts, in `site.nameFormat`
            // order. The database hook composes the same fallback; sending it
            // here keeps Better Auth's own validation happy.
            name:
              displayName(
                firstName,
                lastName,
                runtime.config.file.site.nameFormat
              ) ||
              (form.email ?? ""),
            ...(firstName ? { firstName } : {}),
            ...(lastName ? { lastName } : {}),
          },
          request
        )

        if (!result.ok) {
          return redirectWithCookies(withError(here, errorCodeFor(result)))
        }

        if (await signUpCreatedNothing(runtime.database, result.body)) {
          // Better Auth has already run every validation a new
          // address would meet, hashed the password for timing parity and
          // answered 200 for a user it did not write. The trail gets the
          // truth; the caller gets what a new address gets, or — without an
          // owner to tell — the refusal.
          const email = String(
            (result.body.user as { email?: unknown } | undefined)?.email ??
              form.email ??
              ""
          )
          await runtime.audit.record({
            action: "signup.duplicate",
            outcome: "denied",
            actorType: "anonymous",
            userAgent: request.headers.get("user-agent"),
            // The address is the whole event, and it is one the trail already
            // carries for the account it names.
            metadata: { email },
          })
          if (!runtime.config.emailEnabled) {
            return redirectWithCookies(withError(here, "signup_failed"))
          }
          await notifyExistingOwner(runtime, email)
          // No cookie either way: the success path below has never replayed
          // Better Auth's, and there is none on the generic answer.
          return redirectWithCookies(landingAfterSignUp(runtime, form.email))
        }

        return redirectWithCookies(landingAfterSignUp(runtime, form.email))
      },
    },
  },
})

/**
 * The notice to the existing owner, at most once an hour per address
 *: a notice per attempt would make the feature a way to fill an
 * inbox from this deployment's sender. Same dev switch as `/setup`'s bucket.
 */
async function notifyExistingOwner(runtime: Runtime, email: string) {
  if (runtime.config.file.rateLimit.enabled) {
    const decision = await consume(
      { database: runtime.database, logger: runtime.logger },
      duplicateNoticeBucket(email),
      DUPLICATE_NOTICE_RULE
    )
    if (!decision.allowed) return
  }
  await runtime.mailer.send("signUpExistingAccount", email)
}

/**
 * Where a registration lands, as one function so a taken address and a new
 * one cannot drift apart.
 *
 * approval comes after verification, so the page the user lands
 * on is whichever gate is actually next.
 */
function landingAfterSignUp(runtime: Runtime, email: string | undefined): string {
  const base = runtime.config.base.basePath
  if (runtime.config.file.signUp.requireApproval) {
    return `${base}${APP_ROUTES.pendingApproval}`
  }
  if (runtime.config.requireEmailVerification) {
    return `${base}${APP_ROUTES.verifyEmail}?sent=1&email=${encodeURIComponent(email ?? "")}`
  }
  return `${base}${APP_ROUTES.login}?notice=account_created`
}

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
      <FormAlert>
        {messageForErrorCode(error, t, ui.passwordMinLength)}
      </FormAlert>

      <PendingForm busy={t.common.loading} method="post" className="grid gap-4">
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

        <SubmitButton className="w-full">{t.auth.signUp.submit}</SubmitButton>
      </PendingForm>

      <p className="mt-6 text-sm text-muted-foreground">
        {t.auth.signUp.haveAccount}{" "}
        <Link to={APP_ROUTES.login} className="underline underline-offset-4">
          {t.common.signIn}
        </Link>
      </p>
    </AuthShell>
  )
}
