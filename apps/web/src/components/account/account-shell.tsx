import type { ReactNode } from "react"

import { Link } from "@tanstack/react-router"

import { cn } from "@workspace/ui/lib/utils"

import type { Catalog } from "@/server/i18n"
import type { UiContext } from "@/server/ui-context"

/**
 * The frame the signed-in pages share (FR-ACCT-1, FR-ACCT-2).
 *
 * A different shape from `AuthShell`: those pages are a single centred card
 * for someone who is not signed in yet, these are a section of an application
 * for someone who is. The navigation is a real `<nav>` with `aria-current` on
 * the active entry, and it is rendered on the server like everything else, so
 * the page is complete before hydration.
 *
 * Which entries exist follows the capability flags — with e-mail off there is
 * nothing to change an address to, and with API keys off the page 404s, so a
 * link to it would be a link to a dead end (FR-MAIL-2, FR-KEY-1).
 *
 * The header carries the way *out*: sign out, and — for an administrator — the
 * administration area. `isAdmin` is resolved on the server, in `fetchProfile`,
 * against `admin.adminRoles`; it never comes from `UiContext`, which is sent to
 * anonymous browsers. It decides a link and nothing more: `/admin` is gated by
 * its own route and re-checked by every server function beneath it.
 */

export interface AccountNavItem {
  to: string
  label: string
}

export function accountNavItems(ui: UiContext, t: Catalog): AccountNavItem[] {
  return [
    { to: "/account", label: t.account.nav.profile },
    { to: "/account/security", label: t.account.nav.security },
    { to: "/account/sessions", label: t.account.nav.sessions },
    ...(ui.apiKeysEnabled
      ? [{ to: "/account/api-keys", label: t.account.nav.apiKeys }]
      : []),
    { to: "/account/consents", label: t.account.nav.consents },
  ]
}

export function AccountShell({
  ui,
  t,
  title,
  description,
  impersonated,
  isAdmin,
  children,
}: {
  ui: UiContext
  t: Catalog
  title: string
  description?: ReactNode
  /** FR-ADMIN-5: an impersonated session says so on every page it renders. */
  impersonated?: boolean
  /** Resolved server-side (`fetchProfile`); shows the administration link. */
  isAdmin?: boolean
  children: ReactNode
}) {
  const items = accountNavItems(ui, t)

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

      <div className="mx-auto w-full max-w-4xl px-4 py-10">
        <header className="mb-8 flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <p className="text-sm text-muted-foreground">{ui.siteName}</p>
            <h1 className="text-2xl font-semibold tracking-tight">
              {t.account.title}
            </h1>
          </div>
          <div className="flex items-baseline gap-4">
            {isAdmin ? (
              // A plain anchor, not a `<Link>`: `/admin` sits outside this
              // route's subtree, so a client-side navigation would have to
              // load the whole admin bundle to find out it is allowed in.
              <a
                href={`${ui.basePath}/admin`}
                className="text-sm text-muted-foreground underline underline-offset-4"
              >
                {t.admin.title}
              </a>
            ) : null}
            <form method="post" action={`${ui.basePath}/logout`}>
              <button
                type="submit"
                className="text-sm text-muted-foreground underline underline-offset-4"
              >
                {t.common.signOut}
              </button>
            </form>
          </div>
        </header>

        <div className="grid gap-8 md:grid-cols-[12rem_1fr]">
          <nav aria-label={t.account.title}>
            <ul className="flex flex-wrap gap-1 md:flex-col">
              {items.map((item) => (
                <li key={item.to}>
                  {/*
                    The colour lives in `activeProps`/`inactiveProps` and never
                    in the base class. Both are *appended* to `className` —
                    nothing merges them — so a base `text-muted-foreground`
                    stayed on the active entry beside `text-foreground`, at
                    equal specificity, and whichever utility Tailwind happened
                    to emit later won. It was the muted one: the current page
                    was styled exactly like the others, and muted text on
                    `bg-muted` failed the axe contrast check that found this.
                  */}
                  <Link
                    to={item.to}
                    activeOptions={{ exact: item.to === "/account" }}
                    className={cn("block rounded-lg px-3 py-2 text-sm")}
                    activeProps={{
                      className: "bg-muted font-medium text-foreground",
                      "aria-current": "page",
                    }}
                    inactiveProps={{
                      className: "text-muted-foreground hover:bg-muted",
                    }}
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <main>
            <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
            {description ? (
              <p className="mt-1 text-sm text-muted-foreground">
                {description}
              </p>
            ) : null}
            <div className="mt-6 grid gap-6">{children}</div>
          </main>
        </div>
      </div>
    </div>
  )
}

/** One bordered block per action, so a page of four forms still reads as four. */
export function AccountSection({
  title,
  description,
  children,
}: {
  title: string
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="rounded-xl border bg-card p-6 shadow-sm">
      <h3 className="font-medium">{title}</h3>
      {description ? (
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      ) : null}
      <div className="mt-4">{children}</div>
    </section>
  )
}
