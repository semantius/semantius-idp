import { Link, createFileRoute, notFound } from "@tanstack/react-router"

import { buttonVariants } from "@workspace/ui/components/button"
import { Checkbox } from "@workspace/ui/components/checkbox"
import { Input } from "@workspace/ui/components/input"
import { Field, FieldDescription, FieldLabel } from "@workspace/ui/components/field"
import { Label } from "@workspace/ui/components/label"

import { AdminCard, AdminShell } from "@/components/admin/admin-shell"
import { RoleCheckboxes } from "@/components/admin/role-checkboxes"
import { FormRefusal } from "@/components/auth/form-parts"
import { crumbTrail } from "@/components/common/breadcrumbs"
import { ClaimedParams } from "@/components/common/claimed-params"
import { GuardedForm } from "@/components/common/guarded-form"
import { SubmitButton } from "@/components/common/pending-form"
import { messageForErrorCode } from "@/lib/auth-errors"
import { adminHead } from "@/lib/page-title"
import { searchString } from "@/lib/search-params"
import {
  claimAdminDraft,
  fetchRoles,
  fetchUserDetail,
} from "@/server/functions/admin"
import { getCatalog } from "@/server/i18n"
import { runAdminAction } from "@/server/http/admin-actions"
import {
  readFormMulti,
  redirectWithCookies,
  withError,
} from "@/server/http/auth-proxy"
import { stashDraft, withDraft } from "@/server/http/draft"
import { requireSession } from "@/server/http/require-session"
import { getRuntime } from "@/server/runtime"

const LIST = "/admin/users"

/** Both are claimed by the loader, so neither may outlive this render. */
const CONSUMED = ["error", "draft"] as const

/**
 * "Edit the account" — **one form with one Save** (**D93**, FR-ADMIN-2,
 * FR-ROLE-2, **D49**).
 *
 * The profile and the roles were two dialogs with two Saves on the detail
 * page, and that is the arrangement this replaces rather than reproduces. An
 * administrator who corrected an address *and* granted a role, then pressed
 * the Profile save, got "Profile updated." in a toast and lost the role grant
 * with no signal at all: silently, on the authorization surface, confirmed by
 * a success message. Two Saves for two halves of one record is the defect.
 *
 * **The composition is the handler's, not a new server action.** It calls
 * `runAdminAction("edit-profile", …)` and then `runAdminAction("set-roles",
 * …)` and composes the two outcomes — which is what **D70** is the pattern
 * *for*: "wrap the tail, log it, and land … with a notice that names the
 * recovery". A profile refusal has written nothing, so it comes back here with
 * the draft; a roles refusal *after* the profile was written lands on the
 * record with a sentence saying exactly which half succeeded.
 *
 * **`/account/security` is not a precedent for splitting them.** Its sections
 * are four unrelated *actions* — change password, change e-mail, sessions,
 * second factor — not two halves of one record.
 *
 * **The roles fieldset is disabled on your own account**, and so is the
 * `set-roles` call. FR-ADMIN-3 refuses it server-side too
 * (`admin_cannot_change_own_roles`, `admin/invariants.ts`), which is why the
 * call has to be *skipped* rather than merely hidden: a disabled fieldset
 * submits nothing, so dispatching it anyway would ask the server to set the
 * empty role list and be refused — turning every self-edit of a first name
 * into a partial failure. The profile half still saves.
 */
