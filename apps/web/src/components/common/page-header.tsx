import type { ReactNode } from "react"

import { cn } from "@workspace/ui/lib/utils"

/**
 * The page's own heading, its description and the buttons beside it
 * (**D93**).
 *
 * The area name used to be the chrome's `<h1>` and the page's name an `<h2>`
 * beneath it. The breadcrumb took the chrome's row, so the `<h1>` is the
 * page's now — which is also what it should always have been: "Administration"
 * is not what this document is about.
 *
 * Three details are load-bearing:
 *
 * - **`text-2xl`, not `text-3xl`.** The chrome breadcrumb already gives the
 *   page its identity, and 30 px bold plus a description costs
 *   `/admin/database`'s SQL runner about 40 px of the only definite height it
 *   has (**D87**).
 * - **`fill` keeps `shrink-0`.** `AdminShell` renders this inside
 *   `flex min-h-0 flex-1 flex-col` when a page fills the window; a header
 *   without it is a flex item that *shrinks*, so the heading compresses
 *   instead of the panes — the D87 failure mode, one level up.
 * - **`tabIndex={-1}`.** `SidebarLayout` focuses this on every route change,
 *   because since D93 an Edit is a `<Link>` inside a menu item: activating it
 *   unmounts the focused element, focus falls to `<body>`, and a screen reader
 *   announces nothing. `outline-none` because the focus is programmatic and a
 *   ring around a heading nobody clicked reads as a bug.
 */
export function PageHeader({
  title,
  description,
  wideDescription,
  actions,
  fill,
}: {
  title: string
  description?: ReactNode
  /** Drop the `max-w-2xl` measure — see `AdminShell` (**D87**). */
  wideDescription?: boolean
  /** Buttons that belong beside the heading rather than in the body. */
  actions?: ReactNode
  /** The page owns the rest of the viewport (**D87**). */
  fill?: boolean
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-3",
        fill ? "mb-4 shrink-0" : "mb-6"
      )}
    >
      <div className="min-w-0">
        <h1
          data-page-title=""
          tabIndex={-1}
          className="text-2xl font-semibold tracking-tight outline-none"
        >
          {title}
        </h1>
        {description ? (
          <p
            className={cn(
              "mt-1 text-sm text-muted-foreground",
              wideDescription ? undefined : "max-w-2xl"
            )}
          >
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex gap-2">{actions}</div> : null}
    </div>
  )
}
