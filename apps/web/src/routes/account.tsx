import { Outlet, createFileRoute, redirect } from "@tanstack/react-router"

import { fetchProfile } from "@/server/functions/account"
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
  component: () => <Outlet />,
})
