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
import { ClientEditDialog } from "@/components/admin/client-edit-dialog"
import { PendingForm, SubmitButton } from "@/components/common/pending-form"
import type { AdminClientRow } from "@/server/functions/admin"
import type { Draft } from "@/server/http/draft"
import type { Catalog } from "@/server/i18n"
import type { UiContext } from "@/server/ui-context"

/** Which of the row's dialogs is on screen, if any. */
type OpenDialog = "edit" | "rotate" | "remove" | null

/**
 * Everything that can be done to one registered application, behind one
 * control (**D80**, FR-OIDC-2, FR-ADMIN-2).
 *
 * The four actions **D50** and **D72** added were rendered inline, wrapped
 * under the Enabled/Disabled badge in the Status column — so a table whose
 * other six columns are one line each had a row four buttons tall, and a
 * column headed "Status" whose contents were mostly not status. Reported by
 * the owner as "showing actions below Status is ugly".
 *
 * Three things about the mechanism are load-bearing, and each is a way to get
 * a menu-plus-dialog wrong:
 *
 * 1. **The dialogs are controlled, and there is one piece of state for all of
 *    them.** A `menuitem` closes its popup when it is activated, so the
 *    trigger a `DialogTrigger` would need has ceased to exist by the moment
 *    the dialog should appear — `ActionDialog`'s uncontrolled form cannot work
 *    from inside a menu. One `OpenDialog` value rather than three booleans
 *    also makes "never two of these at once" true by construction.
 *
 * 2. **A refused edit still reopens itself** (**D62**, **D72**). That used to
 *    be `defaultOpen`, which is meaningless without a trigger; the same fact
 *    seeds this state instead, so a rejected save comes back with the fields
 *    restored and the refusal inside the dialog exactly as before.
 *
 * 3. **Enable/Disable stays a real form post**, and the form lives in the row
 *    rather than in the popup. The menu item is its submitter by `form=`, so
 *    the form is never unmounted by the menu closing underneath its own
 *    submission — which is what nesting the `<form>` inside the portalled
 *    popup would risk. `PendingForm` keeps the double-submit guard; the
 *    spinner it would otherwise show is moot, because the menu is gone by
 *    then.
 *
 * The trigger's accessible name **names the application** rather than saying
 * "Actions", because there is one of these per row: an unnamed one would give
 * a screen-reader user a list of identical controls, and Playwright's strict
 * mode a locator that matches every row.
 */
export function ClientRowActions({
  ui,
  t,
  client,
  draft,
  error,
}: {
  ui: UiContext
  t: Catalog
  client: AdminClientRow
  /** The refused edit, claimed by the loader — only if it was this row's. */
  draft?: Draft
  /** The refusal that came back with it. */
  error?: string
}) {
  const [open, setOpen] = useState<OpenDialog>(draft ? "edit" : null)
  // The form is submitted from a control that is not inside it (mechanic 3),
  // and `form=` takes an id, so this one has to be unique in the document
  // rather than merely in the row.
  const toggleForm = useId()
  const close = () => {
    setOpen(null)
  }

  return (
    <>
      {/* Outside the menu on purpose. See mechanic 3. It holds nothing but
          hidden inputs and `PendingForm`'s own `sr-only` live region, so it
          is a zero-height block and is deliberately not `hidden` — that would
          take the live region with it. */}
      <PendingForm id={toggleForm} busy={t.common.loading} method="post">
        <input type="hidden" name="action" value="toggle" />
        <input type="hidden" name="clientId" value={client.clientId} />
        {client.disabled ? null : (
          <input type="hidden" name="disabled" value="on" />
        )}
      </PendingForm>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t.admin.clients.actionsFor(client.name)}
            />
          }
        >
          <MoreHorizontal aria-hidden="true" />
        </DropdownMenuTrigger>
        {/* `w-auto`: the registry's default is `w-(--anchor-width)`, which is
            the width of the anchor — and the anchor here is a 28-pixel icon
            button. `align="start"` because the trigger sits in the table's
            leftmost, pinned column: `end` aligned the popup's right edge to a
            28-pixel button at the card's left boundary, so the menu hung out
            over the page margin instead of the table. */}
        <DropdownMenuContent align="start" className="w-auto min-w-44">
          <DropdownMenuGroup>
            <DropdownMenuItem
              onClick={() => {
                setOpen("edit")
              }}
            >
              {t.admin.clients.edit}
            </DropdownMenuItem>
            {/* Only where there is a secret to replace. A public client
                authenticates with PKCE, and the endpoint refuses it rather
                than quietly minting one (**D72**); the type field and the
                table say so, so the absence is explained rather than bare
                (**D78**). */}
            {client.isPublic ? null : (
              <DropdownMenuItem
                onClick={() => {
                  setOpen("rotate")
                }}
              >
                {t.admin.clients.rotateSecret}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              render={<button type="submit" form={toggleForm} />}
            >
              {client.disabled
                ? t.admin.clients.enable
                : t.admin.clients.disable}
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
              {t.admin.clients.remove}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <ClientEditDialog
        ui={ui}
        t={t}
        client={client}
        draft={draft}
        open={open === "edit"}
        onOpenChange={(next) => {
          if (!next) close()
        }}
        error={error}
      />

      {client.isPublic ? null : (
        <ActionDialog
          label={t.admin.clients.rotateSecret}
          description={t.admin.clients.rotateConfirm}
          open={open === "rotate"}
          onOpenChange={(next) => {
            if (!next) close()
          }}
        >
          <PendingForm busy={t.common.loading} method="post" className="grid gap-4">
            <input type="hidden" name="action" value="rotate-secret" />
            <input type="hidden" name="clientId" value={client.clientId} />
            <SubmitButton>{t.admin.clients.rotateSecret}</SubmitButton>
          </PendingForm>
        </ActionDialog>
      )}

      <ActionDialog
        label={t.admin.clients.remove}
        description={t.admin.clients.removeConfirm}
        open={open === "remove"}
        onOpenChange={(next) => {
          if (!next) close()
        }}
      >
        <PendingForm busy={t.common.loading} method="post" className="grid gap-4">
          <input type="hidden" name="action" value="delete" />
          <input type="hidden" name="clientId" value={client.clientId} />
          <SubmitButton variant="destructive">
            {t.admin.clients.remove}
          </SubmitButton>
        </PendingForm>
      </ActionDialog>
    </>
  )
}
