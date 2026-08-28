import * as React from "react"

import { Link, useMatchRoute, useRouterState } from "@tanstack/react-router"

import type { LucideIcon } from "lucide-react"

import { Separator } from "@workspace/ui/components/separator"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@workspace/ui/components/sidebar"
import { TooltipProvider } from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

import { ImpersonationBanner } from "@/components/common/impersonation-banner"
import { NavUser } from "@/components/common/nav-user"
import type { NavUserCrossLink } from "@/components/common/nav-user"

import type { Catalog } from "@/server/i18n"
import type { UiContext } from "@/server/ui-context"

/**
 * The chrome `/admin/*` and `/account/*` share (**D82**).
 *
 * It lives in the two **layout routes**, not in the page shells, and that is
 * the whole point of the change. `SidebarProvider` holds open/collapsed and
 * mobile-sheet state plus a window keydown listener; a layout route's
 * component persists across every navigation inside its subtree, so the state
 * survives a page change and the listener is registered once. Mounted per page
 * — where `AdminShell` and `AccountShell` used to put it — every navigation
 * would remount the provider, snap the sidebar back open and stack another
 * listener.
 *
 * It also supersedes **D66**'s deliberate duplication of the impersonation
 * banner across the two shells. That was the right call while the two shells
 * were the two ways to reach a signed-in page; now there is one component and
 * FR-ADMIN-5 holds by construction rather than by both copies being kept.
 */

/** The cookie `ScopedSidebarProvider` writes; `http/sidebar-cookie.ts` reads it. */
const SIDEBAR_COOKIE = "idp_sidebar_state"
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

export interface ShellNavItem {
  to: string
  label: string
  icon: LucideIcon
  /** The subtree index, which must not stay lit on every child page. */
  exact?: boolean
}

/**
 * The registry provider, made controlled so the choice can be persisted.
 *
 * `SidebarProvider` writes `sidebar_state` at `path=/` on every toggle and
 * never reads it; nothing here reads it either, and the file is registry
 * output, so that write is accepted rather than patched out. Ours is a
 * separate name **scoped to the mount path**, so a sub-path deployment
 * (OPS-10) and a root one on the same host keep their own preference instead
 * of overwriting each other's.
 *
 * The name is repeated as a literal rather than imported: `sidebar-cookie.ts`
 * is under `server/`, a route loader is isomorphic, and one import of a server
 * module from a component is what `check-client-bundle.ts` exists to catch.
 */
function ScopedSidebarProvider({
  basePath,
  defaultOpen,
  className,
  children,
}: {
  basePath: string
  defaultOpen: boolean
  className?: string
  children: React.ReactNode
}) {
  const [open, setOpen] = React.useState(defaultOpen)

  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      setOpen(next)
      // A UI preference, so `Lax` and `Secure`-when-https is the whole of it;
      // the server reads it only to get the first paint right.
      document.cookie =
        `${SIDEBAR_COOKIE}=${String(next)}` +
        `; path=${basePath || "/"}` +
        `; max-age=${String(SIDEBAR_COOKIE_MAX_AGE)}` +
        "; samesite=lax" +
        (window.location.protocol === "https:" ? "; secure" : "")
    },
    [basePath]
  )

  return (
    <SidebarProvider
      open={open}
      onOpenChange={handleOpenChange}
      className={className}
    >
      {children}
    </SidebarProvider>
  )
}

/**
 * Everything inside the sidebar, in a component of its own.
 *
 * Not for tidiness: `useSidebar()` throws outside `SidebarProvider`, and the
 * provider is rendered by `SidebarLayout`, so the hook cannot be called there.
 * What it is needed for is `setOpenMobile` — see below.
 */
