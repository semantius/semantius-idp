import { createFileRoute, redirect } from "@tanstack/react-router"

import { fetchProfile } from "@/server/functions/account"
import { APP_ROUTES } from "@/server/oidc/base-path"

/**
 * `/` has nothing of its own to show.
 *
 * An identity provider's root is not a landing page: someone who arrives here
 * either has a session and wants their account, or does not and wants to sign
 * in. Both live elsewhere, so this redirects rather than rendering a page that
 * would only ever be a menu of two links.
 *
 * `beforeLoad` makes it a real server-side redirect rather than a flash of one
 * page before another.
 */
export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    const profile = await fetchProfile()
    throw redirect({ to: profile ? APP_ROUTES.account : APP_ROUTES.login })
  },
})
