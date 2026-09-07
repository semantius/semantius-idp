/**
 * Telling a registration that created an account from one that did not
 *.
 *
 * Better Auth 1.7.1 already answers a sign-up for an address that has an
 * account with a **generic success**: whenever `requireEmailVerification` is
 * on or `autoSignIn` is off — and `instance.ts` sets the latter for every
 * deployment — `/sign-up/email` hashes the password for timing
 * parity, calls `emailAndPassword.onExistingUserSignUp` if there is one, and
 * returns `200 { token: null, user: <synthetic> }` for a user it never wrote.
 * So the refusal `errorCodeFor` maps to `signup_failed`, and the sentence in
 * SECURITY.md that said sign-up "cannot" answer uniformly, both described a
 * version of the library this repository no longer pins. The review found the
 * shape uniform already and two things missing behind it: **nobody told the
 * owner**, and the audit trail recorded `signup.created` for an attempt that
 * created nothing, because the after-hook keys on the status.
 *
 * The synthetic user's `id` is freshly generated and belongs to no row, which
 * is the one honest tell: look the address up, and if the row's id is not the
 * one the response carries, the response is the generic one. That is a single
 * indexed read on the success path and needs no marker smuggled out of the
 * library's callback, so `/signup` can decide what to do with the fact where
 * it already decides where to land — tell the owner with e-mail on, refuse
 * without it — and the spec after-hook can use the same predicate to keep
 * `signup.created` honest.
 */

import { eq } from "drizzle-orm"

import type { DbHandle } from "../db/client"
import type { RateLimitRule } from "../http/rate-limit"

/**
 * `true` when a `200` from `/sign-up/email` is the generic duplicate answer:
 * the address already had an account, and the user in the body is synthetic.
 *
 * `false` for a real creation, and for anything that does not look like the
 * endpoint's answer at all — the caller has a status for that.
 */
export async function signUpCreatedNothing(
  database: DbHandle,
  returned: unknown
): Promise<boolean> {
  const user = (returned as { user?: { id?: unknown; email?: unknown } } | null)
    ?.user
  if (!user || typeof user.id !== "string" || typeof user.email !== "string")
    return false

  const [row] = await database.db
    .select({ id: database.schema.user.id })
    .from(database.schema.user)
    .where(eq(database.schema.user.email, user.email.trim().toLowerCase()))
    .limit(1)
  return row !== undefined && row.id !== user.id
}

/**
 * How often the existing owner is told.
 *
 * Better Auth's own bucket on `/sign-up/email` is five per five minutes per
 * address *of the caller*, and a notice per attempt would let anyone with a
 * few addresses turn the feature into a way to fill somebody's inbox from
 * this deployment's sender. One notice an hour per **target** address is
 * enough for the message's purpose — the owner learns that someone knows the
 * address — and is the same fixed-window limiter `/setup` uses, keyed on the
 * address rather than the caller.
 */
export const DUPLICATE_NOTICE_RULE: RateLimitRule = { window: 3600, max: 1 }

export function duplicateNoticeBucket(email: string): string {
  return `signup_duplicate_notice:${email.trim().toLowerCase()}`
}
