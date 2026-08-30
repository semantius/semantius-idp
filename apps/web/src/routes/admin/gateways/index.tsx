import { Link, createFileRoute } from "@tanstack/react-router"

import { Badge } from "@workspace/ui/components/badge"
import { buttonVariants } from "@workspace/ui/components/button"
import { Card } from "@workspace/ui/components/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
} from "@workspace/ui/components/empty"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"

import { AdminShell } from "@/components/admin/admin-shell"
import { GatewayRowActions } from "@/components/admin/gateway-row-actions"
import { FormRefusal } from "@/components/auth/form-parts"
import { NoticeToast } from "@/components/common/notice-toast"
import { crumbTrail } from "@/components/common/breadcrumbs"
import { messageForErrorCode, messageForNoticeCode } from "@/lib/auth-errors"
import { adminHead } from "@/lib/page-title"
import { searchString } from "@/lib/search-params"
import { getCatalog } from "@/server/i18n"
import { fetchGateways } from "@/server/functions/admin"
import {
  adminErrorCodeFor,
  callAuth,
  readForm,
  redirectWithCookies,
  withError,
} from "@/server/http/auth-proxy"
import { requireSession } from "@/server/http/require-session"
import { getRuntime } from "@/server/runtime"

const HERE = "/admin/gateways"

/**
 * `/admin/gateways` — the authenticating reverse proxies (FR-GW-7, **D91**,
 * **D92**).
 *
 * Two kinds of gateway live in one table, and the difference is visible rather
 * than inferred:
 *
 * - **From the file.** Declared in `config.jsonc`'s `gateways` block and
 *   reconciled at start-up. Read-only here, and that is the design: a form
 *   that edited one would let an administrator make a change the next restart
 *   silently undoes.
 * - **Added here.** Marked `source: "manual"`, which is exactly the value the
 *   boot sweep skips — so these survive restarts and the two sets never fight
 *   over a row.
 *
 * A created gateway works immediately: every mutation invalidates the proxy's
 * in-process registry before it returns, so there is no restart in the loop
 * and no minute of staleness (`server/gateways/registry.ts`).
 *
 * Nothing secret is ever shown here, which is why there is no one-shot stash:
 * a gateway holds a URL and two flags, and the URL is masked password-only on
 * the way out in case a row written by hand carries userinfo — and otherwise
 * returned byte for byte, which it was not until D93's first commit.
 *
 * **Create and edit are pages** (**D93**): `/admin/gateways/new` and
 * `/admin/gateways/$name/edit`, each owning the POST it used to send here.
 * What is left is enable/disable and remove — confirmations, which stay
 * modals — and the list itself. A manually-added gateway's name links to its
 * edit page; a config-owned one is plain text beside its badge.
 */
export const Route = createFileRoute("/admin/gateways/")({
  loader: async ({ context, location }) => {
    const search = location.search as Record<string, unknown>
    return {
      ui: context.ui,
      crumbs: crumbTrail(context.ui, (t) => [
        { label: t.admin.nav.gateways, to: HERE },
      ]),
      gateways: (await fetchGateways()) ?? [],
      notice: searchString(search.notice),
      error: searchString(search.error),
    }
  },
  head: ({ loaderData }) =>
    adminHead(loaderData?.ui, (t) => t.admin.gateways.title),
  component: GatewaysPage,
  server: {
    handlers: {
      POST: async ({ request }) => {
        const runtime = await getRuntime()
        const base = runtime.config.base.basePath
        const here = `${base}${HERE}`

        // Read before the gate, which D63 established and **D81** kept.
        // Nothing left here stashes a draft — create and edit are pages of
        // their own (**D93**) — but the order is the house one, and a handler
        // that reads after the gate is the one that has to remember why.
        const form = await readForm(request)

        const signedIn = await requireSession(runtime, request, HERE)
        if (!signedIn.ok) return signedIn.response

        if (form.action === "delete") {
          const result = await callAuth(
            runtime,
            "/idp/delete-gateway",
            { name: form.name ?? "" },
            request
          )
          if (!result.ok) {
            return redirectWithCookies(
              withError(here, adminErrorCodeFor(result))
            )
          }
          return redirectWithCookies(`${here}?notice=gatewayDeleted`)
        }

        if (form.action === "toggle") {
          const result = await callAuth(
            runtime,
            "/idp/set-gateway-disabled",
            { name: form.name ?? "", disabled: form.disabled === "on" },
            request
          )
          if (!result.ok) {
            return redirectWithCookies(
              withError(here, adminErrorCodeFor(result))
            )
          }
          return redirectWithCookies(
            `${here}?notice=${form.disabled === "on" ? "gatewayDisabled" : "gatewayEnabled"}`
          )
        }

        // Anything else is a field somebody hand-posted: this route answers
        // for the two confirmations above, and create and update moved to
        // their own pages (**D93**).
        return redirectWithCookies(withError(here, "invalid_request"))
      },
    },
  },
})

