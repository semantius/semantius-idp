import { ActionDialog } from "@/components/common/dialogs"
import { FormAlert } from "@/components/auth/form-parts"
import { PendingForm, SubmitButton } from "@/components/common/pending-form"
import {
  GatewayFormFields,
  resolveGatewayFormValues,
  useGatewayForm,
} from "@/components/admin/gateway-form-fields"
import type { AdminGatewayRow } from "@/server/functions/admin"
import type { Draft } from "@/server/http/draft"
import type { Catalog } from "@/server/i18n"

/**
 * "Edit" for a gateway added here (FR-GW-7, **D91**).
 *
 * A dialog on the list, per **D64**: an action is a dialog on the page that
 * lists what it acts on, never a route of its own. One is rendered per
 * manual row, which is why every field id in `GatewayFormFields` is generated.
 *
 * The fields are prefilled **draft-first, then from the row**: a refused edit
 * comes back with what was typed (D62), and an untouched dialog shows what is
 * stored. Both matter, because `/idp/update-gateway` is a full replace.
 *
 * The name is shown and not editable: it is the URL segment every caller has
 * already configured, so changing it is removing this gateway and adding a
 * different one.
 */
export function GatewayEditDialog({
  t,
  gateway,
  draft,
  open,
  onOpenChange,
  error,
}: {
  t: Catalog
  gateway: AdminGatewayRow
  /** The refused submission, claimed by the loader — only if it was this row's. */
  draft?: Draft
  /** Controlled by the row's actions menu (**D80**), which owns one piece of
   * state for all of its dialogs. */
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The refusal, rendered inside the dialog. */
  error?: string
}) {
  const { onSubmit, errors } = useGatewayForm()
  const values = resolveGatewayFormValues(draft, {
    name: gateway.name,
    url: gateway.url,
    requireAuth: gateway.requireAuth,
    trustProxy: gateway.trustProxy,
  })

  return (
    <ActionDialog
      label={t.admin.gateways.edit}
      title={t.admin.gateways.editTitle}
      description={t.admin.gateways.editHelp}
      open={open}
      onOpenChange={onOpenChange}
    >
      <PendingForm
        busy={t.common.loading}
        method="post"
        className="grid gap-4"
        onSubmit={onSubmit}
      >
        <input type="hidden" name="action" value="update" />
        <FormAlert>{error}</FormAlert>
        <GatewayFormFields t={t} values={values} errors={errors} fixedName />
        <SubmitButton>{t.admin.actions.save}</SubmitButton>
      </PendingForm>
    </ActionDialog>
  )
}
