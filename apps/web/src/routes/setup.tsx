import { createFileRoute, redirect } from "@tanstack/react-router"

import { Button } from "@workspace/ui/components/button"

import { AuthShell } from "@/components/auth/auth-shell"
import {
  FormAlert,
  PasswordField,
  TextField,
} from "@/components/auth/form-parts"
import { messageForErrorCode } from "@/lib/auth-errors"
import { searchString } from "@/lib/search-params"
import { getCatalog } from "@/server/i18n"
import { createFirstUser, isSetupPending } from "@/server/admin/first-user"
import { createDb } from "@/server/db/client"
import {
  callAuth,
  readForm,
  redirectWithCookies,
  withError,
} from "@/server/http/auth-proxy"
import { resolveSignInDestination } from "@/server/http/post-login"
import { consume } from "@/server/http/rate-limit"
import { currentRequest } from "@/server/http/request-log"
import { APP_ROUTES } from "@/server/oidc/base-path"
import { getRuntime } from "@/server/runtime"
import { fetchSetupPending } from "@/server/functions/setup"

/**
 * `/setup` — the first-run wizard (FR-ADMIN-1, **D52**).
 *
 * **While the `user` table is empty, this is the deployment.** `/` and `/login`
 * both redirect here, and whoever fills the form in becomes the first
 * administrator. There is no bootstrap password in an environment file, no
 * forced change afterwards, and nothing to unset — which is the point: the
 * variables this replaces are what caused the credentials incident on record.
 *
 * The page closes for good the moment a user exists. Not "the moment an admin
 * exists": a deployment that lost its last administrator must not be able to
 * mint a new one from an unauthenticated page, so recovery is another admin,
 * the reset e-mail, or the SQL promotion documented in the runbooks.
 *
 * `signUp.enabled`, `signUp.requireApproval` and `signUp.allowedEmailDomains`
 * do not apply here. This is not a registration — it is the act of configuring
 * the deployment, and the person doing it is the operator.
 */
export const Route = createFileRoute("/setup")({
  loader: async ({ context, location }) => {
    // Not a 404 like `/signup`: someone who bookmarked this after finishing
    // setup should land somewhere useful rather than on an error.
    if (!(await fetchSetupPending())) {
      throw redirect({ to: APP_ROUTES.login })
    }

    const search = location.search as Record<string, unknown>
    return { ui: context.ui, error: searchString(search.error) }
  },
  component: SetupPage,
  server: {
    handlers: {
      POST: async ({ request }) => {
        const runtime = await getRuntime()
        const base = runtime.config.base.basePath
        const here = `${base}${APP_ROUTES.setup}`
        const login = `${base}${APP_ROUTES.login}`

        // Cheap pre-check on the pooled connection. The authoritative one is
        // inside the advisory lock in `createFirstUser`; this only keeps a
        // late POST from doing any work.
        if (!(await isSetupPending(runtime.database))) {
          return redirectWithCookies(`${login}?notice=already_setup`)
        }

        // SEC-2, D37: the only unauthenticated write on the deployment while
        // it is in this state, so it gets the same table-backed limiter every
        // other credential endpoint uses.
        if (runtime.config.file.rateLimit.enabled) {
          const bucket = currentRequest()?.ipAddress ?? "unknown"
          const decision = await consume(
            { database: runtime.database, logger: runtime.logger },
            `setup:${bucket}`,
            SETUP_RULE
          )
          if (!decision.allowed) {
            return redirectWithCookies(withError(here, "rate_limited"))
          }
        }

        const form = await readForm(request)
        const email = (form.email ?? "").toLowerCase()
        const password = form.password ?? ""
        const policy = runtime.config.file.auth.password

        if (!EMAIL_SHAPE.test(email)) {
          return redirectWithCookies(withError(here, "invalid_email"))
        }
        if (
          password.length < policy.minLength ||
          password.length > policy.maxLength
        ) {
          return redirectWithCookies(withError(here, "password_length"))
        }

        // A direct, non-pooled handle for the advisory lock: a session lock
        // does not hold through a transaction pooler (D27), and the runtime's
        // own locking handle is closed once start-up finishes.
        //
        // **Two connections, not one.** `withAdvisoryLock` reserves one for the
        // whole critical section, and the empty-table re-check inside it runs
        // on this same handle — with `max: 1` that second query waits for a
        // connection the lock is holding, which is a deadlock against itself
        // and reads as a timeout. `runtime.ts` uses 2 for the same reason.
        const locking = createDb(runtime.config, { direct: true, max: 2 })
        let created: Awaited<ReturnType<typeof createFirstUser>>
        try {
          created = await createFirstUser(
            {
              config: runtime.config,
              database: runtime.database,
              locking,
              auth: runtime.auth,
              audit: runtime.audit,
              logger: runtime.logger,
            },
            {
              email,
              firstName: form.firstName ?? "",
              lastName: form.lastName ?? "",
              password,
            }
          )
        } catch (error) {
          runtime.logger.error("first-run setup failed", {
            error: error instanceof Error ? error.message : String(error),
          })
          return redirectWithCookies(withError(here, "server_error"))
        } finally {
          await locking.close().catch(() => undefined)
        }

        // Lost the race against another submission. Neutral on purpose — the
        // deployment is set up, which is all the loser needs to know.
        if (!created.created) {
          return redirectWithCookies(`${login}?notice=already_setup`)
        }

        // Signed in through the ordinary endpoint rather than by minting a
        // session here, so the gate chain, the audit trail and the cookie
        // attributes are all the ones every other sign-in gets.
        const signedIn = await callAuth(
          runtime,
          "/sign-in/email",
          { email, password },
          request
        )
        if (!signedIn.ok) {
          // The account exists; only the automatic sign-in did not. Sending
          // them to the login page with it is a better answer than an error.
          return redirectWithCookies(`${login}?notice=account_created`)
        }

        return redirectWithCookies(
          resolveSignInDestination({ config: runtime.config }),
          signedIn.cookies
        )
      },
    },
  },
})

/**
 * Ten attempts an hour, per caller.
 *
 * Keyed on the address the edge resolved (`server.trustProxy` decides what that
 * is), like every other bucket here. Wider than a sign-in limit because a first
 * run is genuinely fiddly — a rejected password, a typo in the address — and
 * narrow enough that the deployment's one unauthenticated account-creating
 * endpoint cannot be hammered while it is open.
 */
const SETUP_RULE = { window: 3600, max: 10 } as const

/**
 * Shape only. The address is not verified and does not need to be: the person
 * filling this in is standing at the deployment they just started, and
 * `emailVerified` is set for exactly that reason.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function SetupPage() {
  const { ui, error } = Route.useLoaderData()
  const t = getCatalog(ui.locale)

  return (
    <AuthShell
      ui={ui}
      title={t.setup.title}
      description={<p>{t.setup.description}</p>}
      width="md"
    >
      <FormAlert>{messageForErrorCode(error, t)}</FormAlert>

      <form method="post" className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            name="firstName"
            label={t.common.firstName}
            autoComplete="given-name"
            required={false}
            autoFocus
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
          {t.setup.submit}
        </Button>
      </form>

      <p className="mt-6 text-sm text-muted-foreground">{t.setup.footnote}</p>
    </AuthShell>
  )
}
