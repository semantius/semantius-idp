/**
 * Whether the admin/account sidebar starts expanded (**D82**).
 *
 * The collapse state has to be known **before** the first paint, or every
 * navigation renders an expanded sidebar and then snaps it shut once React
 * hydrates. So it is a cookie the browser sets and the server reads, and the
 * value reaches the page through the two layout loaders' own data — the same
 * arrangement `__root.tsx` uses for everything else that must be right on the
 * server's first pass.
 *
 * It is deliberately **not** carried on `UiContext`: `fetchUiContext` is
 * process-constant and shared by every request, and this varies per browser.
 *
 * Our own name, not the registry's. `sidebar.tsx`'s `SidebarProvider` writes
 * `sidebar_state` at `path=/` unconditionally and nothing here reads it; that
 * write is accepted rather than patched out, because the file is registry
 * output. Ours is scoped to the mount path so a sub-path deployment (OPS-10)
 * and a root one on the same host do not overwrite each other's preference.
 *
 * The writer is `ScopedSidebarProvider` in `components/common/sidebar-layout.tsx`,
 * which repeats the name as a literal — a component may not import a server
 * module (`check-client-bundle.ts`), so the two ends are kept in step by this
 * comment and the unit test beside it.
 */

/** Read by this module, written by `ScopedSidebarProvider`. Keep in step. */
export const SIDEBAR_COOKIE = "idp_sidebar_state"

/**
 * `true` unless the browser has explicitly said `false`.
 *
 * An absent cookie is a first visit, and the sidebar's default is open. Any
 * value other than `"false"` is treated as open for the same reason: a
 * corrupted or half-written cookie should not collapse the navigation.
 */
export function readSidebarOpen(request: Request): boolean {
  const header = request.headers.get("cookie")
  if (!header) return true

  for (const pair of header.split(";")) {
    const index = pair.indexOf("=")
    if (index === -1) continue
    // `split(";")` leaves the separator's space on every pair but the first.
    if (pair.slice(0, index).trim() !== SIDEBAR_COOKIE) continue
    return pair.slice(index + 1).trim() !== "false"
  }

  return true
}
