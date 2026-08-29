import { ActionDialog } from "@/components/common/dialogs"
import { FormAlert } from "@/components/auth/form-parts"
import { PendingForm, SubmitButton } from "@/components/common/pending-form"
import {
  GatewayFormFields,
  resolveGatewayFormValues,
  useGatewayForm,
} from "@/components/admin/gateway-form-fields"
import type { Draft } from "@/server/http/draft"
import type { Catalog } from "@/server/i18n"

/**
 * "Add a gateway" (FR-GW-7, **D91**).
 *
 * The same two halves as `ClientCreateDialog`, and for the same reasons
 * (**D62**): everything the browser can decide it decides, from the rules in
 * `lib/gateway-rules.ts` that the zod schema also calls — so the form refuses
 * exactly what `config.jsonc` would, inline, without a round trip. What does
 * reach the server survives its refusal: a duplicate name or a lost race comes
 * back as `?error=…&draft=<handle>`, and the dialog reopens with what was
 * typed.
 */
export function GatewayCreateDialog({
  t,
  draft,
  reopen,
  error,
}: {
  t: Catalog
  /** The refused submission, claimed by the loader. */
  draft?: Draft
  /** Open on first paint — a refusal happened and its message is in here. */
  reopen?: boolean
  /**
   * The refusal, rendered *inside* the dialog. A modal covers the page, so an
   * alert left behind it is an alert nobody reads.
   */
  error?: string
}) {
  const { onSubmit, errors } = useGatewayForm()
  const values = resolveGatewayFormValues(draft, {
    name: "",
    url: "",
    // Off by default: PostgREST and the Neon Data API both have an anonymous
    // role, so anonymous reach is the ordinary case and `requireAuth` is the
    // exception an operator opts into (FR-GW-4).
    requireAuth: false,
  })

  return (
    <ActionDialog
      label={t.admin.gateways.add}
      description={t.admin.gateways.addHelp}
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
        <GatewayFormFields t={t} values={values} errors={errors} />
        <SubmitButton>{t.admin.gateways.add}</SubmitButton>
      </PendingForm>
    </ActionDialog>
  )
}
