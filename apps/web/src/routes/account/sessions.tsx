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
  callAuth,
  errorCodeFor,
  readForm,
  redirectWithCookies,
  withError,
} from "@/server/http/auth-proxy"
import { requireSession } from "@/server/http/require-session"
import { assertSameOrigin } from "@/server/http/request-origin"
import { fetchSessions } from "@/server/functions/account"
import {
  revokeForOtherSessions,
  revokeForSession,
} from "@/server/oidc/revoke-user-tokens"
import { getRuntime } from "@/server/runtime"
import type { Runtime } from "@/server/runtime"
import { Badge } from "@workspace/ui/components/badge"
import { PendingForm, SubmitButton } from "@/components/common/pending-form"
import { LocalTime } from "@/components/common/local-time"

const HERE = "/account/sessions"

/**
 * `/account/sessions` — every live session, and how to end one (FR-ACCT-1).
 *
 * Both scopes require a session; neither requires a recent one. Signing out
 * **everywhere else** used to sit behind the freshness gate, on the reasoning
 * that it is the move someone makes to lock the real owner out — but the gate
 * itself is gone (**D81**), and the read is authoritative rather than cached,
 * which is the property that actually mattered here.
 *
 * **Signing a session out revokes the OAuth tokens it obtained, always**
 * (**D101**). `session.revokeOAuthTokensOnLogout` governs *logout* — closing
 * the tab on a laptop is not a statement about every application the user
 * signed in to, which is the whole SSO argument for its `false` default. This
 * page is the opposite statement: it exists to cut a device off, and a device
 * whose app goes on refreshing tokens for another thirty days is not cut off.
 * The administrator's equivalent has cascaded since **D67**, and self-service
 * being weaker than admin for the same act is not a defensible split.
 *
 * The revocation runs **before** Better Auth deletes the row. Both token
 * tables reference `session_id` with `on delete set null`, so afterwards there
 * is nothing left to scope on. The order is fail-secure the way round it is:
 * if the delete then fails, the tokens are dead and the session lives, and the
 * retry is a counted no-op.
 *
 * That ordering is also why the two gates below come first. Better Auth's own
 * origin check runs inside `callAuth`, which is now *after* the destructive
 * part, and so does the authoritative read its `sensitiveSessionMiddleware`
 * did — neither stands in front of anything any more, so this handler does
 * both itself.
 */
export const Route = createFileRoute("/account/sessions")({
  loader: async ({ context, location }) => {
    const search = location.search as Record<string, unknown>
    return {
      ui: context.ui,
      crumbs: crumbTrail(context.ui, (t) => [
        { label: t.account.nav.sessions, to: "/account/sessions" },
      ]),
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

        // Before a form field is read, let alone a row written.
        if (!assertSameOrigin(request)) {
          return redirectWithCookies(withError(here, "untrusted_origin"))
        }
        const signedIn = await requireSession(runtime, request, HERE)
        if (!signedIn.ok) return signedIn.response
        const userId = signedIn.session.user.id

        const form = await readForm(request)
        const deps = { database: runtime.database, audit: runtime.audit }
        const reason = "session_revoked_by_user"

        let result
        if (form.scope === "others") {
          await revokeForOtherSessions(deps, {
            userId,
            currentSessionId: signedIn.session.session.id,
            reason,
          })
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
          // account resolves to nothing — which is the authorization check,
          // and it happens before the revocation acts on the id.
          const sessionId = form.sessionId ?? ""
          const token = await tokenForOwnSession(runtime, userId, sessionId)
          if (!token) return redirectWithCookies(withError(here, "not_found"))
          await revokeForSession(deps, { sessionId, userId, reason })
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
      title={t.account.sessions.title}
      description={t.account.sessions.description}
    >
      <NoticeToast
        message={messageForNoticeCode(notice, t)}
        subject={profile.email}
      />
      <FormAlert>
        {messageForErrorCode(error, t, ui.passwordMinLength)}
      </FormAlert>

      <AccountSection
        title={t.account.sessions.title}
        description={t.account.sessions.revokeNotice}
      >
        {sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t.account.sessions.empty}
          </p>
        ) : (
          // A hook of its own, because `main li` is no longer only these:
          // the breadcrumb is an `<ol>` of `<li>` inside the same `<main>`
          // (**D93**), the way the sidebar footer is inside the same page.
          <ul data-slot="session-list" className="grid gap-3">
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
                    {/* FR-ADMIN-5 from the user's side: an administrator
                        signed in as them is a session on this list, and
                        without this it reads as an unrecognized device. */}
                    {session.impersonated ? (
                      <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-foreground">
                        {t.account.sessions.impersonated}
                      </span>
                    ) : null}
                  </p>
                  <p className="text-muted-foreground">
                    {t.account.sessions.signedIn}{" "}
                    <LocalTime iso={session.createdAt} />
                    {session.ipAddress ? ` · ${session.ipAddress}` : ""}
                  </p>
                  <p className="text-muted-foreground">
                    {t.account.sessions.lastActive}{" "}
                    <LocalTime iso={session.lastActiveAt} />
                  </p>
                  {/* Names only. Everything else about a token stays on the
                      server — this line exists so "sign out" can say what it
                      is about to disconnect. */}
                  {session.clients.length > 0 ? (
                    <p className="mt-1 flex flex-wrap items-center gap-1">
                      <span className="text-muted-foreground">
                        {t.account.sessions.connectedApps}
                      </span>
                      {session.clients.map((client) => (
                        <Badge key={client} variant="outline">
                          {client}
                        </Badge>
                      ))}
                    </p>
                  ) : null}
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
 * Scoping the lookup to `userId` is the authorization check: without it the
 * form would revoke any session whose id someone could guess or observe. The
 * owner is passed in rather than re-read here — the handler has already
 * resolved it *authoritatively*, and reading it again from the cookie cache
 * would quietly put back the five-minute window this page must not have.
 */
async function tokenForOwnSession(
  runtime: Runtime,
  userId: string,
  sessionId: string
): Promise<string | undefined> {
  if (sessionId === "") return undefined

  const { session } = runtime.database.schema
  const [row] = await runtime.database.db
    .select({ token: session.token })
    .from(session)
    .where(and(eq(session.id, sessionId), eq(session.userId, userId)))
    .limit(1)
  return row?.token
}
