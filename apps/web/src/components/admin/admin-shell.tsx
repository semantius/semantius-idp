import type { ReactNode } from "react"

import {
  AppWindow,
  LayoutDashboard,
  ScrollText,
  Settings2,
  ShieldCheck,
  Users,
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

import type { ShellNavItem } from "@/components/common/sidebar-layout"

import type { Catalog } from "@/server/i18n"

/**
 * The page header `/admin/*` shares (FR-ADMIN-2).
 *
 * Everything around the page — the navigation, the way back out, the sign-out,
 * the impersonation banner — moved up into `routes/admin.tsx`'s `SidebarLayout`
 * in **D82**. What is left here is the part that is genuinely per page: its
 * own heading, its description, and the buttons that belong beside the heading
 * rather than in the body. The area's `<h1>` is the layout's; this is the
 * `<h2>` beneath it, which is what it always rendered.
 *
 * `adminNavItems` stays here, beside the pages it names, and now carries a
 * lucide icon per entry — the collapsed sidebar is an icon rail, so an entry
 * without one would be a blank button.
 */

export function adminNavItems(t: Catalog): ShellNavItem[] {
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
    { to: "/admin/roles", label: t.admin.nav.roles, icon: ShieldCheck },
    { to: "/admin/audit", label: t.admin.nav.audit, icon: ScrollText },
    { to: "/admin/system", label: t.admin.nav.system, icon: Settings2 },
  ]
}

export function AdminShell({
  title,
  description,
  actions,
  children,
}: {
  title: string
  description?: ReactNode
  /** Buttons that belong beside the heading rather than in the body. */
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
          {description ? (
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? <div className="flex gap-2">{actions}</div> : null}
      </div>
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
