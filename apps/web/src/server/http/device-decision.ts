/**
 * What `/device`'s approve/deny handler needs besides the plugin call.
 *
 * Its own module rather than beside the handler because it queries the
 * database, and a route file is compiled for the browser too: the handler's
 * body is stripped from that build, a top-level `drizzle-orm` import is not
 * guaranteed to be.
 */

import { and, eq } from "drizzle-orm"

import type { Runtime } from "../runtime"

/**
 * The plugin's refusal, as one of the page's codes.
 *
 * A 403 is either the plugin's "this code is bound to another user" or this
 * deployment's refusal of an impersonating administrator, and both land on
 * `otherAccount` on purpose: an administrator signed in as somebody is exactly
 * "not the account this code is for", and the sentence tells them to start
 * again as themselves.
 */
export function deviceRefusalFor(
  status: number,
  body: Record<string, unknown>
): string {
  if (status === 429) return "tooMany"
  if (status === 403) return "otherAccount"
  if (body.error === "expired_token") return "expired"
  // Already approved or denied, or never claimed by this session — the
  // plugin says `invalid_request` for all three, with a different sentence.
  // The page's answer is the same: this code is done; start again.
  return body.error === "invalid_request" ? "used" : "invalid"
}

/**
 * The code the plugin stores for one a person typed: letters and digits,
 * upper-case. Its generator draws from `A–Z` without `I`/`O` and `2–9`, so a
 * typed dash or a lower-case letter is the only difference there can be.
 */
export function normalizedUserCode(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "").toUpperCase()
}

/**
 * Which client the code this user just decided belongs to, from the row the
 * plugin bound — never from the form, which is the browser's to fill in.
 */
export async function decidedClient(
  runtime: Runtime,
  userCode: string,
  userId: string
): Promise<string | null> {
  const { deviceCode } = runtime.database.schema
  const [row] = await runtime.database.db
    .select({ clientId: deviceCode.oauthClientId })
    .from(deviceCode)
    .where(
      and(
        eq(deviceCode.userCode, normalizedUserCode(userCode)),
        eq(deviceCode.userId, userId)
      )
    )
    .limit(1)
  return row?.clientId ?? null
}
