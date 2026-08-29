import { Fragment } from "react"

import { Link, useMatches } from "@tanstack/react-router"

import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@workspace/ui/components/breadcrumb"

import { getCatalog } from "@/server/i18n"
import type { Catalog } from "@/server/i18n"

/**
 * The trail in the chrome header row (**D93**).
 *
 * **It is composed from the route matches, never passed down as a prop.**
 * `SidebarLayout` sits above every page in its subtree and cannot receive data
 * from its children, so a breadcrumb rendered there has to read the router.
 * Each route declares the crumbs it adds; this walks the matches in order and
 * concatenates them, which is why the trail cannot disagree with the URL: the
 * file that owns a path owns its crumbs.
 *
 * **Declared on the loader's return, not in `staticData`.** `staticData` was
 * the obvious home for a constant label and is not available: augmenting
 * `StaticDataRouteOption` means `declare module "@tanstack/router-core"`, and
 * that package is not resolvable from `apps/web` — it reaches the app through
 * `@tanstack/react-router`, which only re-exports the type, so an augmentation
 * there collides with the re-export instead of merging with it. Adding a
 * dependency to satisfy a type is the wrong trade. Every route under
 * `/admin/*` and `/account/*` already has a loader that returns `ui`, so the
 * crumbs ride along with it — one field, one place, and serializable, which a
 * function of the catalog would not have been.
 *
 * **Every crumb carries a `to`; the last one does not use it.** A breadcrumb's
 * final entry is the page you are on, so it renders as `BreadcrumbPage` and
 * the target is ignored. Declaring it anyway means a route never has to know
 * whether it happens to be the deepest match — the same crumb reads the same
 * way on `/admin/users` and on `/admin/users/$userId`.
 */
export interface Crumb {
  label: string
  /**
   * Where it links, as an absolute router path (no base path — `Link` adds
   * it). Ignored on the last crumb, which is the current page.
   *
   * Always a **static** list path in this application. That is not an accident
   * of the routes that exist: a crumb that named a record would be the last
   * one — `/admin/users/$id/edit`'s trail ends at the account, and
   * `/admin/clients/$id/edit`'s at the application — so no dynamic path is
   * ever a link, and `Link`'s typed `to` never has to be worked around.
   */
  to?: string
}

/**
 * A route's crumbs, built from the catalog its own locale resolves to.
 *
 * A loader helper rather than a component one: the wording has to come from
 * the catalog (FR-I18N-1) and the trail has to be plain serializable data by
 * the time it reaches the client, so the catalog is read where the loader is
 * and only strings travel.
 */
export function crumbTrail(
  ui: { locale: string },
  build: (t: Catalog) => Crumb[]
): Crumb[] {
  return build(getCatalog(ui.locale))
}

/** The crumbs every matched route declared, root first. */
export function useCrumbs(): Crumb[] {
  const matches = useMatches()
  const trail: Crumb[] = []
  for (const match of matches) {
    const declared = (match.loaderData as { crumbs?: unknown } | undefined)
      ?.crumbs
    if (!Array.isArray(declared)) continue
    for (const crumb of declared as Crumb[]) trail.push(crumb)
  }
  return trail
}

/**
 * How many crumbs survive below `md`, counting from the end.
 *
 * `BreadcrumbList` is `flex-wrap`, and three crumbs wrap to three lines inside
 * a fixed `h-16` bar — so on a narrow viewport the list is truncated to the
 * page and its parent with an ellipsis standing in for the rest. Above `md`
 * everything shows. The list is `flex-nowrap` either way, because a bar with a
 * declared height must not be asked to hold two lines.
 */
const NARROW_CRUMBS = 2

export function ShellBreadcrumb({
  label,
  crumbs,
}: {
  /**
   * The landmark's accessible name, from the catalog. The registry component
   * hard-codes `aria-label="breadcrumb"`; a passed one wins over it, which is
   * how `SidebarTrigger` gets its name too (FR-I18N-1).
   */
  label: string
  crumbs: Crumb[]
}) {
  if (crumbs.length === 0) return null
  const firstShownWhenNarrow = Math.max(0, crumbs.length - NARROW_CRUMBS)

  return (
    <Breadcrumb aria-label={label} className="min-w-0">
      {/* `flex-nowrap`: see NARROW_CRUMBS. `min-w-0` on the list and on the
          last item is what lets the truncation below actually happen — a flex
          item's automatic minimum size is its content, so without it a long
          e-mail address pushes the bar wider than the page instead of being
          clipped. */}
      <BreadcrumbList className="min-w-0 flex-nowrap">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1
          const hiddenWhenNarrow = index < firstShownWhenNarrow
          return (
            <Fragment key={`${crumb.label}-${String(index)}`}>
              {index > 0 ? (
                <BreadcrumbSeparator
                  className={hiddenWhenNarrow ? "hidden md:block" : undefined}
                />
              ) : null}
              {/* The ellipsis stands where the hidden crumbs were, so a
                  narrow trail still says it is not the whole of it. */}
              {hiddenWhenNarrow && index === firstShownWhenNarrow - 1 ? (
                <BreadcrumbItem className="md:hidden">
                  <BreadcrumbEllipsis />
                </BreadcrumbItem>
              ) : null}
              <BreadcrumbItem
                className={
                  hiddenWhenNarrow ? "hidden md:inline-flex" : "min-w-0"
                }
              >
                {last || !crumb.to ? (
                  <BreadcrumbPage className="truncate">
                    {crumb.label}
                  </BreadcrumbPage>
                ) : (
                  <BreadcrumbLink
                    className="truncate"
                    render={<Link to={crumb.to} />}
                  >
                    {crumb.label}
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          )
        })}
      </BreadcrumbList>
    </Breadcrumb>
  )
}
