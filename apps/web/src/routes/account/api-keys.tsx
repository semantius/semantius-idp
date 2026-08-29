import { createFileRoute, notFound } from "@tanstack/react-router"

import {
  AccountSection,
  AccountShell,
} from "@/components/account/account-shell"
import { ActionDialog, SecretDialog } from "@/components/common/dialogs"
import { FormAlert, TextField } from "@/components/auth/form-parts"
import { NoticeToast } from "@/components/common/notice-toast"
import { messageForErrorCode, messageForNoticeCode } from "@/lib/auth-errors"
import { crumbTrail } from "@/components/common/breadcrumbs"
import { searchString } from "@/lib/search-params"
import { getCatalog } from "@/server/i18n"
import {
  callAuth,
  errorCodeFor,
  readForm,
  redirectWithCookies,
  withError,
} from "@/server/http/auth-proxy"
import { requireSession } from "@/server/http/require-session"
import { stash } from "@/server/http/one-shot"
import {
  apiKeyBelongsTo,
  claimApiKeySecret,
  fetchApiKeys,
} from "@/server/functions/account"
import { getRuntime } from "@/server/runtime"
import { PendingForm, SubmitButton } from "@/components/common/pending-form"
import { LocalTime } from "@/components/common/local-time"

const HERE = "/account/api-keys"

/**
 * `/account/api-keys` (FR-KEY-1).
 *
 * A key authenticates **as its owner** with the same roles, so creating one is
 * as consequential as changing a password. Both were gated on a fresh session
 * until **D81**; both now require a session and no more than that. The secret
 * is shown exactly once, in a dialog on the page the
 * creation redirects to, and never stored anywhere this page can read: the row
 * keeps a hash and the first few characters, which is all the list needs to be
 * useful.
 *
 * **The secret does not travel in the URL.** It used to — `?created=<key>` —
 * and that was wrong for the reasons `server/http/one-shot.ts` was written to
 * state: a query string survives in browser history, in `Referer` on the next
 * outbound request, and in every proxy log in between. So the POST stashes the
 * key server-side, the redirect carries an opaque handle, and the loader
 * claims it. Claiming consumes it, so a reload shows the page without the key
 * — which is what "shown once" has to mean.
 */
export const Route = createFileRoute("/account/api-keys")({
  loader: async ({ context, location }) => {
    // FR-KEY-1: with API keys off there is no page, not a hidden button.
    if (!context.ui.apiKeysEnabled) throw notFound()

    const search = location.search as Record<string, unknown>
    return {
      ui: context.ui,
      crumbs: crumbTrail(context.ui, (t) => [
        { label: t.account.nav.apiKeys, to: "/account/api-keys" },
      ]),
      keys: (await fetchApiKeys()) ?? [],
      // Claimed, and therefore consumed: this is the only render that can
      // show it. `undefined` for a handle that is unknown, already claimed or
      // expired — all three are the same answer.
      created: await claimApiKeySecret({
        data: searchString(search.created) ?? "",
      }),
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
        const signedIn = await requireSession(runtime, request, HERE)
        if (!signedIn.ok) return signedIn.response

        const form = await readForm(request)

        if (form.action === "revoke") {
          const keyId = form.keyId ?? ""
          // "The id came from a page I rendered" is not an authorization
          // check — the ownership test is.
          if (!(await apiKeyBelongsTo(runtime, signedIn.session, keyId))) {
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
            actorUserId: signedIn.session.user.id,
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
          actorUserId: signedIn.session.user.id,
          target: { type: "apikey", id },
          metadata: { name: (form.name ?? "").trim() },
        })
        await runtime.mailer.send("apiKeyCreated", signedIn.session.user.email, {
          keyName: (form.name ?? "").trim(),
        })

        // The handle, never the key (SEC — see the module header). Ten minutes
        // is far longer than the redirect needs and short enough that an
        // abandoned tab leaves nothing claimable for long.
        const handle = await stash(
          runtime,
          JSON.stringify({ userId: signedIn.session.user.id, key }),
          { ttlSeconds: 600 }
        )
        return redirectWithCookies(`${here}?created=${handle}`)
      },
    },
  },
})

function ApiKeysPage() {
  const { ui, keys, created, notice, error } = Route.useLoaderData()
  const t = getCatalog(ui.locale)
  const maxDays = Math.floor(ui.apiKeyMaxExpiresInDays)

  return (
    <AccountShell
      title={t.account.apiKeys.title}
      description={t.account.apiKeys.description}
    >
      <NoticeToast message={messageForNoticeCode(notice, t)} />
      <FormAlert>
        {messageForErrorCode(error, t, ui.passwordMinLength)}
      </FormAlert>

      {/* Opened on arrival, and this is the only render that has the value:
          the loader claimed it, which consumed it. */}
      {created ? (
        <SecretDialog
          t={t}
          title={t.account.apiKeys.title}
          description={t.account.apiKeys.neverShownAgain}
          value={created}
        />
      ) : null}

      <AccountSection title={t.account.apiKeys.title}>
        <div className="mb-4">
          <ActionDialog
            label={t.account.apiKeys.create}
            variant="default"
            size="default"
          >
            {/* A plain form post, exactly as it was inline: the dialog decides
                what is on screen, never how the submission travels. */}
            <PendingForm
              busy={t.common.loading}
              method="post"
              className="grid gap-4"
            >
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
                <SubmitButton>{t.account.apiKeys.create}</SubmitButton>
              </div>
            </PendingForm>
          </ActionDialog>
        </div>

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
                    <LocalTime iso={key.createdAt} variant="date" /> ·{" "}
                    {t.account.apiKeys.expires}{" "}
                    {key.expiresAt ? (
                      <LocalTime iso={key.expiresAt} variant="date" />
                    ) : (
                      t.account.apiKeys.never
                    )}
                  </p>
                </div>
                <PendingForm busy={t.common.loading} method="post">
                  <input type="hidden" name="action" value="revoke" />
                  <input type="hidden" name="keyId" value={key.id} />
                  <SubmitButton variant="outline" size="sm">
                    {t.account.apiKeys.revoke}
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
