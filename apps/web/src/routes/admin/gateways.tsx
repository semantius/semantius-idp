import { createFileRoute } from "@tanstack/react-router"

import { Badge } from "@workspace/ui/components/badge"
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
import { GatewayCreateDialog } from "@/components/admin/gateway-create-dialog"
import { GatewayRowActions } from "@/components/admin/gateway-row-actions"
import { FormAlert } from "@/components/auth/form-parts"
import { NoticeToast } from "@/components/common/notice-toast"
import { messageForErrorCode, messageForNoticeCode } from "@/lib/auth-errors"
import { searchString } from "@/lib/search-params"
import { getCatalog } from "@/server/i18n"
import { claimAdminDraft, fetchGateways } from "@/server/functions/admin"
import {
  adminErrorCodeFor,
  callAuth,
  readForm,
  redirectWithCookies,
  withError,
} from "@/server/http/auth-proxy"
import { stashDraft, withDraft } from "@/server/http/draft"
import type { Draft } from "@/server/http/draft"
import { requireSession } from "@/server/http/require-session"
import { getRuntime } from "@/server/runtime"

const HERE = "/admin/gateways"

/**
 * `/admin/gateways` — the authenticating reverse proxies (FR-GW-7, **D91**).
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
 * the way out in case a row written by hand carries userinfo.
 */
export const Route = createFileRoute("/admin/gateways")({
  loader: async ({ context, location }) => {
    const search = location.search as Record<string, unknown>
    return {
      ui: context.ui,
      gateways: (await fetchGateways()) ?? [],
      notice: searchString(search.notice),
      error: searchString(search.error),
      // The refused submission, so the dialog can reopen with what was typed
      // rather than empty (D62). Claimed, so a reload shows the form the
      // administrator is already looking at rather than an older one.
      draft:
        (await claimAdminDraft({ data: searchString(search.draft) ?? "" })) ??
        undefined,
    }
  },
  component: GatewaysPage,
  server: {
    handlers: {
      POST: async ({ request }) => {
        const runtime = await getRuntime()
        const base = runtime.config.base.basePath
        const here = `${base}${HERE}`

        // Read before the gate, which D63 established and **D81** kept: a
        // refusal that arrives with the body already in hand can stash the
        // draft, and the error path below does.
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

        // Create and update marshal identically — `/idp/update-gateway` takes
        // create's body, because a full replace *is* a create against a row
        // that already exists (D72's shape).
        const updating = form.action === "update"
        const result = await callAuth(
          runtime,
          updating ? "/idp/update-gateway" : "/idp/create-gateway",
          {
            name: form.name ?? "",
            url: form.url ?? "",
            requireAuth: form.requireAuth === "on",
          },
          request
        )
        if (!result.ok) {
          // What is left for the server to refuse is a duplicate name, a
          // file-managed collision or a lost race — none of which the form
          // could have known (D62). The fields come back rather than being
          // retyped; nothing password-shaped is in there.
          const draft = await stashDraft(runtime, {
            // Which dialog reopens. An edit dialog exists per row, so the name
            // is what tells them apart — without it, every row's dialog would
            // reopen carrying one row's rejected values (D72).
            action: form.action,
            name: form.name,
            url: form.url,
            requireAuth: form.requireAuth,
          })
          return redirectWithCookies(
            withError(withDraft(here, draft), adminErrorCodeFor(result))
          )
        }

        return redirectWithCookies(
          `${here}?notice=${updating ? "gatewayUpdated" : "gatewayCreated"}`
        )
      },
    },
  },
})

function GatewaysPage() {
  const { ui, gateways, notice, error, draft } = Route.useLoaderData()
  const t = getCatalog(ui.locale)
  // One draft handle, several dialogs that could claim it (**D72**'s rule).
  // `action` says which; absent means create.
  const createDraft = draft?.action === "update" ? undefined : draft
  const editDraftFor = (name: string): Draft | undefined =>
    draft?.action === "update" && draft.name === name ? draft : undefined

  return (
    <AdminShell
      title={t.admin.gateways.title}
      description={t.admin.gateways.description}
      actions={
        <GatewayCreateDialog
          t={t}
          draft={createDraft}
          // Reopened when there is a restored form to come back to, with the
          // refusal inside it: a modal covers the page-level alert.
          reopen={createDraft !== undefined}
          error={
            createDraft !== undefined
              ? messageForErrorCode(error, t, ui.passwordMinLength)
              : undefined
          }
        />
      }
    >
      <NoticeToast message={messageForNoticeCode(notice, t)} />
      {/* Not when the dialog is reopening with it — the modal would cover it. */}
      <FormAlert>
        {draft === undefined
          ? messageForErrorCode(error, t, ui.passwordMinLength)
          : undefined}
      </FormAlert>

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
                      <GatewayRowActions
                        t={t}
                        gateway={gateway}
                        draft={editDraftFor(gateway.name)}
                        error={
                          editDraftFor(gateway.name) !== undefined
                            ? messageForErrorCode(
                                error,
                                t,
                                ui.passwordMinLength
                              )
                            : undefined
                        }
                      />
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <span className="font-medium">{gateway.name}</span>
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
