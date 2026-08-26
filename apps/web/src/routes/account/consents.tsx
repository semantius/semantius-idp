import { createFileRoute } from "@tanstack/react-router"
import { and, eq } from "drizzle-orm"

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
import { revokeForClient } from "@/server/oidc/revoke-user-tokens"
import { getRuntime } from "@/server/runtime"
import { PendingForm, SubmitButton } from "@/components/common/pending-form"

const HERE = "/account/consents"

/**
 * `/account/consents` — the applications you have allowed (FR-OIDC-10).
 *
 * Withdrawing consent deletes the grant, so the next authorization asks again.
 *
 * Withdrawing also revokes that client's access and refresh tokens
 * (FR-OIDC-10). A JWT access token already issued still verifies against the
 * JWKS until it expires — that is inherent to stateless verification, and is
 * why `oauth.accessTokenTtl` defaults to fifteen minutes — but no new one can
 * be obtained, and the refresh token is dead immediately.
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

        // FR-OIDC-10's other half: the grant is gone, and so is what it
        // bought. Scoped to this client — the other applications the user has
        // connected are not part of this decision.
        await revokeForClient(
          { database: runtime.database, audit: runtime.audit },
          { userId: session.user.id, clientId, reason: "consent_revoked" }
        )

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
      isAdmin={profile.isAdmin}
    >
      <FormAlert variant="default">{messageForNoticeCode(notice, t)}</FormAlert>
      <FormAlert>
        {messageForErrorCode(error, t, ui.passwordMinLength)}
      </FormAlert>

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
                <PendingForm busy={t.common.loading} method="post">
                  <input
                    type="hidden"
                    name="clientId"
                    value={consent.clientId}
                  />
                  <SubmitButton variant="outline" size="sm">
                    {t.account.consents.revoke}
                  </SubmitButton>
                </PendingForm>
              </li>
            ))}
          </ul>
        )}
      </AccountSection>
    </AccountShell>
  )
}
