import { createFileRoute } from "@tanstack/react-router"

import { AuthShell } from "@/components/auth/auth-shell"
import { messageForErrorCode } from "@/lib/auth-errors"
import { searchString } from "@/lib/search-params"
import { getCatalog } from "@/server/i18n"

/**
 * `/error` — where an authorization request goes when it cannot go back
 *.
 *
 * OAuth errors are normally *redirected* to the client, with `error` and
 * `state` in the query. That is only safe once the `redirect_uri` has been
 * validated against the client's registration — before that, redirecting is
 * how an authorization code gets stolen, and an unknown client or an
 * unregistered URI has to be shown to the user instead.
 *
 * So this page is the terminal for exactly those cases. It says what went
 * wrong in the deployment's own words and offers no link onward: whatever the
 * request named cannot be trusted, and the only safe next step is the one the
 * user chooses from their own browser.
 *
 * The `error` parameter is a **code**, never a message. Rendering an
 * attacker-supplied `error_description` here would put their words on the
 * IdP's own page under the IdP's own branding.
 */
export const Route = createFileRoute("/error")({
  loader: ({ context, location }) => {
    const search = location.search as Record<string, unknown>
    return {
      ui: context.ui,
      error: searchString(search.error),
      retryAfter: searchString(search.retry_after),
    }
  },
  component: ErrorPage,
})

function ErrorPage() {
  const { ui, error, retryAfter } = Route.useLoaderData()
  const t = getCatalog(ui.locale)

  // 429 gets its own wording because "try again" is actionable and the others
  // are not. The threshold itself is never shown.
  const rateLimited = error === "rate_limited"

  return (
    <AuthShell
      ui={ui}
      title={rateLimited ? t.errors.rateLimited.title : t.errors.oauth.title}
      description={rateLimited ? undefined : t.errors.oauth.description}
    >
      <p className="text-sm text-muted-foreground">
        {explain(error, t, ui.passwordMinLength)}
      </p>
      {rateLimited && retryAfter ? (
        <p className="mt-2 text-sm text-muted-foreground">
          {t.errors.rateLimited.retryAfter(Number(retryAfter))}
        </p>
      ) : null}
    </AuthShell>
  )
}

/**
 * The OAuth-specific wording, falling back to the shared error catalog.
 *
 * The codes are the ones the provider emits plus the two this app adds when it
 * refuses to redirect at all.
 */
function explain(
  error: string | undefined,
  t: ReturnType<typeof getCatalog>,
  passwordMinLength: number
): string {
  switch (error) {
    case "invalid_client":
    case "unauthorized_client":
      return t.errors.oauth.unknownClient
    case "invalid_redirect":
    case "invalid_redirect_uri":
      return t.errors.oauth.invalidRedirect
    // Two codes, two sentences: `expired` is what `/consent` sends when the
    // signed request's `exp` had passed, and `invalid_request` is everything
    // else the provider refused. They used to share the "took too long"
    // wording, which told a user with a tampered or re-serialized request to
    // hurry (D130).
    case "expired":
      return t.errors.oauth.expired
    case "invalid_request":
      return t.errors.oauth.invalidRequest
    default:
      return (
        messageForErrorCode(error, t, passwordMinLength) ??
        t.errors.rateLimited.description
      )
  }
}
