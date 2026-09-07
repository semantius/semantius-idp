/**
 * What a reset link is for, before it is spent.
 *
 * `/reset-password` used to know nothing at all: it read the token out of the
 * query string, rendered a form, and found out whether the link was any good
 * only after a password had been typed and posted. So an invite that had
 * expired, or a link that had already been used, looked exactly like a working
 * one. The loader's old JSDoc said a lookup "would burn the token"; that is
 * true of the POST, and not of a read.
 *
 * **It answers validity and nothing else.** For a while it also returned the
 * account's address and display name so the page could say whose link it was;
 * the security review removed that. A link forwarded to the wrong person then
 * told them exactly which account it opened, and a page that shows only a
 * password form gives a token holder nothing they did not already have.
 *
 * **This is a validity oracle, deliberately.** It answers valid / expired /
 * unknown for a token somebody already holds. Better Auth's own
 * `GET /reset-password/:token` does the same with the same non-consuming
 * `findVerificationValue` and the same expiry comparison, so this adds no
 * capability that the framework does not already expose. The tokens are 24
 * random bytes — 192 bits — so guessing one is not a threat model, and the
 * answer discloses nothing to somebody who does not have one.
 *
 * "Already used" is **not** a distinguishable state: a spent token's row is
 * deleted (`api/routes/password.mjs`, `consumeVerificationValue`), so it is
 * gone exactly like one that never existed. The copy says so rather than
 * pretending the page can tell.
 */

import { createServerFn } from "@tanstack/react-start"

import { runWithEndpointContext } from "@better-auth/core/context"

import { getRuntime } from "../runtime"

export type ResetTokenState = "valid" | "expired" | "invalid"

export interface ResetTokenView {
  state: ResetTokenState
}

export const fetchResetToken = createServerFn({ method: "GET" })
  .validator((token: unknown) => (typeof token === "string" ? token : ""))
  .handler(async ({ data: token }): Promise<ResetTokenView> => {
    if (token === "") return { state: "invalid" }

    const runtime = await getRuntime()
    const context = await runtime.auth.$context

    // The identifier convention is Better Auth 1.7.1's, and the coupling is
    // the same one `server/auth/reset-link.ts` already documents and the
    // integration suite already exercises.
    const verification = await runWithEndpointContext({ context }, () =>
      context.internalAdapter
        .findVerificationValue(`reset-password:${token}`)
        .catch(() => null)
    )
    if (!verification) return { state: "invalid" }
    if (verification.expiresAt.getTime() <= Date.now()) {
      return { state: "expired" }
    }

    // The stored value *is* the user id (`reset-link.ts`); a row whose user
    // is gone is a dead link, whatever its expiry says.
    const user = await context.internalAdapter.findUserById(verification.value)
    if (!user) return { state: "invalid" }

    return { state: "valid" }
  })