export const Route = createFileRoute("/admin/users/$userId/edit")({
  loader: async ({ context, params, location }) => {
    const user = await fetchUserDetail({ data: params.userId })
    if (!user) throw notFound()
    const search = location.search as Record<string, unknown>
    return {
      ui: context.ui,
      gate: context.gate,
      // The trail ends at the account and the `<h1>` names the operation, so
      // nothing is said twice (**D93**).
      crumbs: crumbTrail(context.ui, (t) => [
        { label: t.admin.nav.users, to: LIST },
        { label: user.email },
      ]),
      user,
      roles: (await fetchRoles()) ?? [],
      error: searchString(search.error),
      draft:
        (await claimAdminDraft({ data: searchString(search.draft) ?? "" })) ??
        undefined,
    }
  },
  head: ({ loaderData }) =>
    adminHead(loaderData?.ui, (t) => t.admin.users.editTitle),
  component: EditUserPage,
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const runtime = await getRuntime()
        const base = runtime.config.base.basePath
        const userId = params.userId
        const record = `${base}/admin/users/${encodeURIComponent(userId)}`
        const here = `${record}/edit`

        // Read before the gate (**D63**, **D81**), and `readFormMulti`
        // because the roles control repeats its field.
        const { fields: form, list: valuesOf } = await readFormMulti(request)

        const signedIn = await requireSession(runtime, request, here)
        if (!signedIn.ok) return signedIn.response

        const shared = {
          runtime,
          request,
          form,
          list: valuesOf,
          userId,
          actorId: signedIn.session.user.id,
        }

        const profile = await runAdminAction("edit-profile", shared)
        if (profile.error) {
          // Nothing has been written, so this is an ordinary refusal: back to
          // the form, with what was typed (**D62**). The roles come with it,
          // because they are part of the same submission.
          const draft = await stashDraft(runtime, {
            firstName: form.firstName,
            lastName: form.lastName,
            email: form.email,
            emailVerified: form.emailVerified,
            roles: valuesOf("roles"),
          })
          return redirectWithCookies(
            withError(withDraft(here, draft), profile.error)
          )
        }

        // Skipped on your own account: the fieldset is disabled, so the body
        // carries no roles at all, and FR-ADMIN-3 would refuse the write
        // anyway. See the note at the top of the file.
        if (signedIn.session.user.id === userId) {
          return redirectWithCookies(`${record}?notice=accountSaved`)
        }

        const roles = await runAdminAction("set-roles", shared)
        if (roles.error) {
          // **D70**: the profile is already written, so this must not throw
          // its way to an error page and must not look like a clean failure
          // either. Both halves are reported — the notice says which one
          // succeeded and where to finish, the error says why the other did
          // not.
          runtime.logger.error("saved the profile but not the roles", {
            userId,
            error: roles.error,
          })
          return redirectWithCookies(
            `${record}?notice=accountSavedRolesFailed&error=${roles.error}`
          )
        }

        return redirectWithCookies(`${record}?notice=accountSaved`)
      },
    },
  },
})

function EditUserPage() {
  const { ui, gate, user, roles, error, draft } = Route.useLoaderData()
  const t = getCatalog(ui.locale)
  const self = gate.admin && gate.email === user.email
  const values = draft ?? {}
  const restored = Object.keys(values).length > 0
  const checked = restored
    ? (values.roles?.split("\n").filter((role) => role !== "") ?? [])
    : user.roles

  return (
    <AdminShell
      title={t.admin.users.editTitle}
      description={t.admin.users.editHelp}
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
        <AdminCard
          title={t.admin.actions.editProfile}
          description={t.admin.actions.editProfileHelp}
          className="gap-4"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="firstName">{t.common.firstName}</FieldLabel>
              <Input
                id="firstName"
                name="firstName"
                autoComplete="off"
                defaultValue={values.firstName ?? user.firstName}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="lastName">{t.common.lastName}</FieldLabel>
              <Input
                id="lastName"
                name="lastName"
                autoComplete="off"
                defaultValue={values.lastName ?? user.lastName}
              />
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="email">{t.common.email}</FieldLabel>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="off"
              defaultValue={values.email ?? user.email}
            />
          </Field>
          <Label className="group/field-label flex items-center gap-2 text-sm font-normal">
            {/* See `role-checkboxes.tsx`: Base UI's control is a span, so the
                wrapping label does not name it. */}
            <Checkbox
              name="emailVerified"
              aria-label={t.admin.actions.emailVerifiedLabel}
              defaultChecked={
                restored
                  ? values.emailVerified === "on"
                  : user.emailVerified
              }
            />
            {t.admin.actions.emailVerifiedLabel}
          </Label>
        </AdminCard>

        <AdminCard
          title={t.admin.actions.setRoles}
          description={t.admin.actions.setRolesHelp}
          className="gap-4"
        >
          {/* **D93**: the guard is on the *roles*, not on the Save button.
              There is one Save now, and disabling it would stop an
              administrator fixing their own name as well as their own roles —
              which is not what FR-ADMIN-3 refuses. `RoleCheckboxes` puts
              `disabled` on each control as well as on its fieldset, because
              the control is a `role="checkbox"` span that a disabled fieldset
              does not reach. */}
          <RoleCheckboxes
            roles={roles}
            legend={t.admin.actions.setRoles}
            checked={checked}
            disabled={self}
          />
          {self ? (
            <FieldDescription>{t.admin.actions.setRolesSelf}</FieldDescription>
          ) : null}
        </AdminCard>

        <div className="flex flex-wrap justify-end gap-2">
          <Link
            to="/admin/users/$userId"
            params={{ userId: user.id }}
            className={buttonVariants({ variant: "outline" })}
          >
            {t.common.cancel}
          </Link>
          <SubmitButton>{t.admin.actions.save}</SubmitButton>
        </div>
      </GuardedForm>
    </AdminShell>
  )
}
