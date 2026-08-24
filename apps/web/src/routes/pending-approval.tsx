import { createFileRoute, Link } from "@tanstack/react-router"

import { AuthShell } from "@/components/auth/auth-shell"
import { getCatalog } from "@/server/i18n"
import { APP_ROUTES } from "@/server/oidc/base-path"

/**
 * `/pending-approval` (FR-SIGNUP-2).
 *
 * A state, not an error: the account exists and nothing the visitor can do
 * here changes anything, so the page offers no retry. Whether it promises an
 * e-mail depends on whether one can actually be sent (FR-MAIL-2).
 *
 * Asynchronous approval deliberately does **not** resume an OAuth flow
 * (FR-OIDC-9): the approval e-mail links to `/login` and the user starts again
 * from the application.
 */
export const Route = createFileRoute("/pending-approval")({
  loader: ({ context }) => ({ ui: context.ui }),
  component: PendingApprovalPage,
})

function PendingApprovalPage() {
  const { ui } = Route.useLoaderData()
  const t = getCatalog(ui.locale)

  return (
    <AuthShell
      ui={ui}
      title={t.auth.pendingApproval.title}
      description={
        ui.emailEnabled
          ? t.auth.pendingApproval.description
          : t.auth.pendingApproval.descriptionNoEmail
      }
    >
      <p className="text-sm">
        <Link to={APP_ROUTES.login} className="underline underline-offset-4">
          {t.common.back}
        </Link>
      </p>
    </AuthShell>
  )
}
