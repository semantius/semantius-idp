import { createFileRoute } from "@tanstack/react-router"

import { Button } from "@workspace/ui/components/button"

import { AdminShell, Field } from "@/components/admin/admin-shell"
import { FormAlert } from "@/components/auth/form-parts"
import { messageForErrorCode } from "@/lib/auth-errors"
import { searchString } from "@/lib/search-params"
import { getCatalog } from "@/server/i18n"
import {
  callAuth,
  errorCodeFor,
  redirectWithCookies,
} from "@/server/http/auth-proxy"
import { requireFreshSession } from "@/server/http/fresh-session"
import { fetchSystemInfo } from "@/server/functions/admin"
import { getRuntime } from "@/server/runtime"

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
            : { error: errorCodeFor(result) }
        )
        return redirectWithCookies(`${here}?${query.toString()}`)
      },
    },
  },
})

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
      <FormAlert>{messageForErrorCode(error, t)}</FormAlert>
      {rotated ? (
        <p role="status" className="mb-4 text-sm">
          {t.admin.system.rotated(rotated)}
        </p>
      ) : null}

      <section className="rounded-lg border bg-card p-4">
        <dl className="divide-y">
          <Field label={t.admin.system.version}>{info.version}</Field>
          {info.revision ? (
            <Field label={t.admin.system.revision}>{info.revision}</Field>
          ) : null}
          <Field label={t.admin.system.issuer}>
            <code className="text-xs">{info.issuer}</code>
          </Field>
          <Field label={t.admin.system.email}>
            {info.email.enabled
              ? t.admin.system.emailOn(info.email.transport)
              : t.admin.system.emailOff}
          </Field>
        </dl>
      </section>

      <section className="mt-8 rounded-lg border bg-card p-4">
        <h3 className="mb-2 text-sm font-medium">{t.admin.system.keys}</h3>
        <dl className="divide-y">
          <Field label={t.admin.system.algorithm}>
            {info.signingKeys.algorithm}
          </Field>
          <Field label={t.admin.system.activeKey}>
            <code className="text-xs">
              {info.signingKeys.activeKeyId ?? "—"}
            </code>
          </Field>
          <Field label={t.admin.system.publishedKeys}>
            {info.signingKeys.published}
          </Field>
        </dl>
        <form method="post" className="mt-4 grid gap-2">
          <p className="text-xs text-muted-foreground">
            {t.admin.system.rotateHelp}
          </p>
          <Button
            type="submit"
            variant="outline"
            className="justify-self-start"
          >
            {t.admin.system.rotate}
          </Button>
        </form>
      </section>

      <section className="mt-8 rounded-lg border bg-card p-4">
        <h3 className="mb-2 text-sm font-medium">{t.admin.system.startup}</h3>
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
      </section>

      {info.warnings.length > 0 ? (
        <section className="mt-8 rounded-lg border border-destructive/40 p-4">
          <h3 className="mb-2 text-sm font-medium">
            {t.admin.system.warnings}
          </h3>
          <ul className="grid gap-1 text-sm">
            {info.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mt-8">
        <h3 className="mb-1 text-sm font-medium">{t.admin.system.config}</h3>
        <p className="mb-2 text-xs text-muted-foreground">
          {t.admin.system.configHelp}
        </p>
        <pre className="overflow-x-auto rounded-lg border bg-card p-4 text-xs">
          {info.config}
        </pre>
      </section>
    </AdminShell>
  )
}
