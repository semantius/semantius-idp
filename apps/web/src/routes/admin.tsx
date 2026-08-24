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
 * makes people think the server is broken.
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
  loader: ({ context }) => ({ ui: context.ui, gate: context.gate }),
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
            className={`${buttonVariants()} mt-6 h-9 px-4`}
          >
            {t.admin.forbidden.back}
          </a>
        </div>
      </div>
    )
  }

  return <Outlet />
}
