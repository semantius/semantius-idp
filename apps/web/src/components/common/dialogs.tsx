import { useState } from "react"
import type { ReactNode } from "react"

import { Check, Copy } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@workspace/ui/components/dialog"

import type { Catalog } from "@/server/i18n"

/**
 * The two dialogs this application needs, and nothing else.
 *
 * **Forms inside dialogs stay plain `<form method="post">`.** The dialog is
 * chrome: it decides what is on screen, never how a submission travels. So the
 * POST → 303 → notice pattern is exactly what it was when the same form was
 * inline, and a page full of six actions is still six ordinary form posts —
 * which is why none of the server handlers below them changed.
 *
 * Requiring JavaScript for the *chrome* is allowed (D31) and is the whole
 * trade: an admin page with a dozen inline forms is unreadable, and the
 * alternative — a page per action — is a navigation for something that is one
 * field and a button.
 */

/**
 * A button that opens a dialog with something in it.
 *
 * The trigger is rendered as the house `<Button>` through Base UI's `render`
 * prop, so it is the same control it would have been inline — same variants,
 * same focus ring, same accessible name.
 */
export function ActionDialog({
  label,
  title,
  description,
  variant = "outline",
  size = "sm",
  className,
  defaultOpen,
  children,
}: {
  /** The trigger's text, and the dialog's accessible name when no title is given. */
  label: string
  title?: string
  description?: ReactNode
  variant?: "default" | "outline" | "ghost" | "destructive" | "secondary"
  size?: "default" | "sm" | "lg"
  className?: string
  /**
   * Open on first paint. What a rejected submission needs (**D62**): the
   * refusal and the restored fields are both inside the dialog, so a page that
   * came back with an error and a draft has to reopen it or neither is
   * visible. Uncontrolled, so closing it works exactly as it always did.
   */
  defaultOpen?: boolean
  children: ReactNode
}) {
  return (
    <Dialog defaultOpen={defaultOpen}>
      <DialogTrigger
        render={<Button variant={variant} size={size} className={className} />}
      >
        {label}
      </DialogTrigger>
      {/* The registry popup is `fixed top-1/2 -translate-y-1/2` with no
          max-height and no overflow, so a form taller than the viewport hangs
          off both ends of it with nothing to scroll — and its submit button
          becomes unclickable, which is how the client-create dialog broke the
          moment it grew two checkboxes and a second textarea. Capped and made
          scrollable here rather than in `packages/ui`, which is registry
          output and would lose the change on the next `shadcn add`. */}
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title ?? label}</DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : null}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  )
}

/**
 * A value that exists exactly once, shown exactly once.
 *
 * An API key, a client secret, a set-password link: each is minted by a POST
 * and has to reach the browser that made it, and **none of them may travel in
 * the URL**. `server/http/one-shot.ts` says why at length — a query string
 * survives in history, in `Referer` and in every proxy log between here and
 * the user — so the redirect carries an opaque handle, the loader claims it,
 * and what lands on screen is this.
 *
 * Opened by default and closable, because there is nothing to come back to: a
 * claim consumes the stash, so a refresh shows the page without it. That is
 * intended, and the description says so.
 */
export function SecretDialog({
  t,
  title,
  description,
  value,
}: {
  t: Catalog
  title: string
  description?: ReactNode
  value: string
}) {
  return (
    <Dialog defaultOpen>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : null}
        </DialogHeader>

        {/* `min-w-0` on the row, not only on the `<code>` inside it. The row
            is a grid item of the dialog body, and a grid item's default
            `min-width: auto` refuses to shrink below its content — so an
            unbreakable `whitespace-pre` secret pushed the row wider than the
            popup and carried the copy button off the right-hand edge with it
            (owner review round 2, finding 5). */}
        <div className="flex min-w-0 items-start gap-2">
          {/* **Always wrapped.** There used to be a `wrap` prop, off by
              default, on the argument that a key should not be broken across
              lines by accident — which assumed the value is read or selected
              by hand. It is not: it is copied with the button beside it, and
              the copy takes the value rather than a selection. What the
              default actually bought was a horizontally scrolling box showing
              the first third of a forty-character API key, with the rest
              somewhere to the right (owner review round 3, finding 6). All
              three call sites wanted it wrapped, and two of them said so. */}
          <code
            data-slot="one-shot-value"
            className="min-w-0 flex-1 rounded-lg bg-muted p-3 font-mono text-xs break-all"
          >
            {value}
          </code>
          <CopyButton t={t} value={value} />
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            {t.common.close}
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Copies a value to the clipboard and says so for a moment.
 *
 * `navigator.clipboard` can be absent (an insecure origin that is not
 * localhost) and can reject (permission denied). Neither is worth an error
 * message: the value is on screen and selectable, so a copy that did not
 * happen leaves the user exactly where they already were.
 */
function CopyButton({ t, value }: { t: Catalog; value: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      aria-label={copied ? t.common.copied : t.common.copy}
      onClick={() => {
        // Typed as always present and genuinely is not: an insecure origin
        // that is not localhost has no `navigator.clipboard` at all.
        const clipboard = navigator.clipboard as Clipboard | undefined
        if (!clipboard) return
        void clipboard
          .writeText(value)
          .then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
          })
          .catch(() => undefined)
      }}
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
    </Button>
  )
}
