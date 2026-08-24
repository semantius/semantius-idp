import { createFileRoute } from "@tanstack/react-router"

import { Button } from "@workspace/ui/components/button"

import { AuthShell } from "@/components/auth/auth-shell"
import { FormAlert } from "@/components/auth/form-parts"
import { messageForErrorCode } from "@/lib/auth-errors"
import { readOauthQuery } from "@/lib/oauth-query"
import { searchString } from "@/lib/search-params"
import { getCatalog } from "@/server/i18n"
import {
  readForm,
  redirectWithCookies,
  withError,
} from "@/server/http/auth-proxy"
import { readSession } from "@/server/http/session"
import { OAUTH_QUERY_FIELD } from "@/server/oidc/continuation"
import { APP_ROUTES, createBasePaths } from "@/server/oidc/base-path"
import { getRuntime } from "@/server/runtime"
import { fetchConsentRequest } from "@/server/functions/consent"

/**
 * `/consent` — what an application is asking for, and the decision (FR-OIDC-9,
 * FR-OIDC-10).
 *
 * The provider sends the user here with the whole authorization request signed
 * into the query string; this page reads the client id and scopes out of it to
 * decide what to *show*, and hands the string back untouched for the provider
 * to verify. Reading it is safe and verifying it is not this page's job — a
 * tampered request produces a wrong-looking consent screen and then fails at
 * `POST /oauth2/consent`, which is where it should fail.
 *
 * Only reached when the client has `skipConsent: false` or the request carries
 * `prompt=consent`; file-configured clients skip it by default because an
 * administrator already decided (FR-OIDC-3).
 *
 * The decision is bound to both the signed request **and** the session: the
 * POST goes through `/oauth2/consent`, which requires a session, so a consent
 * screen left open in one browser cannot be submitted from another.
 */
export const Route = createFileRoute("/consent")({
  loader: async ({ context, location }) => {
    const search = location.search as Record<string, unknown>
    return {
      ui: context.ui,
      request: await fetchConsentRequest({
        data: readOauthQuery({ search, searchStr: location.searchStr }) ?? "",
      }),
      error: searchString(search.error),
    }
  },
  component: ConsentPage,
  server: {
    handlers: {
      POST: async ({ request }) => {
        const runtime = await getRuntime()
        const paths = createBasePaths(runtime.config.base)
        const form = await readForm(request)
        const oauthQuery = form[OAUTH_QUERY_FIELD] ?? ""
        const accept = form.decision === "allow"

        const session = await readSession(runtime, request)
        if (!session) {
          return redirectWithCookies(
            `${paths.basePath}${APP_ROUTES.login}?notice=signin_required`
          )
        }

        const response = await runtime.auth.handler(
          new Request(`${paths.authBaseUrl}/oauth2/consent`, {
            method: "POST",
            headers: consentHeaders(request),
            body: JSON.stringify({
              accept,
              [OAUTH_QUERY_FIELD]: oauthQuery,
            }),
          })
        )

        // 1.7.1 answers `{ redirect: true, url }`; its own OpenAPI text says
        // `redirect_uri`. Both are read, because a version that changes its
        // mind should not silently produce a page that redirects nowhere.
        const body = (await response.json().catch(() => ({}))) as {
          url?: unknown
          redirect_uri?: unknown
        }
        const destination = [body.url, body.redirect_uri].find(
          (value): value is string => typeof value === "string" && value !== ""
        )

        if (!response.ok || !destination) {
          // An expired or tampered request cannot be redirected anywhere the
          // client named, so it lands on our own error page instead.
          return redirectWithCookies(
            withError(`${paths.basePath}${APP_ROUTES.error}`, "invalid_request")
          )
        }

        await runtime.audit.record({
          action: "consent.granted",
          outcome: accept ? "success" : "denied",
          actorType: "session",
          actorUserId: session.user.id,
          metadata: { clientId: form.clientId ?? null },
        })

        return redirectWithCookies(destination)
      },
    },
  },
})

/** JSON in, JSON out, with the caller's own session and origin. */
function consentHeaders(request: Request): Headers {
  const headers = new Headers()
  headers.set("content-type", "application/json")
  headers.set("accept", "application/json")
  const cookie = request.headers.get("cookie")
  if (cookie) headers.set("cookie", cookie)
  const origin = request.headers.get("origin")
  if (origin) headers.set("origin", origin)
  return headers
}

function ConsentPage() {
  const { ui, request, error } = Route.useLoaderData()
  const t = getCatalog(ui.locale)

  if (!request) {
    return (
      <AuthShell ui={ui} title={t.errors.serverError.title}>
        <p className="text-sm text-muted-foreground">
          {t.errors.serverError.description}
        </p>
      </AuthShell>
    )
  }

  return (
    <AuthShell
      ui={ui}
      title={t.consent.title(request.clientName)}
      description={t.consent.description}
    >
      <FormAlert>{messageForErrorCode(error, t)}</FormAlert>

      {request.clientUri || request.tos || request.policy ? (
        <p className="mb-4 flex flex-wrap gap-3 text-sm text-muted-foreground">
          {request.clientUri ? (
            <a
              href={request.clientUri}
              className="underline underline-offset-4"
            >
              {request.clientName}
            </a>
          ) : null}
          {request.tos ? (
            <a href={request.tos} className="underline underline-offset-4">
              {t.consent.terms}
            </a>
          ) : null}
          {request.policy ? (
            <a href={request.policy} className="underline underline-offset-4">
              {t.consent.privacy}
            </a>
          ) : null}
        </p>
      ) : null}

      <ul className="mb-6 grid gap-2 text-sm">
        {request.scopes.map((scope) => (
          <li key={scope} className="flex gap-2">
            <span aria-hidden="true">·</span>
            <span>{t.consent.scopes[scope] ?? scope}</span>
          </li>
        ))}
      </ul>

      {/* Two submit buttons in one form, so the decision travels with the
          request rather than depending on which URL was posted to. */}
      <form method="post" className="grid gap-3 sm:grid-cols-2">
        <input
          type="hidden"
          name={OAUTH_QUERY_FIELD}
          value={request.oauthQuery}
        />
        <input type="hidden" name="clientId" value={request.clientId} />
        <Button type="submit" name="decision" value="deny" variant="outline">
          {t.consent.deny}
        </Button>
        <Button type="submit" name="decision" value="allow">
          {t.consent.allow}
        </Button>
      </form>
    </AuthShell>
  )
}
