import type { ReactNode } from "react"

import {
  AppWindow,
  Database,
  LayoutDashboard,
  ScrollText,
  Settings2,
  ShieldCheck,
  Users,
  Waypoints,
} from "lucide-react"

import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { cn } from "@workspace/ui/lib/utils"

import { PageHeader } from "@/components/common/page-header"
import type { ShellNavItem } from "@/components/common/sidebar-layout"

import type { Catalog } from "@/server/i18n"
import type { UiContext } from "@/server/ui-context"

/**
 * The page header `/admin/*` shares (FR-ADMIN-2).
 *
 * Everything around the page — the navigation, the way back out, the sign-out,
 * the impersonation banner — moved up into `routes/admin.tsx`'s `SidebarLayout`
 * in **D82**. What is left here is the part that is genuinely per page: its
 * own heading, its description, and the buttons that belong beside the heading
 * rather than in the body, all of which are `PageHeader` since **D93**.
 *
 * **The heading is an `<h1>` now.** The area's name used to be the chrome's
 * `<h1>` and this the `<h2>` under it; the breadcrumb took that row, and
 * "Administration" was never what a document is about anyway.
 *
 * `adminNavItems` stays here, beside the pages it names, and now carries a
 * lucide icon per entry — the collapsed sidebar is an icon rail, so an entry
 * without one would be a blank button.
 *
 * It takes the `UiContext` too, in the shape `accountNavItems` already uses:
 * with `admin.database` at `disabled` the page 404s (FR-ADMIN-7), so a link to
 * it would be a link to a dead end.
 */

export function adminNavItems(ui: UiContext, t: Catalog): ShellNavItem[] {
  return [
    // `exact` on the overview only: every other entry stays lit while a child
    // page (a user's detail) is open.
    {
      to: "/admin",
      label: t.admin.nav.dashboard,
      icon: LayoutDashboard,
      exact: true,
    },
    { to: "/admin/users", label: t.admin.nav.users, icon: Users },
    { to: "/admin/clients", label: t.admin.nav.clients, icon: AppWindow },
    { to: "/admin/gateways", label: t.admin.nav.gateways, icon: Waypoints },
    { to: "/admin/roles", label: t.admin.nav.roles, icon: ShieldCheck },
    { to: "/admin/audit", label: t.admin.nav.audit, icon: ScrollText },
    ...(ui.adminDatabaseEnabled
      ? [
          {
            to: "/admin/database",
            label: t.admin.nav.database,
            icon: Database,
          },
        ]
      : []),
    { to: "/admin/system", label: t.admin.nav.system, icon: Settings2 },
  ]
}

export function AdminShell({
  title,
  description,
  wideDescription,
  actions,
  fill,
  children,
}: {
  title: string
  description?: ReactNode
  /**
   * Drop the `max-w-2xl` measure from the description (**D87**).
   *
   * The cap is right for a paragraph — 65-odd characters is where prose stops
   * being comfortable to read — and wrong for a page whose body is a
   * full-width console: `/admin/database`'s two sentences wrapped onto a
   * second line while the panel beneath them was twice as wide, which reads
   * as a paragraph rather than as the subtitle it is. Shortening the sentence
   * was the alternative and it costs the half that says every run is audited.
   */
  wideDescription?: boolean
  /** Buttons that belong beside the heading rather than in the body. */
  actions?: ReactNode
  /**
   * The page owns the rest of the viewport instead of growing with its
   * content (**D87**).
   *
   * `SidebarLayout` pins the shell to `h-svh` and hands this section's parent
   * `flex-1`, so a `flex-1 min-h-0` section here is exactly the height left
   * below the header — which is what lets a pane inside it scroll rather than
   * the document. **A definite height is the requirement, not a minimum**:
   * see the note on that class, which cost a broken page to learn. `min-h-0`
   * is the other load-bearing half — a flex item defaults to
   * `min-height: auto`, so without it a tall result grid pushes the section
   * past the viewport instead of scrolling inside.
   */
  fill?: boolean
  children: ReactNode
}) {
  return (
    <section className={cn(fill && "flex min-h-0 flex-1 flex-col")}>
      <PageHeader
        title={title}
        description={description}
        wideDescription={wideDescription}
        actions={actions}
        fill={fill}
      />
      {children}
    </section>
  )
}

/**
 * A titled panel — the one card shape every admin page uses.
 *
 * Replaces both a local `Section` helper on the detail page and eleven
 * hand-rolled `rounded-lg border bg-card p-4` divs, which had drifted apart in
 * padding and in whether the heading sat inside the panel or above it. The
 * heading is a real `<h3>`: the axe pass and several e2e selectors go through
 * heading roles, so the element cannot become a styled `<div>`.
 */
export function AdminCard({
  title,
  description,
  action,
  className,
  children,
}: {
  title?: ReactNode
  description?: ReactNode
  /** Rendered top-right, in the header's own grid column. */
  action?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <Card className={className}>
      {title ? (
        <CardHeader>
          {/* A real `<h3>` inside `CardTitle`, not instead of it: `CardTitle`
              is a plain registry `<div>` with no `render` prop, and Tailwind's
              preflight makes headings inherit size and weight, so nesting
              costs nothing visually and keeps the heading role that axe and
              several e2e selectors rely on. */}
          <CardTitle>
            <h3>{title}</h3>
          </CardTitle>
          {description ? (
            <CardDescription>{description}</CardDescription>
          ) : null}
          {action ? <CardAction>{action}</CardAction> : null}
        </CardHeader>
      ) : null}
      <CardContent>{children}</CardContent>
    </Card>
  )
}

/** A labelled number, for the dashboard. */
export function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: number | string
  tone?: "default" | "warning"
}) {
  return (
    <Card size="sm">
      <CardContent>
        <p className="text-sm text-muted-foreground">{label}</p>
        <p
          className={cn(
            "mt-1 text-2xl font-semibold tabular-nums",
            tone === "warning" && value !== 0 ? "text-destructive" : undefined
          )}
        >
          {value}
        </p>
      </CardContent>
    </Card>
  )
}

/**
 * A definition row, used by the detail and system pages.
 *
 * Named `DetailRow` and not `Field`, which is what it used to be called: the
 * kit has a `Field` of its own for form groups, and two things with that name
 * in one file is how a `<dt>/<dd>` pair ends up wrapping an `<input>`.
 */
export function DetailRow({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="grid gap-0.5 py-2 sm:grid-cols-[14rem_1fr] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm break-words">{children}</dd>
    </div>
  )
}
