import { createFileRoute, Link } from "@tanstack/react-router"

import { AuthShell } from "@/components/auth/auth-shell"
import { searchString } from "@/lib/search-params"
import { getCatalog } from "@/server/i18n"
import { APP_ROUTES } from "@/server/oidc/base-path"

/**
 * `/banned` (FR-ADMIN-4).
 *
 * Deliberately *not* the neutral refusal the other blocked states get: a
 * suspended user is told so, with the reason and expiry when they are set, so
 * they know to appeal rather than keep retrying a password that works.
 *
 * The reason is passed through the query string by the sign-in handler, which
 * takes it from the ban record — never from user input.
 */
export const Route = createFileRoute("/banned")({
  loader: ({ context, location }) => {
    const search = location.search as Record<string, unknown>
    return {
      ui: context.ui,
      reason: searchString(search.reason),
      expires: searchString(search.expires),
    }
  },
  component: BannedPage,
})

function BannedPage() {
  const { ui, reason, expires } = Route.useLoaderData()
  const t = getCatalog(ui.locale)

  return (
    <AuthShell ui={ui} title={t.auth.banned.title}>
      <div className="grid gap-3 text-sm">
        {reason ? <p>{t.auth.banned.withReason(reason)}</p> : null}
        {expires ? (
          <p className="text-muted-foreground">{t.auth.banned.untilNotice}</p>
        ) : null}
        <p className="text-muted-foreground">
          {ui.supportEmail
            ? t.auth.banned.contact(ui.supportEmail)
            : t.auth.banned.generic}
        </p>
        <p>
          <Link to={APP_ROUTES.login} className="underline underline-offset-4">
            {t.common.back}
          </Link>
        </p>
      </div>
    </AuthShell>
  )
}
