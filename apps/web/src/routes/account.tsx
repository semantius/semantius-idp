import { Outlet, createFileRoute, redirect } from "@tanstack/react-router"

import { accountNavItems } from "@/components/account/account-shell"
import { SidebarLayout } from "@/components/common/sidebar-layout"

import { fetchProfile } from "@/server/functions/account"
import { getCatalog } from "@/server/i18n"
import { APP_ROUTES } from "@/server/oidc/base-path"

/**
 * `/account/*` — the signed-in area (FR-ACCT-1).
 *
 * The guard lives here rather than on each page, so a new child route is
 * protected by existing, not by remembering. `beforeLoad` runs before any
 * child loader, so an anonymous visitor never reaches a query.
 *
 * The profile lands in the router context, which every child reads instead of
 * asking again — one RPC per navigation rather than one per matched route,
 * the same arrangement `__root.tsx` uses for the UI context.
 *
 * The chrome is here too, since **D82**: a layout route's component survives
 * every navigation inside its subtree, which is what the sidebar's collapse
 * state and its keyboard shortcut need. Mounted per page it would be remounted
 * on each one.
 */
export const Route = createFileRoute("/account")({
  beforeLoad: async ({ location }) => {
    const profile = await fetchProfile()
    if (!profile) {
      throw redirect({
        to: APP_ROUTES.login,
        search: { notice: "signin_required", returnTo: location.pathname },
      })
    }
    return { profile }
  },
  loader: ({ context }) => ({ ui: context.ui, profile: context.profile }),
  component: AccountLayout,
})

function AccountLayout() {
  const { ui, profile } = Route.useLoaderData()
  const t = getCatalog(ui.locale)

  return (
    <SidebarLayout
      ui={ui}
      t={t}
      brand={ui.siteName}
      heading={t.account.title}
      items={accountNavItems(ui, t)}
      indexTo="/account"
      user={{ name: profile.name, email: profile.email }}
      // `isAdmin` is resolved on the server, in `fetchProfile`, against
      // `admin.adminRoles` — never from `UiContext`, which is sent to
      // anonymous browsers. It decides a menu entry and nothing more: `/admin`
      // is gated by its own route and re-checked by every server function
      // beneath it (FR-ROLE-3).
      crossLink={
        profile.isAdmin
          ? {
              href: `${ui.basePath}${APP_ROUTES.admin}`,
              label: t.admin.title,
            }
          : undefined
      }
      impersonated={profile.impersonated}
      defaultOpen={profile.sidebarOpen}
    >
      <Outlet />
    </SidebarLayout>
  )
}
