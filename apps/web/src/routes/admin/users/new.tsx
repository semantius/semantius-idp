import { Link, createFileRoute } from "@tanstack/react-router"

import { buttonVariants } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Field, FieldLabel } from "@workspace/ui/components/field"

import { AdminCard, AdminShell } from "@/components/admin/admin-shell"
import { RoleCheckboxes } from "@/components/admin/role-checkboxes"
import { FormRefusal } from "@/components/auth/form-parts"
import { crumbTrail } from "@/components/common/breadcrumbs"
import { ClaimedParams } from "@/components/common/claimed-params"
import { GuardedForm } from "@/components/common/guarded-form"
import { SubmitButton } from "@/components/common/pending-form"
import { SUBJECT_PARAM } from "@/components/common/notice-toast"
import { messageForErrorCode } from "@/lib/auth-errors"
import { adminHead } from "@/lib/page-title"
import { searchString } from "@/lib/search-params"
import { claimAdminDraft, fetchRoles } from "@/server/functions/admin"
import { getCatalog } from "@/server/i18n"
import { createResetLink } from "@/server/auth/reset-link"
import { displayName } from "@/server/display-name"
import {
  adminErrorCodeFor,
  callAuth,
  readFormMulti,
  redirectWithCookies,
  withError,
} from "@/server/http/auth-proxy"
import { stashDraft, withDraft } from "@/server/http/draft"
import { stash } from "@/server/http/one-shot"
import { requireSession } from "@/server/http/require-session"
import { getRuntime } from "@/server/runtime"

const HERE = "/admin/users/new"
const LIST = "/admin/users"

/** Both are claimed by the loader, so neither may outlive this render. */
const CONSUMED = ["error", "draft"] as const

/**
 * "Create a user", as a page again (**D93**, FR-ADMIN-2, FR-SIGNUP-5).
 *
 * This address existed before **D64** moved the form into a dialog on the
 * list, and D64's actual finding is untouched by bringing it back: the defect
 * was that *one action had two outcomes on two surfaces* — a page that could
 * only send you back to the list, while the other outcome of the same action,
 * the one-time set-password link, opened as a dialog there. Both outcomes
 * still land on the list. What D64 over-generalized was the conclusion, "an
 * action is a dialog on the page that lists what it acts on, never a route of
 * its own", and D93 replaces the test: **size is not the test — the test is
 * whether there is one address to look at, link to and bookmark.** D64's other
 * half, the default role arriving ticked, is not reversed and is below.
 *
 * The POST is D64's, moved and otherwise unchanged. Created **approved and
 * confirmed**: an administrator typing the address is the vouching the
 * approval queue and the verification e-mail exist to obtain, and making them
 * approve their own creation would be a step that teaches people to click
 * through steps.
 *
 * The password is never chosen here. With e-mail on they get a `setPassword`
 * link; with e-mail off (FR-MAIL-2) the same one-time link is handed over on
 * screen *once*, because a server that cannot send mail still has to be able
 * to onboard somebody — and an administrator typing a password into a form is
 * a password that exists in two heads and a browser history. The link is
 * stashed server-side and the redirect carries a handle.
 */
