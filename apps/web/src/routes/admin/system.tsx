import { createFileRoute } from "@tanstack/react-router"

import {
  AdminCard,
  AdminShell,
  DetailRow,
} from "@/components/admin/admin-shell"
import { FormAlert } from "@/components/auth/form-parts"
import { messageForErrorCode } from "@/lib/auth-errors"
import { searchString } from "@/lib/search-params"
import { getCatalog } from "@/server/i18n"
import type { Catalog } from "@/server/i18n"
import {
  adminErrorCodeFor,
  callAuth,
  redirectWithCookies,
} from "@/server/http/auth-proxy"
import { requireFreshSession } from "@/server/http/fresh-session"
import { fetchSystemInfo } from "@/server/functions/admin"
import { getRuntime } from "@/server/runtime"
import { PendingForm, SubmitButton } from "@/components/common/pending-form"

/**
 * `/admin/system` — what this process is running, and the one button that
 * changes it (FR-ADMIN-2, FR-OIDC-16, OPS-3).
 *
 * The configuration is printed through the same masking `idp config validate`
 * uses, from the same endpoint an admin API key would call — so what an
 * operator reads here is byte-for-byte what they would get from `curl`, and
 * neither can leak a secret the other hides.
 *
 * Rotation is behind the freshness gate like every other administrative write.
 * It is also the slowest button in the application: it takes an advisory lock
 * on a direct connection, so a second click while the first is still running
 * waits rather than races.
 */
export const Route = createFileRoute("/admin/system")({
  loader: async ({ context, location }) => {
    const search = location.search as Record<string, unknown>
    return {
      ui: context.ui,
      gate: context.gate,
      info: await fetchSystemInfo(),
      rotated: searchString(search.rotated),
      error: searchString(search.error),
    }
  },
  component: SystemPage,
  server: {
    handlers: {
      POST: async ({ request }) => {
        const runtime = await getRuntime()
        const base = runtime.config.base.basePath
        const here = `${base}/admin/system`

        const fresh = await requireFreshSession(runtime, request, here)
        if (!fresh.ok) return fresh.response

        const result = await callAuth(runtime, "/idp/rotate-keys", {}, request)
        const query = new URLSearchParams(
          result.ok
            ? { rotated: String(result.body.successorKeyId ?? "") }
            : { error: adminErrorCodeFor(result) }
        )
        return redirectWithCookies(`${here}?${query.toString()}`)
      },
    },
  },
})

/**
 * The catalog label for a discovery key, falling back to the key itself.
 *
 * Widened to `Record<string, string>` on purpose: the keys come from the
 * server, so a deployment running a newer binary than this bundle could send
 * one the catalog has never heard of. Showing the raw key is a worse label and
 * a better outcome than a blank row.
 */
function labelFor(t: Catalog, key: string): string {
  const labels: Record<string, string> = t.admin.system.discoveryUrls
  return labels[key] ?? key
}

function SystemPage() {
  const { ui, gate, info, rotated, error } = Route.useLoaderData()
  const t = getCatalog(ui.locale)

  if (!info) return null

  return (
    <AdminShell
      ui={ui}
      t={t}
      title={t.admin.system.title}
      impersonated={gate.admin ? gate.impersonated : false}
    >
      <FormAlert>
        {messageForErrorCode(error, t, ui.passwordMinLength)}
      </FormAlert>
      <FormAlert variant="default">
        {rotated ? t.admin.system.rotated(rotated) : undefined}
      </FormAlert>

      <AdminCard>
        <dl className="divide-y">
          <DetailRow label={t.admin.system.version}>{info.version}</DetailRow>
          {info.revision ? (
            <DetailRow label={t.admin.system.revision}>
              {info.revision}
            </DetailRow>
          ) : null}
          <DetailRow label={t.admin.system.issuer}>
            <code className="text-xs">{info.issuer}</code>
          </DetailRow>
          <DetailRow label={t.admin.system.email}>
            {info.email.enabled
              ? t.admin.system.emailOn(info.email.transport)
              : t.admin.system.emailOff}
          </DetailRow>
        </dl>
      </AdminCard>

      {/* D55: the question the page could not answer — "what do I paste into
          the other system?". The issuer alone is not enough, because the
          sub-path forms are not derivable from it by hand. */}
      <AdminCard
        className="mt-8"
        title={t.admin.system.discovery}
        description={t.admin.system.discoveryHelp}
      >
        <dl className="divide-y">
          {info.discovery.map((entry) => (
            <DetailRow key={entry.key} label={labelFor(t, entry.key)}>
              {/* A new tab, which is the first `target="_blank"` in the tree
                  and sets the convention for the admin area: these open a
                  JSON document, and two of them — the origin-root spellings
                  under a sub-path — are served by the *reverse proxy* above
                  this app's mount, so following one in place navigates out of
                  the application entirely and the back button is the only way
                  home. `rel="noreferrer"` because there is no reason to tell
                  the metadata document where the operator came from. */}
              <a
                href={entry.url}
                target="_blank"
                rel="noreferrer"
                className="hover:underline"
              >
                <code className="text-xs break-all">{entry.url}</code>
              </a>
            </DetailRow>
          ))}
        </dl>
      </AdminCard>

      <AdminCard className="mt-8" title={t.admin.system.keys}>
        <dl className="divide-y">
          <DetailRow label={t.admin.system.algorithm}>
            {info.signingKeys.algorithm}
          </DetailRow>
          <DetailRow label={t.admin.system.activeKey}>
            <code className="text-xs">
              {info.signingKeys.activeKeyId ?? "—"}
            </code>
          </DetailRow>
          <DetailRow label={t.admin.system.publishedKeys}>
            {info.signingKeys.published}
          </DetailRow>
        </dl>
        <PendingForm
          busy={t.common.loading}
          method="post"
          className="mt-4 grid gap-2"
        >
          <p className="text-xs text-muted-foreground">
            {t.admin.system.rotateHelp}
          </p>
          <SubmitButton variant="outline" className="justify-self-start">
            {t.admin.system.rotate}
          </SubmitButton>
        </PendingForm>
      </AdminCard>

      <AdminCard className="mt-8" title={t.admin.system.startup}>
        <ul className="grid gap-1 text-sm">
          {info.startup.steps.map((step) => (
            <li key={step.name} className="flex gap-2">
              <span className="font-medium">{step.name}</span>
              {step.skipped ? (
                <span className="text-muted-foreground">— {step.skipped}</span>
              ) : null}
            </li>
          ))}
        </ul>
        {info.reconcile ? (
          <>
            <h4 className="mt-4 mb-1 text-sm font-medium">
              {t.admin.system.reconcile}
            </h4>
            <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">
              {info.reconcile}
            </pre>
          </>
        ) : null}
      </AdminCard>

      {info.warnings.length > 0 ? (
        <AdminCard
          className="mt-8 ring-destructive/40"
          title={t.admin.system.warnings}
        >
          <ul className="grid gap-1 text-sm">
            {info.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </AdminCard>
      ) : null}

      <AdminCard
        className="mt-8"
        title={t.admin.system.config}
        description={t.admin.system.configHelp}
      >
        <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs">
          {info.config}
        </pre>
      </AdminCard>
    </AdminShell>
  )
}
