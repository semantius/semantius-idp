import { useRef } from "react"
import type { ComponentProps } from "react"

import { useBlocker } from "@tanstack/react-router"

import { Button } from "@workspace/ui/components/button"

import { ActionDialog } from "@/components/common/dialogs"
import { PendingForm } from "@/components/common/pending-form"
import type { Catalog } from "@/server/i18n"

/**
 * A `PendingForm` that asks before its page is left with unsaved changes
 * (**D93**).
 *
 * Not theoretical, and not a new hazard invented by the modal-to-page move —
 * a *bigger* one. Escape already discarded a dialog, so nothing protected is
 * being lost; what changes is exposure. Since **D82** the sidebar is
 * permanently on screen with eight one-click destinations, D93 adds a
 * breadcrumb with two more, and Back now means something. The twelve-field
 * client form is exactly the content that hurts: a redirect-URI list is copied
 * out of another system, and **D62** built an entire one-shot draft stash so a
 * *server refusal* would not cost it. Losing the same form to a stray sidebar
 * click would be incoherent.
 *
 * Five things, each of which is a way to get this wrong:
 *
 * 1. **The dirty flag is a ref, not state.** `beforeunload` fires between the
 *    submit handler returning and the navigation, which is before React has
 *    re-rendered — so a `useState` cleared on submit is still `true` when the
 *    guard reads it, and every successful save asks whether you meant to leave.
 *    Same reasoning as `PendingForm`'s own `inFlight` ref. Nothing here needs a
 *    render, so there is no state at all.
 *
 * 2. **One `onInput` on the `<form>` is the whole of the tracking**, and it
 *    covers the checkboxes too — which is not obvious, because the control the
 *    user operates is a Base UI `role="checkbox"` span. Its click handler
 *    dispatches a real click on the hidden `<input type="checkbox">` behind it
 *    (`dispatchClickWithModifiers`), and a native click on a checkbox fires
 *    `input` and `change`, both of which bubble. A React state change on the
 *    hidden input would not have, which is what makes this worth writing down.
 *
 * 3. **`beforeunload` is the blocker's, not ours.** `useBlocker` takes
 *    `enableBeforeUnload`, and the listener behind it is registered by
 *    TanStack's own history whether or not anything blocks — so hand-rolling a
 *    second one would add a listener without removing the first, and the
 *    bfcache interaction with `PendingForm`'s `pageshow`/`persisted` reset is
 *    unchanged either way. It is a **function**, evaluated at event time,
 *    which is the only form that can read a ref.
 *
 * 4. **The flag is cleared on submit, and only when the submit is really
 *    going.** `useClientForm` and `useGatewayForm` `preventDefault()` a form
 *    that fails their own checks; clearing unconditionally would disarm the
 *    guard on a page that is still sitting there with the changes on it.
 *
 * 5. **`proceed()` must not be followed by `reset()`.** Both close the dialog,
 *    and closing it is also what `onOpenChange(false)` reports — so the
 *    Escape-means-stay path has to be able to tell itself apart from the
 *    discard path. A ref, set before `proceed`, is what does it.
 */
export function GuardedForm({
  t,
  onSubmit,
  onInput,
  children,
  ...props
}: ComponentProps<typeof PendingForm> & { t: Catalog }) {
  const dirty = useRef(false)
  const leaving = useRef(false)

  const blocker = useBlocker({
    shouldBlockFn: () => dirty.current,
    enableBeforeUnload: () => dirty.current,
    withResolver: true,
  })

  return (
    <>
      <PendingForm
        {...props}
        onInput={(event) => {
          dirty.current = true
          onInput?.(event)
        }}
        onSubmit={(event) => {
          onSubmit?.(event)
          if (!event.defaultPrevented) dirty.current = false
        }}
      >
        {children}
      </PendingForm>

      <ActionDialog
        label={t.common.unsaved.title}
        description={t.common.unsaved.description}
        open={blocker.status === "blocked"}
        onOpenChange={(next) => {
          if (next) return
          if (leaving.current) {
            // Cleared as it is read: a blocked navigation that does not
            // complete would otherwise leave the flag set, and the next
            // Escape would be taken for a discard.
            leaving.current = false
            return
          }
          blocker.reset?.()
        }}
      >
        {/* Stay first and Cancel-shaped: the dialog interrupts a navigation
            nobody asked to be interrupted, and the safe answer is the one the
            focus lands on. */}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => {
              blocker.reset?.()
            }}
          >
            {t.common.unsaved.stay}
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              leaving.current = true
              dirty.current = false
              blocker.proceed?.()
            }}
          >
            {t.common.unsaved.leave}
          </Button>
        </div>
      </ActionDialog>
    </>
  )
}
