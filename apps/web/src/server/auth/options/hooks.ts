/**
 * Request hooks that run before Better Auth's own endpoint handlers.
 *
 * Two things live here, both of which have to happen *before* validation or the
 * endpoint's own logic:
 *
 * - **E-mail normalisation (FR-AUTH-1).** "E-mails are trimmed and lower-cased
 *   everywhere." Doing it in a database hook is too late: the endpoint's schema
 *   rejects `" User@Example.com "` as malformed before any row is written, so a
 *   user who copied their address with a trailing space gets an unhelpful
 *   error instead of being signed in.
 *
 * - **Default audience injection (FR-OIDC-6, risk R1)** — added in M8. The
 *   OAuth provider only issues a JWT access token when a `resource` resolves,
 *   so a client that sends none must have `jwt.audience` supplied for it.
 */

import { createAuthMiddleware } from "better-auth/api"

import type { BetterAuthOptions } from "better-auth"

import type { IdpConfig } from "../../config/derive"
import { normalizeEmail } from "./social"

/**
 * Endpoints whose body carries an address the user typed. Matching on an exact
 * list rather than "any body with an `email` key" keeps the rewrite away from
 * bodies where the value is a filter or a label rather than an identity.
 */
const EMAIL_BODY_PATHS = new Set([
  "/sign-up/email",
  "/sign-in/email",
  "/forget-password",
  "/request-password-reset",
  "/send-verification-email",
  "/change-email",
  "/admin/create-user",
  "/admin/update-user",
])

/** Body keys that hold an address on those endpoints. */
const EMAIL_BODY_KEYS = ["email", "newEmail"] as const

export function buildBeforeHook(
  _config: IdpConfig
): NonNullable<BetterAuthOptions["hooks"]>["before"] {
  return createAuthMiddleware(async (ctx) => {
    normalizeEmailFields(
      ctx.path,
      ctx.body as Record<string, unknown> | undefined
    )
  })
}

/** Exported for the unit test; mutates in place, which is what the middleware needs. */
export function normalizeEmailFields(
  path: string,
  body: Record<string, unknown> | undefined
): void {
  if (!body || !EMAIL_BODY_PATHS.has(path)) return
  for (const key of EMAIL_BODY_KEYS) {
    const value = body[key]
    if (typeof value === "string") body[key] = normalizeEmail(value)
  }
}
