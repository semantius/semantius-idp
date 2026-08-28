import { createFileRoute } from "@tanstack/react-router"

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@workspace/ui/components/alert"
import { Badge } from "@workspace/ui/components/badge"
import { Card } from "@workspace/ui/components/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"

import { AdminShell } from "@/components/admin/admin-shell"
import { LocalTime } from "@/components/common/local-time"
import { getCatalog } from "@/server/i18n"
import { fetchRoles, fetchRolesStatus } from "@/server/functions/admin"

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
    roles: (await fetchRoles()) ?? [],
    // FR-ADMIN-2 asks this page for the last reconcile and the warnings; both
    // were specified and neither was ever rendered.
    status: await fetchRolesStatus(),
  }),
  component: RolesPage,
})

function RolesPage() {
  const { ui, roles, status } = Route.useLoaderData()
  const t = getCatalog(ui.locale)

  return (
    <AdminShell
      title={t.admin.roles.title}
      description={t.admin.roles.description}
    >
      {status ? (
        <p className="mb-4 text-sm text-muted-foreground">
          {t.admin.roles.lastReconcile} <LocalTime iso={status.reconciledAt} />
        </p>
      ) : null}

      {status && status.warnings.length > 0 ? (
        <Alert variant="destructive" className="mb-4">
          <AlertTitle>{t.admin.roles.warnings}</AlertTitle>
          <AlertDescription>
            <ul className="grid gap-1">
              {status.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      <Card className="overflow-x-auto py-0">
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
      </Card>
    </AdminShell>
  )
}