export const Route = createFileRoute("/admin/users/new")({
  loader: async ({ context, location }) => {
    const search = location.search as Record<string, unknown>
    return {
      ui: context.ui,
      crumbs: crumbTrail(context.ui, (t) => [
        { label: t.admin.nav.users, to: LIST },
        { label: t.admin.create.title, to: HERE },
      ]),
      roles: (await fetchRoles()) ?? [],
      error: searchString(search.error),
      draft:
        (await claimAdminDraft({ data: searchString(search.draft) ?? "" })) ??
        undefined,
    }
  },
  head: ({ loaderData }) =>
    adminHead(loaderData?.ui, (t) => t.admin.create.title),
  component: NewUserPage,
  server: {
    handlers: {
      POST: async ({ request }) => {
        const runtime = await getRuntime()
        const base = runtime.config.base.basePath
        const here = `${base}${HERE}`
        const list = `${base}${LIST}`

        // Roles are checkboxes, so the field repeats; `readForm` keeps only
        // the last value of a repeated key, which would silently drop every
        // role but one. Read before the gate (D63), so a session that went
        // stale while the form was open does not cost it.
        const { fields: form, list: valuesOf } = await readFormMulti(request)
        const email = (form.email ?? "").trim()
        const firstName = form.firstName ?? ""
        const lastName = form.lastName ?? ""
        const roles = valuesOf("roles")
        const submitted = {
          email: form.email,
          firstName: form.firstName,
          lastName: form.lastName,
          roles,
        }

        const signedIn = await requireSession(runtime, request, HERE)
        if (!signedIn.ok) return signedIn.response

        /**
         * Back to the list, saying which account it is about (**D78**).
         *
         * The address travels as a **one-shot handle**, not as itself:
         * `safeUrlForLog` keeps the query string of every path outside
         * `/oauth2/*` and `/api/auth/*`, so `?subject=jane@example.com` would
         * write the address into the request log of a codebase that
         * anonymizes IP addresses for exactly that reason (SEC-5). Two
         * minutes is a redirect's worth of life, and the claim consumes it.
         */
        const landOnList = async (notice: string) =>
          redirectWithCookies(
            `${list}?notice=${notice}&${SUBJECT_PARAM}=${await stash(
              runtime,
              email,
              { ttlSeconds: 120 }
            )}`
          )

        const created = await callAuth(
          runtime,
          "/admin/create-user",
          {
            email,
            // D49: derived from the parts, never typed. FR-SIGNUP-5 asks for
            // first and last name everywhere an account is made, and this was
            // the one place still asking for a single free-text `name`.
            name:
              displayName(
                firstName,
                lastName,
                runtime.config.file.site.nameFormat
              ) || email,
            // A random password nobody will ever use: the account is reached
            // through the set-password link, and a null password would make it
            // a social-only account, which is not what was asked for.
            password: crypto.randomUUID() + crypto.randomUUID(),
            ...(roles.length ? { role: roles } : {}),
            data: {
              status: "active",
              emailVerified: true,
              ...(firstName ? { firstName } : {}),
              ...(lastName ? { lastName } : {}),
            },
          },
          request
        )
        if (!created.ok) {
          const draft = await stashDraft(runtime, submitted)
          return redirectWithCookies(
            withError(withDraft(here, draft), adminErrorCodeFor(created))
          )
        }

        const user = created.body.user as { id?: string } | undefined
        // The `user.created` row is the guard's, written from its hook on
        // `/admin/create-user` so that a direct API call leaves the same trail
        // (**D66**).

        // **D70**: everything from here on runs *after the account exists*, so
        // nothing below may throw its way to an error page. It did: an
        // unhandled failure in the link tail produced a 500, the
        // administrator's natural response was to submit the same form again,
        // and the second attempt met the duplicate refusal — which, unmapped,
        // said the e-mail and password combination was wrong. One field
        // report, two bugs, and this is the half that manufactures the retry.
        // The recovery is named rather than implied: both ways to give this
        // account a password live on its own page.
        if (typeof user?.id !== "string" || user.id === "") {
          // Better Auth answered `ok` without a user id. Nothing sensible can
          // be minted from `""` — the old code did, and produced a link that
          // resolved to no account at all.
          runtime.logger.error("create-user succeeded without a user id", {
            email,
          })
          return landOnList("createdLinkFailed")
        }

        try {
          // `welcome=1`: the same page, told to say "an administrator created
          // an account for you" rather than "choose a new password", and to
          // leave out the promise about other devices (D65).
          const reset = await createResetLink(runtime, user.id, {
            welcome: true,
          })

          if (runtime.mailer.enabled) {
            await runtime.mailer.send("setPassword", email, { url: reset.url })
            return landOnList("created")
          }

          // FR-MAIL-2: nothing can be sent, so the link is handed over on
          // screen — once, in a dialog on the list, and never in the address
          // bar.
          const handle = await stash(
            runtime,
            JSON.stringify({ url: reset.url, email }),
            { ttlSeconds: 600 }
          )
          return redirectWithCookies(`${list}?created=${handle}`)
        } catch (error) {
          runtime.logger.error(
            "created the account but not its set-password link",
            {
              email,
              userId: user.id,
              error: error instanceof Error ? error.message : String(error),
            }
          )
          return landOnList("createdLinkFailed")
        }
      },
    },
  },
})

function NewUserPage() {
  const { ui, roles, error, draft } = Route.useLoaderData()
  const t = getCatalog(ui.locale)
  const values = draft ?? {}
  const restored = Object.keys(values).length > 0
  // **D64**'s second half, and it is not reversed. `roles.jsonc`'s
  // `default: true` is what a self-registration gets and what the server falls
  // back to when the form sends no role at all — so an unticked box was never
  // "no roles", it was "the default, silently".
  const checked = restored
    ? values.roles?.split("\n").filter((role) => role !== "")
    : roles.filter((role) => role.isDefault).map((role) => role.name)

  return (
    <AdminShell
      title={t.admin.create.title}
      description={t.admin.create.description}
    >
      <ClaimedParams names={CONSUMED} />
      <FormRefusal>
        {messageForErrorCode(error, t, ui.passwordMinLength)}
      </FormRefusal>

      <GuardedForm
        t={t}
        busy={t.common.loading}
        method="post"
        className="grid max-w-3xl gap-6"
      >
        <AdminCard className="gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="firstName">{t.common.firstName}</FieldLabel>
              <Input
                id="firstName"
                name="firstName"
                autoComplete="off"
                defaultValue={values.firstName}
                // **D93**: the first field of a *create* page only. On an edit
                // it would scroll a prefilled form to wherever the first
                // control happens to be.
                autoFocus
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="lastName">{t.common.lastName}</FieldLabel>
              <Input
                id="lastName"
                name="lastName"
                autoComplete="off"
                defaultValue={values.lastName}
              />
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="email">{t.admin.create.email}</FieldLabel>
            <Input
              id="email"
              name="email"
              type="email"
              required
              defaultValue={values.email}
            />
          </Field>
          <RoleCheckboxes
            roles={roles}
            legend={t.admin.create.roles}
            checked={checked}
          />
        </AdminCard>
        <div className="flex flex-wrap justify-end gap-2">
          <Link
            to="/admin/users"
            className={buttonVariants({ variant: "outline" })}
          >
            {t.common.cancel}
          </Link>
          <SubmitButton>{t.admin.create.submit}</SubmitButton>
        </div>
      </GuardedForm>
    </AdminShell>
  )
}
