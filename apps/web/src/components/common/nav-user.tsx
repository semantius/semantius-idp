import { ChevronsUpDown, LogOut } from "lucide-react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@workspace/ui/components/sidebar"
import { cn } from "@workspace/ui/lib/utils"

import type { Catalog } from "@/server/i18n"

/**
 * The sidebar footer's identity block and its menu (**D82**).
 *
 * Adapted from semantius-app's `NavUser`, which is why the trigger, the
 * `w-(--anchor-width)` popup and the mobile/desktop `side` are copied rather
 * than invented — the two shells should look like the same product.
 *
 * Two things are ours. There is **no avatar component**: this identity
 * provider stores no picture URL, so `AvatarImage` would never have a source
 * and every user would render the fallback; an initials block pinned to that
 * fallback's own look is the same pixels without a registry component whose
 * only job would be to fail over.
 *
 * And **sign-out is a link, not a form**. The header's old control posted
 * straight to `/logout`; inside a Base UI menu that would mean a `<form>` in a
 * portalled popup which the menu unmounts as the item is activated — the D80
 * problem, one layer further in. `GET /logout` is the branded confirmation
 * page that already exists for exactly this, so the menu links to it and the
 * page carries the POST. Signing out becomes two steps, which for a
 * destructive control on a menu nobody opens by accident is not a loss.
 */

/**
 * One letter from each end of the name, or the address' first letter.
 *
 * `name` is derived (D49) and can be empty for an account created with neither
 * part filled in, so the address is the fallback rather than a literal "U":
 * every account has one, and an initial the user recognizes beats a
 * placeholder that is the same for everybody.
 */
function initialsOf(name: string, email: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return (email.trim()[0] ?? "?").toUpperCase()
  if (parts.length === 1) return (parts[0]![0] ?? "?").toUpperCase()
  return `${parts[0]![0] ?? ""}${parts[parts.length - 1]![0] ?? ""}`.toUpperCase()
}

/**
 * The square that stands in for an avatar, at both sizes the menu uses.
 *
 * **Not `bg-sidebar-primary`**, which is what semantius-app's tile and this
 * plan both said. That pairing carries a white *icon* there; here it carries
 * *text*, and `--sidebar-primary` against `--sidebar-primary-foreground`
 * measures **3.07:1 in the light theme and 2.12:1 in the dark** — under R-1's
 * 4.5:1 floor, and an axe finding on every admin and account page. The
 * accent surface is `AvatarFallback`'s own idea of a fallback anyway, and it
 * measures **16.04:1** and **14.56:1**. Re-measure if a preset is applied.
 */
function Initials({
  children,
  className,
}: {
  children: string
  className?: string
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-accent text-xs font-semibold text-sidebar-accent-foreground",
        className
      )}
    >
      {children}
    </div>
  )
}

export interface NavUserCrossLink {
  /** Absolute, base-path-prefixed: the target is outside this route subtree. */
  href: string
  label: string
}

export function NavUser({
  t,
  basePath,
  user,
  crossLink,
}: {
  t: Catalog
  basePath: string
  user: { name: string; email: string }
  /** `/admin` from `/account` and back — rendered only when it is allowed. */
  crossLink?: NavUserCrossLink
}) {
  const { isMobile } = useSidebar()
  const initials = initialsOf(user.name, user.email)
  // An account can have neither part of a name (D49 derives it from the two),
  // and then the address is the only thing there is to call it — printed once,
  // not stacked above itself.
  const displayName = user.name.trim() || user.email
  const secondLine = displayName === user.email ? undefined : user.email

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                className="data-[popup-open]:bg-sidebar-accent data-[popup-open]:text-sidebar-accent-foreground"
              />
            }
          >
            <Initials>{initials}</Initials>
            <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{displayName}</span>
              {secondLine ? (
                <span className="truncate text-xs">{secondLine}</span>
              ) : null}
            </div>
            <ChevronsUpDown className="ml-auto size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--anchor-width) min-w-56 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel className="p-0 font-normal">
                <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                  <Initials>{initials}</Initials>
                  <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">{displayName}</span>
                    {secondLine ? (
                      <span className="truncate text-xs">{secondLine}</span>
                    ) : null}
                  </div>
                </div>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            {crossLink ? (
              <>
                <DropdownMenuSeparator />
                {/* A plain anchor, never a `<Link>`: the other area is a
                    separate route subtree, and a client-side navigation would
                    pull its whole bundle in to find out whether the visitor is
                    allowed there (FR-ACCT-1). */}
                <DropdownMenuItem render={<a href={crossLink.href} />}>
                  {crossLink.label}
                </DropdownMenuItem>
              </>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem render={<a href={`${basePath}/logout`} />}>
              <LogOut />
              {t.common.signOut}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
