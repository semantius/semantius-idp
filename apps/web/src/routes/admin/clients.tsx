import { createFileRoute } from "@tanstack/react-router"

import { Badge } from "@workspace/ui/components/badge"

import { AdminShell, Field } from "@/components/admin/admin-shell"
import { getCatalog } from "@/server/i18n"
import { fetchClients } from "@/server/functions/admin"

/**
 * `/admin/clients` — the registered applications, read-only (FR-OIDC-2).
 *
 * Read-only is the design, not a gap. Clients are declared in
 * `oauth_clients.json` and reconciled into the database at start-up; a form
 * here would let an administrator make a change that the next restart silently
 * undoes, which is worse than no form at all. Dynamically registered clients
 * are listed too, and labelled, so the difference is visible rather than
 * inferred.
 */
export const Route = createFileRoute("/admin/clients")({
  loader: async ({ context }) => ({
    ui: context.ui,
    gate: context.gate,
    clients: (await fetchClients()) ?? [],
  }),
  component: ClientsPage,
})

function ClientsPage() {
  const { ui, gate, clients } = Route.useLoaderData()
  const t = getCatalog(ui.locale)

  return (
    <AdminShell
      ui={ui}
      t={t}
      title={t.admin.clients.title}
      description={t.admin.clients.description}
      impersonated={gate.admin ? gate.impersonated : false}
    >
      {clients.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.admin.clients.empty}</p>
      ) : (
        <ul className="grid gap-4">
          {clients.map((client) => (
            <li key={client.clientId} className="rounded-lg border bg-card p-4">
              <div className="mb-2 flex flex-wrap items-baseline gap-2">
                <h3 className="font-medium">{client.name}</h3>
                <code className="text-xs text-muted-foreground">
                  {client.clientId}
                </code>
                <Badge variant="outline">
                  {client.managedBy === "file"
                    ? t.admin.clients.managedFile
                    : t.admin.clients.managedDatabase}
                </Badge>
                <Badge variant="secondary">
                  {client.isPublic
                    ? t.admin.clients.public
                    : t.admin.clients.confidential}
                </Badge>
                {client.disabled ? (
                  <Badge variant="destructive">
                    {t.admin.clients.disabled}
                  </Badge>
                ) : null}
                {client.skipConsent ? (
                  <Badge variant="outline">{t.admin.clients.skipConsent}</Badge>
                ) : null}
              </div>
              <dl className="divide-y">
                <Field label={t.admin.clients.redirectUris}>
                  <ul className="grid gap-0.5">
                    {client.redirectUris.map((uri) => (
                      <li key={uri}>
                        <code className="text-xs">{uri}</code>
                      </li>
                    ))}
                  </ul>
                </Field>
                <Field label={t.admin.clients.scopes}>
                  {client.scopes.join(" ") || "—"}
                </Field>
                <Field label={t.admin.clients.audience}>
                  {client.audience.join(", ") || "—"}
                </Field>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </AdminShell>
  )
}
