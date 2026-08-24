import { createFileRoute } from "@tanstack/react-router"
import { and, eq } from "drizzle-orm"

import { Button } from "@workspace/ui/components/button"

import {
  AccountSection,
  AccountShell,
} from "@/components/account/account-shell"
import { FormAlert } from "@/components/auth/form-parts"
import { messageForErrorCode, messageForNoticeCode } from "@/lib/auth-errors"
import { searchString } from "@/lib/search-params"
import { getCatalog } from "@/server/i18n"
import {
  readForm,
  redirectWithCookies,
  withError,
} from "@/server/http/auth-proxy"
import { readSession } from "@/server/http/session"
import { fetchConsents } from "@/server/functions/account"
import { APP_ROUTES } from "@/server/oidc/base-path"
import { getRuntime } from "@/server/runtime"

const HERE = "/account/consents"

/**
 * `/account/consents` — the applications you have allowed (FR-OIDC-10).
 *
 * Withdrawing consent deletes the grant, so the next authorization asks again.
 *
 * **The other half is M8b's.** FR-OIDC-10 also revokes *that client's* access
 * and refresh tokens, and the revoker (`server/oidc/revoke-user-tokens.ts`,
 * `revokeForClient({ userId, clientId })`) does not exist yet. The seam is the
 * marked line in the handler below: M9 wires the call there and nothing else
 * on this page changes. Until then a withdrawn consent stops new grants but
 * leaves an already-issued access token alive until it expires — which is why
 * the notice says what it says rather than promising more.
 */
export const Route = createFileRoute("/account/consents")({
  loader: async ({ context, location }) => {
    const search = location.search as Record<string, unknown>
    return {
      ui: context.ui,
      profile: context.profile,
      consents: (await fetchConsents()) ?? [],
      notice: searchString(search.notice),
      error: searchString(search.error),
    }
  },
  component: ConsentsPage,
  server: {
    handlers: {
      POST: async ({ request }) => {
        const runtime = await getRuntime()
        const base = runtime.config.base.basePath
        const here = `${base}${HERE}`

        const session = await readSession(runtime, request)
        if (!session) {
          return redirectWithCookies(
            `${base}${APP_ROUTES.login}?notice=signin_required`
          )
        }

        const form = await readForm(request)
        const clientId = form.clientId ?? ""
        if (clientId === "") {
          return redirectWithCookies(withError(here, "not_found"))
        }

        const { oauthConsent } = runtime.database.schema
        const deleted = await runtime.database.db
          .delete(oauthConsent)
          .where(
            and(
              eq(oauthConsent.userId, session.user.id),
              eq(oauthConsent.clientId, clientId)
            )
          )
          .returning({ id: oauthConsent.id })

        if (deleted.length === 0) {
          return redirectWithCookies(withError(here, "not_found"))
        }

        // M8b/M9 seam: `revokeForClient({ userId, clientId })` goes here, so
        // withdrawing consent also kills that client's live tokens.

        await runtime.audit.record({
          action: "consent.revoked",
          outcome: "success",
          actorType: "session",
          actorUserId: session.user.id,
          target: { type: "client", id: clientId },
        })

        return redirectWithCookies(`${here}?notice=consent_revoked`)
      },
    },
  },
})

function ConsentsPage() {
  const { ui, profile, consents, notice, error } = Route.useLoaderData()
  const t = getCatalog(ui.locale)

  return (
    <AccountShell
      ui={ui}
      t={t}
      title={t.account.consents.title}
      description={t.account.consents.description}
      impersonated={profile.impersonated}
    >
      <FormAlert variant="default">{messageForNoticeCode(notice, t)}</FormAlert>
      <FormAlert>{messageForErrorCode(error, t)}</FormAlert>

      <AccountSection
        title={t.account.consents.title}
        description={t.account.consents.revokeNotice}
      >
        {consents.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t.account.consents.empty}
          </p>
        ) : (
          <ul className="grid gap-3">
            {consents.map((consent) => (
              <li
                key={consent.clientId}
                className="flex flex-wrap items-center justify-between gap-3 border-b pb-3 last:border-0 last:pb-0"
              >
                <div className="text-sm">
                  <p className="font-medium">{consent.clientName}</p>
                  <p className="text-muted-foreground">
                    {t.account.consents.scopes}:{" "}
                    {consent.scopes
                      .map((scope) => t.consent.scopes[scope] ?? scope)
                      .join(", ")}
                  </p>
                </div>
                <form method="post">
                  <input
                    type="hidden"
                    name="clientId"
                    value={consent.clientId}
                  />
                  <Button type="submit" variant="outline" size="sm">
                    {t.account.consents.revoke}
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
