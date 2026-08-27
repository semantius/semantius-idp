import { ActionDialog } from "@/components/common/dialogs"
import { FormAlert } from "@/components/auth/form-parts"
import { PendingForm, SubmitButton } from "@/components/common/pending-form"
import {
  ClientFormFields,
  resolveClientFormValues,
  useClientForm,
} from "@/components/admin/client-form-fields"
import type { AdminClientRow } from "@/server/functions/admin"
import type { Draft } from "@/server/http/draft"
import type { Catalog } from "@/server/i18n"
import type { UiContext } from "@/server/ui-context"

/**
 * "Edit" for an application registered here (**D72**, FR-OIDC-2, FR-ADMIN-2).
 *
 * A dialog on the list, per **D64**: an action is a dialog on the page that
 * lists what it acts on, never a route of its own. One is rendered per
 * database-managed row, which is why every field id in `ClientFormFields` is
 * generated — a hard-coded `id="name"` would be on as many controls as there
 * are applications.
 *
 * The fields are prefilled **draft-first, then from the row**: a refused edit
 * comes back with what was typed (D62), and an untouched dialog shows what is
 * stored. Both matter, because `/idp/update-client` is a full replace — the
 * dialog's field set *is* the writable surface, so an unprefilled field is a
 * field that gets cleared by saving.
 *
 * `requireConsent` is the inversion of the stored `skipConsent`, and it is
 * inverted **only here on the way in and in `skipConsentFromForm` on the way
 * out**. Two inversions in two places is how a triple negative gets shipped.
 *
 * The client id is shown and not editable: it is the natural key that `token`,
 * `oauth_consent`, `oauth_client_resource` and the audit trail all reference,
 * so changing it is removing this application and adding a different one.
 */
export function ClientEditDialog({
  ui,
  t,
  client,
  draft,
  reopen,
  error,
}: {
  ui: UiContext
  t: Catalog
  client: AdminClientRow
  /** The refused submission, claimed by the loader — only if it was this row's. */
  draft?: Draft
  reopen?: boolean
  /** The refusal, rendered inside the dialog, for the reason `ClientCreateDialog` gives. */
  error?: string
}) {
  const { onSubmit, errors } = useClientForm()
  const values = resolveClientFormValues(draft, {
    name: client.name,
    clientId: client.clientId,
    type: client.type,
    redirectUris: client.redirectUris.join("\n"),
    postLogoutRedirectUris: client.postLogoutRedirectUris.join("\n"),
    scopes: [...client.scopes],
    requireConsent: !client.skipConsent,
    enableEndSession: client.enableEndSession,
  })

  return (
    <ActionDialog
      label={t.admin.clients.edit}
      title={t.admin.clients.editTitle}
      description={t.admin.clients.editHelp}
      variant="outline"
      size="sm"
      defaultOpen={reopen}
    >
      <PendingForm
        busy={t.common.loading}
        method="post"
        className="grid gap-4"
        onSubmit={onSubmit}
      >
        <input type="hidden" name="action" value="update" />
        <FormAlert>{error}</FormAlert>
        <ClientFormFields
          ui={ui}
          t={t}
          values={values}
          errors={errors}
          fixedClientId
        />
        <SubmitButton>{t.common.save}</SubmitButton>
      </PendingForm>
    </ActionDialog>
  )
}