function GatewaysPage() {
  const { ui, gateways, notice, error } = Route.useLoaderData()
  const t = getCatalog(ui.locale)

  return (
    <AdminShell
      title={t.admin.gateways.title}
      description={t.admin.gateways.description}
      wideDescription
      actions={
        // A link, not a dialog trigger (**D93**). `new` is a static segment
        // and `$name` a dynamic one, and `isValidGatewayName` admits `new` —
        // so the static segment winning is what keeps a gateway called `new`
        // editable rather than shadowed.
        <Link
          to="/admin/gateways/new"
          className={buttonVariants({ size: "sm" })}
        >
          {t.admin.gateways.add}
        </Link>
      }
    >
      <NoticeToast message={messageForNoticeCode(notice, t)} />
      <FormRefusal>
        {messageForErrorCode(error, t, ui.passwordMinLength)}
      </FormRefusal>

      {gateways.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyDescription>{t.admin.gateways.empty}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Card className="overflow-x-auto py-0">
          <Table>
            <TableHeader>
              <TableRow>
                {/* The actions column carries no visible heading — a menu
                    button in every row needs no label above it — but a `<th>`
                    with nothing in it is a column a screen reader cannot name
                    (**D80**). First column and pinned, like `/admin/clients`. */}
                <TableHead className="sticky left-0 w-px bg-card">
                  <span className="sr-only">{t.admin.actions.title}</span>
                </TableHead>
                <TableHead>{t.admin.gateways.name}</TableHead>
                <TableHead>{t.admin.gateways.url}</TableHead>
                <TableHead>{t.admin.gateways.auth}</TableHead>
                <TableHead>{t.admin.gateways.managedBy}</TableHead>
                <TableHead>{t.admin.gateways.status}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {gateways.map((gateway) => (
                <TableRow key={gateway.name}>
                  {/* Pinned like its header, and opaque for the same reason —
                      see `/admin/clients` for why the two row states repaint
                      this cell with `--muted` pre-mixed over `--card`. */}
                  <TableCell className="sticky left-0 bg-card transition-colors [tr:is(:hover,:has([aria-expanded=true]))_&]:bg-[color-mix(in_oklab,var(--muted)_50%,var(--card))]">
                    {/* A file-managed row has no menu at all, rather than a
                        menu of things it may not do: an edit here is one the
                        next restart would silently undo (FR-GW-2). */}
                    {gateway.source === "manual" ? (
                      <GatewayRowActions t={t} gateway={gateway} />
                    ) : null}
                  </TableCell>
                  <TableCell>
                    {/* **D93**: the name is the way in, for the reason
                        `/admin/clients` gives — Edit lived only inside the
                        per-row menu, which is the first, pinned column. A
                        config-owned name stays plain text: there is nothing
                        to open. */}
                    {gateway.source === "manual" ? (
                      <Link
                        to="/admin/gateways/$name/edit"
                        params={{ name: gateway.name }}
                        className="font-medium underline underline-offset-4"
                      >
                        {gateway.name}
                      </Link>
                    ) : (
                      <span className="font-medium">{gateway.name}</span>
                    )}
                    <code className="block text-xs text-muted-foreground">
                      /gateway/{gateway.name}
                    </code>
                  </TableCell>
                  <TableCell className="text-xs">
                    <code className="break-all">{gateway.url}</code>
                  </TableCell>
                  <TableCell className="text-xs">
                    {gateway.requireAuth
                      ? t.admin.gateways.authRequired
                      : t.admin.gateways.authAnonymous}
                  </TableCell>
                  <TableCell className="text-xs">
                    <Badge variant="outline">
                      {gateway.source === "config"
                        ? t.admin.gateways.managedFile
                        : t.admin.gateways.managedDatabase}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">
                    {gateway.enabled ? (
                      <Badge variant="secondary">
                        {t.admin.gateways.enabled}
                      </Badge>
                    ) : (
                      <Badge variant="destructive">
                        {t.admin.gateways.disabled}
                      </Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </AdminShell>
  )
}
