import { createFileRoute, redirect } from "@tanstack/react-router"

import { APP_ROUTES } from "@/server/oidc/base-path"

/**
 * `/.well-known/change-password` — the well-known change-password URL.
 *
 * Password managers use it to offer "change this password" in one click. It is
 * a redirect rather than a page so that the real form stays in one place, and
 * so a signed-out visitor lands on the login page the way they would from any
 * other guarded route.
 */
export const Route = createFileRoute("/.well-known/change-password")({
  beforeLoad: () => {
    throw redirect({ to: APP_ROUTES.changePassword })
  },
})
