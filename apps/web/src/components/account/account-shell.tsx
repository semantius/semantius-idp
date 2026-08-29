import type { ReactNode } from "react"

import {
  Blocks,
  KeyRound,
  Lock,
  MonitorSmartphone,
  UserRound,
} from "lucide-react"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"

import { PageHeader } from "@/components/common/page-header"
import type { ShellNavItem } from "@/components/common/sidebar-layout"

import type { Catalog } from "@/server/i18n"
import type { UiContext } from "@/server/ui-context"

/**
 * The page header `/account/*` shares (FR-ACCT-1, FR-ACCT-2).
 *
 * The navigation, the sign-out and the administrator's way into `/admin` moved
 * up into `routes/account.tsx`'s `SidebarLayout` in **D82**; so did the
 * `<main>` landmark, which `SidebarInset` now renders once for the whole
 * subtree. What is left is the page's own heading and description — an `<h1>`
 * since **D93**, because the chrome's row is the breadcrumb's now.
 *
 * Which nav entries exist still follows the capability flags — with e-mail off
 * there is nothing to change an address to, and with API keys off the page
 * 404s, so a link to it would be a link to a dead end (FR-MAIL-2, FR-KEY-1).
 */

export function accountNavItems(ui: UiContext, t: Catalog): ShellNavItem[] {
  return [
    {
      to: "/account",
      label: t.account.nav.profile,
      icon: UserRound,
      exact: true,
    },
    { to: "/account/security", label: t.account.nav.security, icon: Lock },
    {
      to: "/account/sessions",
      label: t.account.nav.sessions,
      icon: MonitorSmartphone,
    },
    ...(ui.apiKeysEnabled
      ? [
          {
            to: "/account/api-keys",
            label: t.account.nav.apiKeys,
            icon: KeyRound,
          },
        ]
      : []),
    { to: "/account/consents", label: t.account.nav.consents, icon: Blocks },
  ]
}

export function AccountShell({
  title,
  description,
  children,
}: {
  title: string
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <section>
      {/* `PageHeader`, the same one `/admin/*` uses (**D93**): the `<h1>` is
          the page's since the breadcrumb took the chrome's header row, and the
          route-change focus target has to be the same element in both areas. */}
      <PageHeader title={title} description={description} />
      <div className="grid gap-6">{children}</div>
    </section>
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
    // Same substitution as `AuthShell`: the kit's Card, with the real `<h3>`
    // kept inside `CardTitle` so the heading role survives.
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>{title}</h3>
        </CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}
