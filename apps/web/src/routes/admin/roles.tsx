import { createFileRoute } from "@tanstack/react-router"

import { Badge } from "@workspace/ui/components/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"

import { AdminShell } from "@/components/admin/admin-shell"
import { getCatalog } from "@/server/i18n"
import { fetchRoles } from "@/server/functions/admin"

/**
 * `/admin/roles` — the catalog, and who holds what (FR-ROLE-2).
 *
 * Read-only for the same reason as the clients page: the catalog is
 * `roles.json`. What is *not* in the file — how many people actually hold each
 * role — is the reason this page exists at all, and it is the number an
 * administrator needs before removing one.
 */
export const Route = createFileRoute("/admin/roles")({
  loader: async ({ context }) => ({
    ui: context.ui,
    gate: context.gate,
    roles: (await fetchRoles()) ?? [],
  }),
  component: RolesPage,
})

function RolesPage() {
  const { ui, gate, roles } = Route.useLoaderData()
  const t = getCatalog(ui.locale)

  return (
    <AdminShell
      ui={ui}
      t={t}
      title={t.admin.roles.title}
      description={t.admin.roles.description}
      impersonated={gate.admin ? gate.impersonated : false}
    >
      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.admin.roles.name}</TableHead>
              <TableHead>{t.admin.roles.users}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {roles.map((role) => (
              <TableRow key={role.name}>
                <TableCell>
                  <span className="font-medium">{role.name}</span>
                  {role.description ? (
                    <span className="block text-xs text-muted-foreground">
                      {role.description}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="tabular-nums">{role.users}</TableCell>
                <TableCell>
                  {role.isDefault ? (
                    <Badge variant="secondary" className="mr-1">
                      {t.admin.roles.isDefault}
                    </Badge>
                  ) : null}
                  {role.isAdmin ? <Badge>{t.admin.roles.isAdmin}</Badge> : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </AdminShell>
  )
}
