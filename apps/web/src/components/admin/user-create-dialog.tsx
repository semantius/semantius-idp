import { Input } from "@workspace/ui/components/input"
import { Field, FieldLabel } from "@workspace/ui/components/field"

import { ActionDialog } from "@/components/common/dialogs"
import { RoleCheckboxes } from "@/components/admin/role-checkboxes"
import { PendingForm, SubmitButton } from "@/components/common/pending-form"
import type { AdminRoleRow } from "@/server/functions/admin"
import type { Draft } from "@/server/http/draft"
import type { Catalog } from "@/server/i18n"

/**
 * "Add a user", as a dialog on the list (**D64**).
 *
 * It was `/admin/users/new`, a whole page whose only outcome was to send you
 * back to `/admin/users` — and the *other* outcome of the same action, the
 * one-time set-password link when e-mail is off, already opened as a dialog
 * there (FR-ADMIN-2). One action producing two outcomes on two different
 * surfaces is what the owner walked into; both of them live on the list now.
 *
 * The default role arrives ticked. `roles.jsonc`'s `default: true` is what a
 * self-registration gets and what the server falls back to when the form sends
 * no role at all — so an unticked box was never "no roles", it was "the
 * default, silently". Showing it is the honest version of behaviour that has
 * not changed.
 */
export function UserCreateDialog({
  t,
  roles,
  draft,
  reopen,
}: {
  t: Catalog
  roles: AdminRoleRow[]
  /** A refused submission, claimed by the loader (**D62**). */
  draft?: Draft
  reopen?: boolean
}) {
  const values: Draft = draft ?? {}
  const restored = Object.keys(values).length > 0
  const checked = restored
    ? values.roles?.split("\n").filter((role) => role !== "")
    : roles.filter((role) => role.isDefault).map((role) => role.name)

  return (
    <ActionDialog
      label={t.admin.users.create}
      title={t.admin.create.title}
      description={t.admin.create.description}
      variant="default"
      size="lg"
      defaultOpen={reopen}
    >
      <PendingForm busy={t.common.loading} method="post" className="grid gap-4">
        <input type="hidden" name="action" value="create" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="firstName">{t.common.firstName}</FieldLabel>
            <Input
              id="firstName"
              name="firstName"
              autoComplete="off"
              defaultValue={values.firstName}
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
        <SubmitButton>{t.admin.create.submit}</SubmitButton>
      </PendingForm>
    </ActionDialog>
  )
}
