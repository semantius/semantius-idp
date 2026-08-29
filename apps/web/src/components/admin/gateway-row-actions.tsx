import { useId, useState } from "react"

import { MoreHorizontal } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"

import { ActionDialog } from "@/components/common/dialogs"
import { GatewayEditDialog } from "@/components/admin/gateway-edit-dialog"
import { PendingForm, SubmitButton } from "@/components/common/pending-form"
import type { AdminGatewayRow } from "@/server/functions/admin"
import type { Draft } from "@/server/http/draft"
import type { Catalog } from "@/server/i18n"

/** Which of the row's dialogs is on screen, if any. */
type OpenDialog = "edit" | "remove" | null

/**
 * Everything that can be done to one gateway, behind one control (FR-GW-7,
 * **D91**).
 *
 * Built on `ClientRowActions`, and the three mechanics that file documents are
 * load-bearing here too: the dialogs are controlled from one piece of state
 * because a `menuitem` has ceased to exist by the time its dialog should
 * appear; a refused edit reopens itself by seeding that state; and
 * Enable/Disable stays a real form post whose `<form>` lives in the row rather
 * than in the portalled popup.
 *
 * The trigger's accessible name **names the gateway**, because there is one of
 * these per row.
 */
export function GatewayRowActions({
  t,
  gateway,
  draft,
  error,
}: {
  t: Catalog
  gateway: AdminGatewayRow
  /** The refused edit, claimed by the loader — only if it was this row's. */
  draft?: Draft
  /** The refusal that came back with it. */
  error?: string
}) {
  const [open, setOpen] = useState<OpenDialog>(draft ? "edit" : null)
  // The form is submitted from a control outside it, and `form=` takes an id,
  // so this one has to be unique in the document rather than in the row.
  const toggleForm = useId()
  const close = () => {
    setOpen(null)
  }

  return (
    <>
      {/* Outside the menu on purpose: the menu closing must not unmount the
          form mid-submission. */}
      <PendingForm id={toggleForm} busy={t.common.loading} method="post">
        <input type="hidden" name="action" value="toggle" />
        <input type="hidden" name="name" value={gateway.name} />
        {gateway.enabled ? (
          <input type="hidden" name="disabled" value="on" />
        ) : null}
      </PendingForm>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t.admin.gateways.actionsFor(gateway.name)}
            />
          }
        >
          <MoreHorizontal aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-auto min-w-44">
          <DropdownMenuGroup>
            <DropdownMenuItem
              onClick={() => {
                setOpen("edit")
              }}
            >
              {t.admin.gateways.edit}
            </DropdownMenuItem>
            <DropdownMenuItem
              render={<button type="submit" form={toggleForm} />}
            >
              {gateway.enabled
                ? t.admin.gateways.disable
                : t.admin.gateways.enable}
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem
              variant="destructive"
              onClick={() => {
                setOpen("remove")
              }}
            >
              {t.admin.gateways.remove}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <GatewayEditDialog
        t={t}
        gateway={gateway}
        draft={draft}
        open={open === "edit"}
        onOpenChange={(next) => {
          if (!next) close()
        }}
        error={error}
      />

      <ActionDialog
        label={t.admin.gateways.remove}
        description={t.admin.gateways.removeConfirm}
        open={open === "remove"}
        onOpenChange={(next) => {
          if (!next) close()
        }}
      >
        <PendingForm
          busy={t.common.loading}
          method="post"
          className="grid gap-4"
        >
          <input type="hidden" name="action" value="delete" />
          <input type="hidden" name="name" value={gateway.name} />
          <SubmitButton variant="destructive">
            {t.admin.gateways.remove}
          </SubmitButton>
        </PendingForm>
      </ActionDialog>
    </>
  )
}
