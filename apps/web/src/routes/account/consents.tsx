import { createFileRoute } from "@tanstack/react-router"
import { and, eq } from "drizzle-orm"

import {
  AccountSection,
  AccountShell,
} from "@/components/account/account-shell"
import { FormAlert } from "@/components/auth/form-parts"
import { NoticeToast } from "@/components/common/notice-toast"
import { messageForErrorCode, messageForNoticeCode } from "@/lib/auth-errors"
import { crumbTrail } from "@/components/common/breadcrumbs"
import { searchString } from "@/lib/search-params"
import { getCatalog } from "@/server/i18n"
import {
  readForm,
  redirectWithCookies,
  withError,
} from "@/server/http/auth-proxy"
import { requireSession } from "@/server/http/require-session"
import { assertSameOrigin } from "@/server/http/request-origin"
import { fetchGrants } from "@/server/functions/account"
import { revokeForClient } from "@/server/oidc/revoke-user-tokens"
import { getRuntime } from "@/server/runtime"
import { PendingForm, SubmitButton } from "@/components/common/pending-form"
import { LocalTime } from "@/components/common/local-time"

const HERE = "/account/consents"

/**
 * `/account/consents` — the applications you are connected to (FR-OIDC-10).
 *
 * **What this page can list, and what it cannot** (**D102**). A connection is
 * durable in one of two ways, and it shows both: a stored consent — the user
 * was asked and said yes — and a live refresh token, which lets an application
 * obtain new access tokens without the user being present. It used to list
 * only the first, which in this deployment is a list of nothing: file clients
 * default to `skipConsent: true`, a skipped consent writes no row, and the
 * page was therefore permanently empty however many applications the account
 * had signed in to. `oidc/grants.ts` computes the union.
 *
 * Three kinds of access are absent by construction, and the page says so in
 * one sentence rather than implying the list is complete:
 *
 *  - a `skipConsent` client that never asked for `offline_access` leaves no
 *    row at all. Its access token is a stateless JWT and its ability to act
 *    ends when that token expires — fifteen minutes by default (FR-OIDC-5);
 *  - an already-issued JWT access token cannot be recalled by anything here,
 *    for the same reason (FR-OIDC-12's documented caveat);
 *  - a consumer reaching a `/gateway/*` upstream, or one presenting an API
 *    key, holds no grant row either. An API key is revoked on
 *    `/account/api-keys`; the gateway's own key-to-JWT cache is reset on every
 *    revocation path, so a revocation made here still bites immediately.
 *
 * Disconnecting deletes the consent row, so the next authorization asks again,
 * and revokes that client's access and refresh tokens — **both, independently
 * of each other**. It used to answer `not_found` and stop the moment there was
 * no consent row to delete, which is precisely the case every client in this
 * deployment is in.
 */
export const Route = createFileRoute("/account/consents")({
  loader: async ({ context, location }) => {
    const search = location.search as Record<string, unknown>
    return {
      ui: context.ui,
      crumbs: crumbTrail(context.ui, (t) => [
        { label: t.account.nav.consents, to: "/account/consents" },
      ]),
      grants: (await fetchGrants()) ?? [],
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

        // Two gates this page never had. It writes to the database directly —
        // no `callAuth`, so Better Auth's origin check has never stood in
        // front of it — and it authorized that write from the cookie cache,
        // which answers with the session as it was up to five minutes ago.
        if (!assertSameOrigin(request)) {
          return redirectWithCookies(withError(here, "untrusted_origin"))
        }
        const signedIn = await requireSession(runtime, request, HERE)
        if (!signedIn.ok) return signedIn.response
        const userId = signedIn.session.user.id

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
              eq(oauthConsent.userId, userId),
              eq(oauthConsent.clientId, clientId)
            )
          )
          .returning({ id: oauthConsent.id })

        // FR-OIDC-10's other half, and **not** conditional on the delete
        // above having found anything: a `skipConsent` client has tokens and
        // no consent row, and this used to return `not_found` before reaching
        // here. Scoped to (user, client) — the other applications the user has
        // connected are not part of this decision, and a client id belonging
        // to someone else revokes only the caller's own nothing.
        const revoked = await revokeForClient(
          { database: runtime.database, audit: runtime.audit },
          { userId, clientId, reason: "consent_revoked" }
        )

        // Nothing of either kind existed: an unknown id, a client that was
        // never connected, or a second submit of a form that already
        // succeeded. SEC-7 keeps the three indistinguishable. A partial
        // failure — the delete lands, the revoke throws — self-heals on the
        // retry, which sees no consent and live tokens and succeeds.
        if (
          deleted.length === 0 &&
          revoked.refreshTokens === 0 &&
          revoked.accessTokens === 0
        ) {
          return redirectWithCookies(withError(here, "not_found"))
        }

        await runtime.audit.record({
          action: "consent.revoked",
          outcome: "success",
          actorType: "session",
          actorUserId: userId,
          target: { type: "client", id: clientId },
          metadata: {
            consentRows: deleted.length,
            refreshTokens: revoked.refreshTokens,
            accessTokens: revoked.accessTokens,
          },
        })

        return redirectWithCookies(`${here}?notice=consent_revoked`)
      },
    },
  },
})

function ConsentsPage() {
  const { ui, grants, notice, error } = Route.useLoaderData()
  const t = getCatalog(ui.locale)

  return (
    <AccountShell
      title={t.account.consents.title}
      description={`${t.account.consents.description} ${t.account.consents.transientNote}`}
    >
      <NoticeToast message={messageForNoticeCode(notice, t)} />
      <FormAlert>
        {messageForErrorCode(error, t, ui.passwordMinLength)}
      </FormAlert>

      <AccountSection
        title={t.account.consents.title}
        description={t.account.consents.revokeNotice}
      >
        {grants.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t.account.consents.empty}
          </p>
        ) : (
          <ul className="grid gap-3">
            {grants.map((grant) => (
              <li
                key={grant.clientId}
                className="flex flex-wrap items-center justify-between gap-3 border-b pb-3 last:border-0 last:pb-0"
              >
                <div className="text-sm">
                  <p className="font-medium">{grant.clientName}</p>
                  <p className="text-muted-foreground">
                    {t.account.consents.scopes}:{" "}
                    {grant.scopes
                      .map((scope) => t.consent.scopes[scope] ?? scope)
                      .join(", ")}
                  </p>
                  <p className="text-muted-foreground">
                    {t.account.consents.connectedOn}{" "}
                    <LocalTime iso={grant.connectedAt} variant="date" />
                  </p>
                </div>
                <PendingForm busy={t.common.loading} method="post">
                  <input type="hidden" name="clientId" value={grant.clientId} />
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
