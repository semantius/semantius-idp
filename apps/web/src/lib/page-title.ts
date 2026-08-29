import { getCatalog } from "@/server/i18n"
import type { Catalog } from "@/server/i18n"
import type { UiContext } from "@/server/ui-context"

/**
 * The `<title>` a page carries (**D93**).
 *
 * `routes/admin.tsx`'s `head()` names the whole subtree `site.adminTitle`, so
 * every bookmark of every admin page was called "User Manager" — including,
 * once D93 made an edit addressable, `/admin/clients/foo/edit`.
 * Bookmarkability is the premise of that change, and a bookmark you cannot
 * tell from seven others is not one.
 *
 * The deepest matched `head()` wins, so a page supplying its own overrides the
 * area's, and a page that supplies none still gets the area's. The site name
 * stays in it: a tab strip of eight tabs called "Users" is the other half of
 * the same problem.
 *
 * A middle dot rather than an em dash, because the page name is a label and
 * not a sentence — and because several of the names contain a dash already.
 */
export function documentTitle(page: string, site: string): string {
  return `${page} · ${site}`
}

/**
 * `head()` for a page under `/admin/*`, named for `site.adminTitle` (D61).
 *
 * Takes the page's name as a function of the catalog rather than as a string,
 * so the wording never leaves it (FR-I18N-1) and the call site reads like every
 * other one: `adminHead(loaderData?.ui, (t) => t.admin.roles.title)`.
 *
 * `loaderData` is `undefined` while a match is still resolving, which is why
 * the `ui` is optional and the answer is then an empty head — the root's title
 * stands until the page has one.
 */
export function adminHead(
  ui: UiContext | undefined,
  page: (t: Catalog) => string
) {
  if (!ui) return {}
  return {
    meta: [{ title: documentTitle(page(getCatalog(ui.locale)), ui.adminTitle) }],
  }
}
