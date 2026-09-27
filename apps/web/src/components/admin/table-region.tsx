import type { ReactNode } from "react"

import { Card } from "@workspace/ui/components/card"

/**
 * The Card an admin list's table sits in: one scroll region, named, that a
 * keyboard can reach.
 *
 * The tables overflow sideways by design — the clients list pins its actions
 * column for exactly that — and a region that scrolls with nothing focusable
 * inside cannot be scrolled without a pointer (WCAG 2.1.1; axe's
 * `scrollable-region-focusable`). Whether anything focusable is inside depends
 * on the rows: a clients list of file clients has no link and no menu, a
 * roles or audit table has none at all. So the region takes the tab stop
 * itself, always, and the arrow keys scroll it.
 *
 * **Two scrollers become one.** The registry's `Table` wraps itself in a
 * `table-container` that is `overflow-x-auto` too, and that inner one is what
 * actually scrolled — out of reach, because its props cannot be set without
 * editing registry output. `[&_…]` compiles to (0,2,0), which beats its
 * `overflow-x-auto`, so it is flattened and this Card, which is ours, is the
 * region. `sticky left-0` cells pin against whichever ancestor scrolls, so
 * they are unaffected.
 *
 * `label` is the page's own title: the region is the list the page is about,
 * and a second name for it would be a second thing to keep in the catalog.
 */
export function TableRegion({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <Card
      tabIndex={0}
      role="region"
      aria-label={label}
      className="overflow-x-auto py-0 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_[data-slot=table-container]]:overflow-visible"
    >
      {children}
    </Card>
  )
}
