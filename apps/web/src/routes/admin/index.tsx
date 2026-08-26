import { Link, createFileRoute } from "@tanstack/react-router"

import { Alert, AlertDescription } from "@workspace/ui/components/alert"

import { AdminCard, AdminShell, Stat } from "@/components/admin/admin-shell"
import { getCatalog } from "@/server/i18n"
import { fetchAdminStats } from "@/server/functions/admin"

/**
 * `/admin` — the numbers, and the one thing that needs doing (FR-ADMIN-2).
 *
 * The pending-approval count is a link rather than a statistic, because it is
 * the only figure on this page that represents *people waiting*: everything
 * else describes the deployment, and this describes a queue (FR-SIGNUP-2).
 *
 * Configuration warnings are shown here as well as logged. An operator who
 * mis-typed a social provider's domain finds out at start-up only if they were
 * watching the log at the time; this is where they find out afterwards.
 */
export const Route = createFileRoute("/admin/")({
  loader: async ({ context }) => ({
    ui: context.ui,
    gate: context.gate,
    stats: await fetchAdminStats(),
  }),
  component: Dashboard,
})

function Dashboard() {
  const { ui, gate, stats } = Route.useLoaderData()
  const t = getCatalog(ui.locale)
  const impersonated = gate.admin ? gate.impersonated : false

  if (!stats) return null

  return (
    <AdminShell
      ui={ui}
      t={t}
      title={t.admin.dashboard.title}
      impersonated={impersonated}
    >
      {stats.users.pending > 0 ? (
        <Alert className="mb-6">
          <AlertDescription>
            {t.admin.dashboard.pendingCta(stats.users.pending)}{" "}
            <Link
              to="/admin/users"
              search={{ status: "pending" }}
              className="underline underline-offset-4"
            >
              {t.admin.dashboard.review}
            </Link>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t.admin.dashboard.users} value={stats.users.total} />
        <Stat
          label={t.admin.dashboard.pending}
          value={stats.users.pending}
          tone="warning"
        />
        <Stat label={t.admin.dashboard.active} value={stats.users.active} />
        <Stat
          label={t.admin.dashboard.banned}
          value={stats.users.banned}
          tone="warning"
        />
        <Stat label={t.admin.dashboard.admins} value={stats.users.admins} />
        <Stat label={t.admin.dashboard.sessions} value={stats.sessions} />
        <Stat label={t.admin.dashboard.clients} value={stats.clients.total} />
        <Stat label={t.admin.dashboard.signIns} value={stats.signIns24h} />
        <Stat
          label={t.admin.dashboard.failures}
          value={stats.signInFailures24h}
          tone="warning"
        />
      </div>

      {stats.warnings.length > 0 ? (
        <AdminCard className="mt-8" title={t.admin.dashboard.warningsTitle}>
          <ul className="grid gap-2">
            {stats.warnings.map((warning) => (
              <li key={warning}>
                <Alert variant="destructive">
                  <AlertDescription>{warning}</AlertDescription>
                </Alert>
              </li>
            ))}
          </ul>
        </AdminCard>
      ) : null}
    </AdminShell>
  )
}
