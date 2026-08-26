import { createFileRoute } from "@tanstack/react-router"

import {
  callAuth,
  redirectWithCookies,
  withError,
} from "@/server/http/auth-proxy"
import { APP_ROUTES } from "@/server/oidc/base-path"
import { getRuntime } from "@/server/runtime"

/**
 * Ending an impersonation (FR-ADMIN-5, SEC-6, **D66**).
 *
 * **POST only**, for the same reason `/logout` is: a GET that changes a
 * session lets any page do it with an `<img>` tag. There is no page here —
 * the control is the button in the impersonation banner, which is on every
 * screen an impersonated session can reach.
 *
 * It exists because the endpoint had no caller. `impersonation.stopped` was
 * in SEC-6's list and in the `AuditAction` union and was never written by
 * anything: an impersonation ended by expiring after an hour or by signing
 * out, and neither goes through `/admin/stop-impersonating`. Wiring the audit
 * hook alone would have recorded an event that never happens, so the control
 * comes with it — the row is then the guard's, like every other `/admin/*`
 * write.
 *
 * Better Auth restores the administrator's own session, so the redirect goes
 * to `/admin` and the replayed `Set-Cookie` is what makes it theirs again.
 */
export const Route = createFileRoute("/stop-impersonating")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const runtime = await getRuntime()
        const base = runtime.config.base.basePath

        const result = await callAuth(
          runtime,
          "/admin/stop-impersonating",
          {},
          request
        )
        if (!result.ok) {
          // Nothing to be done about it from here, and the caller is on
          // somebody else's account: send them to their own area with the
          // refusal named rather than leaving them on a blank response.
          return redirectWithCookies(
            withError(`${base}${APP_ROUTES.account}`, "not_found")
          )
        }

        return redirectWithCookies(
          `${base}${APP_ROUTES.admin}`,
          result.cookies
        )
      },
    },
  },
})
