import { createFileRoute, notFound } from "@tanstack/react-router"

import { Button } from "@workspace/ui/components/button"

import {
  AccountSection,
  AccountShell,
} from "@/components/account/account-shell"
import { FormAlert, TextField } from "@/components/auth/form-parts"
import { messageForErrorCode, messageForNoticeCode } from "@/lib/auth-errors"
import { searchString } from "@/lib/search-params"
import { getCatalog } from "@/server/i18n"
import {
  callAuth,
  errorCodeFor,
  readForm,
  redirectWithCookies,
  withError,
} from "@/server/http/auth-proxy"
import { requireFreshSession } from "@/server/http/fresh-session"
import { apiKeyBelongsTo, fetchApiKeys } from "@/server/functions/account"
import { getRuntime } from "@/server/runtime"

const HERE = "/account/api-keys"

/**
 * `/account/api-keys` (FR-KEY-1).
 *
 * A key authenticates **as its owner** with the same roles, so creating one is
 * as consequential as changing a password — both are gated on a fresh session
 * (FR-AUTH-5). The secret is shown exactly once, on the redirect that follows
 * creation, and never stored anywhere this page can read: the row keeps a hash
 * and the first few characters, which is all the list needs to be useful.
 *
 * Carrying the secret in the query string is deliberate and bounded: it is a
 * one-shot 303 to the user's own browser over the same connection that created
 * the key. What it must never be is persisted — so it is not put in a cookie,
 * a flash store or a log line, and a refresh loses it, which is the point.
 */
export const Route = createFileRoute("/account/api-keys")({
  loader: async ({ context, location }) => {
    // FR-KEY-1: with API keys off there is no page, not a hidden button.
    if (!context.ui.apiKeysEnabled) throw notFound()

    const search = location.search as Record<string, unknown>
    return {
      ui: context.ui,
      profile: context.profile,
      keys: (await fetchApiKeys()) ?? [],
      created: searchString(search.created),
      notice: searchString(search.notice),
      error: searchString(search.error),
    }
  },
  component: ApiKeysPage,
  server: {
    handlers: {
      POST: async ({ request }) => {
        const runtime = await getRuntime()
        const base = runtime.config.base.basePath
        const here = `${base}${HERE}`

        if (!runtime.config.file.apiKeys.enabled) {
          return new Response(null, { status: 404 })
        }

        // Both actions on this page are sensitive: one mints a credential,
        // the other takes one away from whoever is holding it.
        const fresh = await requireFreshSession(runtime, request, HERE)
        if (!fresh.ok) return fresh.response

        const form = await readForm(request)

        if (form.action === "revoke") {
          const keyId = form.keyId ?? ""
          // "The id came from a page I rendered" is not an authorisation
          // check — the ownership test is.
          if (!(await apiKeyBelongsTo(runtime, fresh.session, keyId))) {
            return redirectWithCookies(withError(here, "not_found"))
          }
          const result = await callAuth(
            runtime,
            "/api-key/delete",
            { keyId },
            request
          )
          if (!result.ok) {
            return redirectWithCookies(withError(here, errorCodeFor(result)))
          }
          await runtime.audit.record({
            action: "apikey.revoked",
            outcome: "success",
            actorType: "session",
            actorUserId: fresh.session.user.id,
            target: { type: "apikey", id: keyId },
          })
          return redirectWithCookies(`${here}?notice=apikey_revoked`)
        }

        const days = Number(form.expiresInDays ?? "")
        const maxDays = Math.floor(
          runtime.config.file.apiKeys.maxExpiresIn / 86_400
        )
        if (!Number.isInteger(days) || days < 1 || days > maxDays) {
          return redirectWithCookies(withError(here, "expiry_out_of_range"))
        }

        const result = await callAuth(
          runtime,
          "/api-key/create",
          {
            name: (form.name ?? "").trim(),
            expiresIn: days * 86_400,
          },
          request
        )

        if (!result.ok) {
          return redirectWithCookies(withError(here, errorCodeFor(result)))
        }

        const key = typeof result.body.key === "string" ? result.body.key : ""
        const id = typeof result.body.id === "string" ? result.body.id : ""
        await runtime.audit.record({
          action: "apikey.created",
          outcome: "success",
          actorType: "session",
          actorUserId: fresh.session.user.id,
          target: { type: "apikey", id },
          metadata: { name: (form.name ?? "").trim() },
        })
        await runtime.mailer.send("apiKeyCreated", fresh.session.user.email, {
          keyName: (form.name ?? "").trim(),
        })

        return redirectWithCookies(`${here}?created=${encodeURIComponent(key)}`)
      },
    },
  },
})

function ApiKeysPage() {
  const { ui, profile, keys, created, notice, error } = Route.useLoaderData()
  const t = getCatalog(ui.locale)
  const maxDays = Math.floor(ui.apiKeyMaxExpiresInDays)

  return (
    <AccountShell
      ui={ui}
      t={t}
      title={t.account.apiKeys.title}
      description={t.account.apiKeys.description}
      impersonated={profile.impersonated}
    >
      <FormAlert variant="default">{messageForNoticeCode(notice, t)}</FormAlert>
      <FormAlert>{messageForErrorCode(error, t)}</FormAlert>

      {created ? (
        <AccountSection
          title={t.account.apiKeys.create}
          description={t.account.apiKeys.neverShownAgain}
        >
          <code className="block overflow-x-auto rounded-lg bg-muted p-3 font-mono text-sm">
            {created}
          </code>
        </AccountSection>
      ) : null}

      <AccountSection title={t.account.apiKeys.create}>
        <form method="post" className="grid gap-4">
          <input type="hidden" name="action" value="create" />
          <TextField name="name" label={t.account.apiKeys.keyName} />
          <TextField
            name="expiresInDays"
            label={`${t.account.apiKeys.expiresIn} (${t.account.apiKeys.days})`}
            inputMode="numeric"
            defaultValue={String(Math.min(365, maxDays))}
            hint={t.account.apiKeys.expiryHint(maxDays)}
          />
          <div>
            <Button type="submit">{t.account.apiKeys.create}</Button>
          </div>
        </form>
      </AccountSection>

      <AccountSection title={t.account.apiKeys.title}>
        {keys.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t.account.apiKeys.empty}
          </p>
        ) : (
          <ul className="grid gap-3">
            {keys.map((key) => (
              <li
                key={key.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b pb-3 last:border-0 last:pb-0"
              >
                <div className="text-sm">
                  <p className="font-medium">
                    {key.name}
                    {key.start ? (
                      <span className="ml-2 font-mono text-xs text-muted-foreground">
                        {key.start}…
                      </span>
                    ) : null}
                  </p>
                  <p className="text-muted-foreground">
                    {t.account.apiKeys.created}{" "}
                    {formatDate(key.createdAt, ui.locale)} ·{" "}
                    {t.account.apiKeys.expires}{" "}
                    {key.expiresAt
                      ? formatDate(key.expiresAt, ui.locale)
                      : t.account.apiKeys.never}
                  </p>
                </div>
                <form method="post">
                  <input type="hidden" name="action" value="revoke" />
                  <input type="hidden" name="keyId" value={key.id} />
                  <Button type="submit" variant="outline" size="sm">
                    {t.account.apiKeys.revoke}
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </AccountSection>
    </AccountShell>
  )
}

function formatDate(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(
    new Date(value)
  )
}
