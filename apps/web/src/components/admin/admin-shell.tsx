import type { ReactNode } from "react"

import { Link } from "@tanstack/react-router"

import { cn } from "@workspace/ui/lib/utils"

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
    <div className="rounded-lg border bg-card p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-1 text-2xl font-semibold tabular-nums",
          tone === "warning" && value !== 0 ? "text-destructive" : undefined
        )}
      >
        {value}
      </p>
    </div>
  )
}

/** A definition row, used by the detail and system pages. */
export function Field({
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
