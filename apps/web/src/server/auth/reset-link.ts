/**
 * A password-reset link, minted without sending an e-mail (FR-ADMIN-2,
 * FR-MAIL-2).
 *
 * `POST /request-password-reset` mints the token *and* hands the URL to
 * `sendResetPassword`, which is the mailer. That is exactly right for the
 * public "I forgot my password" form and exactly wrong for the two cases here:
 * an administrator creating an account on a server with no mail transport, and
 * `idp create-admin` on a machine with no network. Both need the link in their
 * hand, not in a queue.
 *
 * So this mints the same row the endpoint would. **It is coupled to Better
 * Auth 1.7.1's identifier convention** — `reset-password:<token>`, with the
 * user id as the value — and that coupling is deliberate rather than hidden:
 * `integration/admin.test.ts` mints a link this way and then *uses* it against
 * the real `/reset-password` endpoint, so if the convention ever changes the
 * suite says so rather than the operator discovering it from a link that
 * silently does nothing.
 *
 * The alternative — calling the endpoint and capturing the URL from inside the
 * mailer callback — would need a per-request capture slot on a shared runtime,
 * which is a race waiting for two administrators to click at once.
 */

import { randomBytes } from "node:crypto"

import { runWithEndpointContext } from "@better-auth/core/context"

import type { Runtime } from "../runtime"

/** How long an administrator's link stays good. An hour, like the mailed one. */
const DEFAULT_TTL_SECONDS = 3600

export interface ResetLink {
  /** The bare token, for a caller that wants to build its own URL. */
  token: string
  /** The absolute URL to hand over. */
  url: string
  expiresAt: Date
}

export async function createResetLink(
  runtime: Runtime,
  userId: string,
  { ttlSeconds = DEFAULT_TTL_SECONDS } = {}
): Promise<ResetLink> {
  const token = randomBytes(24).toString("base64url")
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000)
  const context = await runtime.auth.$context

  await runWithEndpointContext({ context }, () =>
    context.internalAdapter.createVerificationValue({
      identifier: `reset-password:${token}`,
      value: userId,
      expiresAt,
    })
  )

  const base = runtime.config.base
  return {
    token,
    // Our own `/reset-password` page, not Better Auth's `/reset-password/:token`
    // redirect: the page is what asks for the new password, and going through
    // the redirect would only add a hop that drops the token into a `Referer`.
    url: `${base.origin}${base.basePath}/reset-password?token=${encodeURIComponent(token)}`,
    expiresAt,
  }
}
