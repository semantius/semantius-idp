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
  callAuth,
  errorCodeFor,
  readForm,
  redirectWithCookies,
  withError,
} from "@/server/http/auth-proxy"
import { requireFreshSession } from "@/server/http/fresh-session"
import { readSession } from "@/server/http/session"
import { fetchSessions } from "@/server/functions/account"
import { APP_ROUTES } from "@/server/oidc/base-path"
import { getRuntime } from "@/server/runtime"
import type { Runtime } from "@/server/runtime"
import { PendingForm, SubmitButton } from "@/components/common/pending-form"
import { LocalTime } from "@/components/common/local-time"

const HERE = "/account/sessions"

/**
 * `/account/sessions` — every live session, and how to end one (FR-ACCT-1).
 *
 * Signing out one device is not a sensitive action: the worst a stranger with
 * the browser can do is inconvenience you, and requiring a re-authentication
 * to *reduce* access would be backwards. Signing out **everywhere else** is
 * different — it is the move someone makes to lock the real owner out — so
 * that one goes through the freshness gate (FR-AUTH-5).
 */
export const Route = createFileRoute("/account/sessions")({
  loader: async ({ context, location }) => {
    const search = location.search as Record<string, unknown>
    return {
      ui: context.ui,
      profile: context.profile,
      sessions: (await fetchSessions()) ?? [],
      notice: searchString(search.notice),
      error: searchString(search.error),
    }
  },
  component: SessionsPage,
  server: {
    handlers: {
      POST: async ({ request }) => {
        const runtime = await getRuntime()
        const base = runtime.config.base.basePath
        const here = `${base}${HERE}`
        const form = await readForm(request)
        const all = form.scope === "others"

        if (all) {
          const fresh = await requireFreshSession(runtime, request, HERE)
          if (!fresh.ok) return fresh.response
        } else {
          const session = await readSession(runtime, request)
          if (!session) {
            return redirectWithCookies(
              `${base}${APP_ROUTES.login}?notice=signin_required`
            )
          }
        }

        let result
        if (all) {
          result = await callAuth(
            runtime,
            "/revoke-other-sessions",
            {},
            request
          )
        } else {
          // The form carries the session **id**, never the token: a token is a
          // live credential and rendering one into HTML would hand every
          // session on the page to anything that can read the document. The
          // lookup is scoped to the caller, so an id from someone else's
          // account resolves to nothing.
          const token = await tokenForOwnSession(
            runtime,
            request,
            form.sessionId ?? ""
          )
          if (!token) return redirectWithCookies(withError(here, "not_found"))
          result = await callAuth(
            runtime,
            "/revoke-session",
            { token },
            request
          )
        }

        if (!result.ok) {
          return redirectWithCookies(withError(here, errorCodeFor(result)))
        }
        return redirectWithCookies(
          `${here}?notice=session_revoked`,
          result.cookies
        )
      },
    },
  },
})

function SessionsPage() {
  const { ui, profile, sessions, notice, error } = Route.useLoaderData()
  const t = getCatalog(ui.locale)
  const others = sessions.filter((session) => !session.current)

  return (
    <AccountShell
      ui={ui}
      t={t}
      title={t.account.sessions.title}
      description={t.account.sessions.description}
      impersonated={profile.impersonated}
      isAdmin={profile.isAdmin}
    >
      <FormAlert variant="default">{messageForNoticeCode(notice, t)}</FormAlert>
      <FormAlert>
        {messageForErrorCode(error, t, ui.passwordMinLength)}
      </FormAlert>

      <AccountSection title={t.account.sessions.title}>
        {sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t.account.sessions.empty}
          </p>
        ) : (
          <ul className="grid gap-3">
            {sessions.map((session) => (
              <li
                key={session.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b pb-3 last:border-0 last:pb-0"
              >
                <div className="text-sm">
                  <p className="font-medium">
                    {session.userAgent ?? t.account.sessions.unknownDevice}
                    {session.current ? (
                      // Muted text on `bg-muted` is the one pairing in this
                      // palette that does not clear 4.5:1 — axe called it, and
                      // it is the badge that tells someone which of the
                      // sessions is the one they are reading it on.
                      <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-foreground">
                        {t.account.sessions.current}
                      </span>
                    ) : null}
                  </p>
                  <p className="text-muted-foreground">
                    {t.account.sessions.signedIn}{" "}
                    <LocalTime iso={session.createdAt} />
                    {session.ipAddress ? ` · ${session.ipAddress}` : ""}
                  </p>
                </div>
                {session.current ? null : (
                  <PendingForm busy={t.common.loading} method="post">
                    <input type="hidden" name="scope" value="one" />
                    <input type="hidden" name="sessionId" value={session.id} />
                    <SubmitButton variant="outline" size="sm">
                      {t.account.sessions.revoke}
                    </SubmitButton>
                  </PendingForm>
                )}
              </li>
            ))}
          </ul>
        )}
      </AccountSection>

      {others.length > 0 ? (
        <AccountSection title={t.account.sessions.revokeAll}>
          <PendingForm busy={t.common.loading} method="post">
            <input type="hidden" name="scope" value="others" />
            <SubmitButton variant="outline">
              {t.account.sessions.revokeAll}
            </SubmitButton>
          </PendingForm>
        </AccountSection>
      ) : null}
    </AccountShell>
  )
}

/**
 * The token of one of the caller's own sessions, or `undefined`.
 *
 * Scoping the lookup to `userId` is the authorisation check: without it the
 * form would revoke any session whose id someone could guess or observe.
 */
async function tokenForOwnSession(
  runtime: Runtime,
  request: Request,
  sessionId: string
): Promise<string | undefined> {
  if (sessionId === "") return undefined
  const current = await readSession(runtime, request)
  if (!current) return undefined

  const { session } = runtime.database.schema
  const [row] = await runtime.database.db
    .select({ token: session.token })
    .from(session)
    .where(and(eq(session.id, sessionId), eq(session.userId, current.user.id)))
    .limit(1)
  return row?.token
}