function ShellSidebar({
  ui,
  t,
  brand,
  heading,
  items,
  indexTo,
  user,
  crossLink,
  impersonated,
}: {
  ui: UiContext
  t: Catalog
  brand: string
  heading: string
  items: ShellNavItem[]
  indexTo: string
  user: { name: string; email: string }
  crossLink?: NavUserCrossLink
  impersonated?: boolean
}) {
  const matchRoute = useMatchRoute()
  const { setOpenMobile } = useSidebar()
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })

  /**
   * Below `md` the sidebar is a modal sheet, and a client-side navigation does
   * not unmount it: the page changes *underneath* an open drawer that is still
   * covering it and still holding the focus trap. The e2e suite caught this on
   * a 390-wide viewport — the URL was right and the heading behind it was
   * `aria-hidden`, which is exactly what a phone user would have got.
   *
   * On the route rather than on each link's `onClick`, so a nav entry added
   * later is closed by existing rather than by remembering — and so the back
   * button, which no `onClick` can see, closes it too.
   */
  React.useEffect(() => {
    setOpenMobile(false)
  }, [pathname, setOpenMobile])

  return (
    <Sidebar
      collapsible="icon"
      // **`mt-`, not `top-`.** The registry's container is `fixed inset-y-0
      // h-svh`, and `cn()` resolves only one of those two for us: `h-svh`
      // and `h-[calc(…)]` are the same tailwind-merge group, `inset-y-0` and
      // `top-*` are not. So a `top-(--banner-h)` would sit in the class list
      // *beside* `inset-block: 0` and win only because Tailwind happens to
      // emit longhands after shorthands — true today, measured in the built
      // stylesheet, and not something this layout should depend on. A margin
      // cannot conflict with an inset at all: `top: 0` plus `margin-top`
      // starts the box below the banner, and the explicit height makes the
      // over-constrained `bottom: 0` moot.
      className={cn(
        impersonated && "mt-(--banner-h) h-[calc(100svh-var(--banner-h))]"
      )}
    >
      {/* The brand is the name and nothing else — no tile beside it, on the
          owner's call. That is also what both areas showed before the sidebar:
          `site.adminTitle` / `site.name` as a line of text above the heading.

          Hidden on the icon rail rather than reduced to a square, because with
          no tile there is nothing left to reduce it *to*: a collapsed brand
          block would be an empty 8×8 link, which is an unnamed control to a
          screen reader and an axe finding. The mobile sheet sets no
          `data-collapsible`, so the drawer keeps its title. */}
      <SidebarHeader className="group-data-[collapsible=icon]:hidden">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link to={indexTo} />}>
              <span className="truncate text-base font-semibold">{brand}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {/* A real landmark, named for the area. `SidebarGroup` is what
            supplies the `p-2`; without it the items sit flush against the
            sidebar's edge. */}
        <nav aria-label={heading}>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {items.map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton
                      // `activeProps` cannot reach this: the highlight lives
                      // on the button's own `data-active`, and the `<Link>` is
                      // *inside* the button. `useMatchRoute` answers the same
                      // question a step earlier — fuzzy, so "Users" stays lit
                      // on `/admin/users/$userId`.
                      isActive={
                        !!matchRoute({ to: item.to, fuzzy: !item.exact })
                      }
                      tooltip={item.label}
                      render={
                        <Link
                          to={item.to}
                          activeOptions={{ exact: item.exact ?? false }}
                          activeProps={{ "aria-current": "page" }}
                        />
                      }
                    >
                      <item.icon />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </nav>
      </SidebarContent>

      <SidebarFooter>
        <NavUser
          t={t}
          basePath={ui.basePath}
          user={user}
          crossLink={crossLink}
        />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

export function SidebarLayout({
  ui,
  t,
  brand,
  heading,
  items,
  indexTo,
  user,
  crossLink,
  impersonated,
  defaultOpen,
  children,
}: {
  ui: UiContext
  t: Catalog
  /** The name in the sidebar header — `site.adminTitle` or `site.name`. */
  brand: string
  /** The area's own name: the header row's `<h1>` and the nav's label. */
  heading: string
  items: ShellNavItem[]
  /** Where the brand block links — the subtree's index. */
  indexTo: string
  user: { name: string; email: string }
  crossLink?: NavUserCrossLink
  /** FR-ADMIN-5: an impersonated session says so on every page it renders. */
  impersonated?: boolean
  /** Read from the browser's cookie on the server, so the first paint is right. */
  defaultOpen: boolean
  children: React.ReactNode
}) {
  return (
    // `--banner-h` is what the fixed sidebar is offset by, and it is only ever
    // right because the desktop sidebar exists at `md` and up (the registry's
    // container is `hidden … md:flex`), where the banner is one line: `py-2`
    // twice around a `size="sm"` button, which is `h-7`. The banner is pinned
    // to the same variable at that breakpoint so the two cannot drift; below
    // it the sidebar is an overlay sheet and nothing depends on the height.
    <div style={{ "--banner-h": "2.75rem" } as React.CSSProperties}>
      {impersonated ? (
        <ImpersonationBanner ui={ui} t={t} className="md:h-(--banner-h)" />
      ) : null}

      <ScopedSidebarProvider
        basePath={ui.basePath}
        defaultOpen={defaultOpen}
        // `overflow-x-hidden` is semantius-app's own guard: the admin tables
        // are wider than the viewport and would otherwise push the whole shell
        // sideways instead of scrolling inside their own container.
        className={cn(
          "overflow-x-hidden",
          impersonated && "min-h-[calc(100svh-var(--banner-h))]"
        )}
      >
        {/* The registry says to wrap the app in this, and semantius-app wraps
            its root in it. Here rather than in `__root.tsx`, because the only
            tooltips in this application are the collapsed rail's and the
            public pages should not carry the primitive. It renders no DOM —
            it is context and a shared delay — so it does not disturb the
            provider's flex row. */}
        <TooltipProvider>
          <ShellSidebar
            ui={ui}
            t={t}
            brand={brand}
            heading={heading}
            items={items}
            indexTo={indexTo}
            user={user}
            crossLink={crossLink}
            impersonated={impersonated}
          />

          {/* `SidebarInset` *is* the `<main>`, which is also how the admin area
            finally gets one — it had no main landmark at all. `min-w-0` so a
            wide table shrinks the flex item instead of the shell. */}
          <SidebarInset className="min-w-0">
            <header className="flex h-16 shrink-0 items-center gap-2 px-4 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
              {/* The catalog string wins over the registry component's own
                sr-only "Toggle Sidebar" (FR-I18N-1). */}
              <SidebarTrigger aria-label={t.common.toggleSidebar} />
              <Separator
                orientation="vertical"
                className="mr-2 data-[orientation=vertical]:h-4"
              />
              {/* semantius-app's header row carries no title; this one does,
                because three e2e specs read the area's name off a visible
                heading — and a page with no `<h1>` is an axe finding. */}
              <h1 className="text-base font-semibold tracking-tight">
                {heading}
              </h1>
            </header>
            <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-x-hidden p-4 pt-0">
              {children}
            </div>
          </SidebarInset>
        </TooltipProvider>
      </ScopedSidebarProvider>
    </div>
  )
}
