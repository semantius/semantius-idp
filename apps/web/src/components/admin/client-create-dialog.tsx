import { ActionDialog } from "@/components/common/dialogs"
import { FormAlert } from "@/components/auth/form-parts"
import { PendingForm, SubmitButton } from "@/components/common/pending-form"
import {
  ClientFormFields,
  resolveClientFormValues,
  useClientForm,
} from "@/components/admin/client-form-fields"
import type { Draft } from "@/server/http/draft"
import type { Catalog } from "@/server/i18n"
import type { UiContext } from "@/server/ui-context"

/**
 * "Add an application" (FR-OIDC-2, **D50**, **D62**).
 *
 * Lifted out of `routes/admin/clients.tsx` when it grew validation and draft
 * restoration: the route is a table with five POST actions, and this is a
 * twelve-field form with rules of its own. The fields themselves moved on
 * again in **D72**, into `client-form-fields.tsx`, because the edit dialog
 * describes the same row and `/idp/update-client` is a full replace — a field
 * one form has and the other does not is a field every edit resets.
 *
 * Two halves of the same finding, and they meet here:
 *
 * - **Everything the browser can decide, it decides.** The rules are
 *   `lib/client-rules.ts`, shared with the zod schema that validates
 *   `oauth_clients.jsonc`, so the form refuses exactly what the server would —
 *   inline, against the field, without a round trip. The server check is
 *   untouched; this is the earlier of two gates.
 * - **What does reach the server survives its refusal.** A duplicate client
 *   id, a file-managed collision or a lost race comes back as
 *   `?error=…&draft=<handle>`; the loader claims the draft and the fields
 *   arrive here as `defaultValue`s with the dialog reopened.
 */
export function ClientCreateDialog({
  ui,
  t,
  draft,
  reopen,
  error,
}: {
  ui: UiContext
  t: Catalog
  /** The refused submission, claimed by the loader. */
  draft?: Draft
  /** Open on first paint — a refusal happened and its message is in here. */
  reopen?: boolean
  /**
   * The refusal, rendered *inside* the dialog. A modal covers the page, so an
   * alert left behind it is an alert nobody reads — which is how the reopened
   * dialog would otherwise come back with the fields restored and no
   * explanation.
   */
  error?: string
}) {
  const { onSubmit, errors } = useClientForm()
  const values = resolveClientFormValues(draft, {
    name: "",
    clientId: "",
    type: "spa",
    redirectUris: "",
    postLogoutRedirectUris: "",
    // Every scope this deployment allows, ticked: an operator adding an
    // application is describing what it may ask for, and starting from none
    // means a client that can request nothing.
    scopes: [...ui.oauthScopes],
    requireConsent: false,
    enableEndSession: false,
  })

  return (
    <ActionDialog
      label={t.admin.clients.add}
      description={t.admin.clients.addHelp}
      variant="default"
      size="default"
      defaultOpen={reopen}
    >
      <PendingForm
        busy={t.common.loading}
        method="post"
        className="grid gap-4"
        onSubmit={onSubmit}
      >
        <input type="hidden" name="action" value="create" />
        <FormAlert>{error}</FormAlert>
        <ClientFormFields ui={ui} t={t} values={values} errors={errors} />
        <SubmitButton>{t.admin.clients.add}</SubmitButton>
      </PendingForm>
    </ActionDialog>
  )
}
