import { createFileRoute, redirect } from "@tanstack/react-router"

import { fetchProfile } from "@/server/functions/account"
import { fetchSetupPending } from "@/server/functions/setup"
import { APP_ROUTES } from "@/server/oidc/base-path"

/**
 * `/` has nothing of its own to show.
 *
 * An identity provider's root is not a landing page: someone who arrives here
 * either has a session and wants their account, or does not and wants to sign
 * in. Both live elsewhere, so this redirects rather than rendering a page that
 * would only ever be a menu of two links.
 *
 * There is a third case, and it is the first one anybody meets: a deployment
 * whose `user` table is still empty has nobody to sign in *as*, so the root
 * sends them to the first-run setup page instead (**D52**). That check comes
 * first, because `fetchProfile()` on a fresh database can only ever answer
 * "no session".
 *
 * `beforeLoad` makes it a real server-side redirect rather than a flash of one
 * page before another.
 */
export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    if (await fetchSetupPending()) {
      throw redirect({ to: APP_ROUTES.setup })
    }
    const profile = await fetchProfile()
    throw redirect({ to: profile ? APP_ROUTES.account : APP_ROUTES.login })
  },
})
