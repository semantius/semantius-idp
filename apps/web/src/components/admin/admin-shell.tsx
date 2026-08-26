import type { ReactNode } from "react"

import { Link } from "@tanstack/react-router"

import { buttonVariants } from "@workspace/ui/components/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { cn } from "@workspace/ui/lib/utils"

import { PendingForm, SubmitButton } from "@/components/common/pending-form"

import type { Catalog } from "@/server/i18n"
import type { UiContext } from "@/server/ui-context"

/**
 * The frame `/admin/*` shares (FR-ADMIN-2).
 *
 * Wider than `AccountShell` and with its own navigation, because these are
 * tables rather than forms — but the same construction: server-rendered, a
 * real `<nav>` with `aria-current`, no client-side state to get out of step
 * with the URL.
 *
 * The impersonation banner is deliberately duplicated from `AccountShell`
 * rather than shared: FR-ADMIN-5 wants it on *every* page an impersonated
 * session can reach, and the two shells are the two ways to reach one. A
 * shared component would be one import away from being dropped by a future
 * refactor of either.
 *
 * The header carries the way back out — the administrator's own account, and
 * sign out. Without them `/admin` was a room with no door: every page linked
 * to the other admin pages and to nothing else, so the only way to reach
 * `/account` was to type it.
 */

export interface AdminNavItem {
  to: string
  label: string
}

export function adminNavItems(t: Catalog): AdminNavItem[] {
  return [
    { to: "/admin", label: t.admin.nav.dashboard },
    { to: "/admin/users", label: t.admin.nav.users },
    { to: "/admin/clients", label: t.admin.nav.clients },
    { to: "/admin/roles", label: t.admin.nav.roles },
    { to: "/admin/audit", label: t.admin.nav.audit },
    { to: "/admin/system", label: t.admin.nav.system },
  ]
}

export function AdminShell({
  ui,
  t,
  title,
  description,
  impersonated,
  actions,
  children,
}: {
  ui: UiContext
  t: Catalog
  title: string
  description?: ReactNode
  impersonated?: boolean
  /** Buttons that belong beside the heading rather than in the body. */
  actions?: ReactNode
  children: ReactNode
}) {
  const items = adminNavItems(t)

  return (
    <div className="min-h-svh bg-muted/30">
      {impersonated ? (
        <p
          role="status"
          className="text-destructive-foreground bg-destructive px-4 py-2 text-center text-sm font-medium"
        >
          {t.account.impersonationBanner}
        </p>
      ) : null}

      <div className="mx-auto w-full max-w-6xl px-4 py-10">
        <header className="mb-8 flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <p className="text-sm text-muted-foreground">{ui.siteName}</p>
            <h1 className="text-2xl font-semibold tracking-tight">
              {t.admin.title}
            </h1>
          </div>
          <div className="flex flex-wrap items-baseline gap-4">
            <nav aria-label={t.admin.title} className="flex flex-wrap gap-1">
              {items.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  // `exact` on the overview only: every other entry should stay
                  // highlighted while a child page (a user's detail) is open.
                  activeOptions={{ exact: item.to === "/admin" }}
                  activeProps={{
                    "aria-current": "page",
                    className: "bg-background shadow-sm",
                  }}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm font-medium",
                    "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {item.label}
                </Link>
              ))}
            </nav>

            {/* Three affordances in one row read as three different kinds of
                control. The nav entries are pill tabs, so the two escapes
                beside them are ghost buttons at the same size rather than
                underlined links (owner review round 2, finding 6). */}
            <div className="flex items-center gap-1">
              {/* A plain anchor rather than a `<Link>`: `/account` is outside
                  this route's subtree, and the two shells are separate trees. */}
              <a
                href={`${ui.basePath}/account`}
                className={buttonVariants({ variant: "ghost", size: "sm" })}
              >
                {t.account.title}
              </a>
              <PendingForm
                method="post"
                action={`${ui.basePath}/logout`}
                busy={t.common.loading}
              >
                <SubmitButton variant="ghost" size="sm">
                  {t.common.signOut}
                </SubmitButton>
              </PendingForm>
            </div>
          </div>
        </header>

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
      </div>
    </div>
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
