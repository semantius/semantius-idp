import { Outlet, createFileRoute, redirect } from "@tanstack/react-router"

import { buttonVariants } from "@workspace/ui/components/button"

import { getCatalog } from "@/server/i18n"
import { APP_ROUTES } from "@/server/oidc/base-path"
import { fetchAdminGate } from "@/server/functions/admin"

/**
 * `/admin/*` — the administrative area (FR-ADMIN-2, FR-ROLE-3).
 *
 * The gate is here rather than on each page, so a new child route is protected
 * by existing rather than by remembering, and `beforeLoad` runs before any
 * child loader — an ordinary user never reaches a query.
 *
 * The two refusals are deliberately different. Someone who is not signed in is
 * *redirected* to `/login`, because signing in might well be the answer.
 * Someone who is signed in and simply has no admin role is shown a page: sending
 * them to a login form they have already completed is the kind of loop that
 * makes people think the server is broken. A 404 would be worse still —
 * masking protects a resource whose *existence* is confidential, and `/admin`
 * is a fixed, documented path (docs/admin-api.md), so it buys nothing and
 * costs a signed-in colleague a dead end.
 *
 * That page is served with **403**, which FR-ROLE-3 has always said and
 * nothing in this tree ever set: the refusal rendered with a 200, so every
 * proxy, log and probe recorded a successful page view of the admin area by
 * somebody who cannot see it.
 *
 * Start's own `setResponseStatus` does **not** work here, which the e2e suite
 * caught: the document response is built by `renderRouterToStream` with
 * `status: router.stores.statusCode.get()`, and that store only ever holds
 * 404, 500 or 200. So the status is left on the request context and applied in
 * `server-entry.ts` (`setDocumentStatus`). Behind a dynamic import guarded by
 * `import.meta.env.SSR`, because a loader is isomorphic and the client bundle
 * must not gain a server module — and on the **document** rather than inside
 * `fetchAdminGate`, which would put a 403 on the RPC response during a
 * client-side navigation, where the client may treat it as a failure rather
 * than as an answer.
 *
 * The gate is **not** the only check. Every server function under
 * `functions/admin.ts` re-checks the role, because a server function is an
 * HTTP endpoint whatever route happens to call it.
 */
export const Route = createFileRoute("/admin")({
  beforeLoad: async ({ location }) => {
    const gate = await fetchAdminGate()
    if (!gate.signedIn) {
      throw redirect({
        to: APP_ROUTES.login,
        search: { notice: "signin_required", returnTo: location.pathname },
      })
    }
    return { gate }
  },
  loader: async ({ context }) => {
    if (!context.gate.admin && import.meta.env.SSR) {
      // Vite replaces `import.meta.env.SSR` with `false` in the client build,
      // so this branch and the import inside it are eliminated there.
      const { setDocumentStatus } = await import("@/server/http/request-log")
      setDocumentStatus(403)
    }
    return { ui: context.ui, gate: context.gate }
  },
  // The document title follows `site.adminTitle` too (D61). The deepest
  // matched `head()` wins, and this is the first child of the root, so all
  // eight admin routes inherit it while the account and auth pages keep
  // `site.name` from `__root`.
  head: ({ loaderData }) =>
    loaderData ? { meta: [{ title: loaderData.ui.adminTitle }] } : {},
  component: AdminLayout,
})

function AdminLayout() {
  const { ui, gate } = Route.useLoaderData()
  const t = getCatalog(ui.locale)

  if (!gate.admin) {
    return (
      <div className="grid min-h-svh place-items-center bg-muted/30 px-4">
        <div className="w-full max-w-md rounded-lg border bg-card p-6 text-center">
          <h1 className="text-xl font-semibold tracking-tight">
            {t.admin.forbidden.title}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t.admin.forbidden.description}
          </p>
          <a
            href={`${ui.basePath}${APP_ROUTES.account}`}
            className={buttonVariants({ size: "lg", className: "mt-6" })}
          >
            {t.admin.forbidden.back}
          </a>
        </div>
      </div>
    )
  }

  return <Outlet />
}
