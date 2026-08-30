/**
 * The browsers allowed to skip the second factor (FR-2FA-1, FR-2FA-2,
 * **D104**).
 *
 * Ticking "trust this device" at a 2FA challenge writes a `verification` row —
 * `identifier` a random `trust-device-…`, `value` the user's id, `expiresAt`
 * `twoFactor.trustDeviceDays` out — and a signed cookie naming it. The row is
 * the credential's server half: on the next sign-in Better Auth looks it up,
 * **deletes it and writes a fresh one** with a full expiry. So a browser in
 * daily use is never more than a day from a thirty-day extension, and a trust
 * that is actually used never lapses.
 *
 * That is what made the gap worth closing. Better Auth's own teardowns leave
 * these rows standing: an administrator's `/idp/reset-two-factor` deletes the
 * `two_factor` rows, the flag and every session — and not these — and
 * self-service `/two-factor/disable` deletes only the row belonging to the
 * browser doing the disabling. A user who re-enrolled after losing a phone
 * therefore had a *freshly enrolled* second factor that some other browser,
 * possibly the one on the machine they were worried about, could still walk
 * past for up to thirty days.
 *
 * **The predicate is `value = <userId> AND identifier LIKE 'trust-device-%'`,
 * and both halves are load-bearing.** Every other writer of this table was
 * checked: password-reset tokens, e-mail-change and verification tokens, the
 * pending-2FA cookie value, the 2FA attempt counter, the one-shot stashes
 * (`http/one-shot.ts`) and the OAuth codes. None uses this prefix, and several
 * put something other than a user id in `value`, so neither half alone would
 * be safe. The prefix contains no `LIKE` metacharacter, so it needs no
 * escaping — but it is still a prefix scan, which under a non-C collation
 * may not use the `verification_identifier_idx` btree. Accepted: this runs on
 * an administrator's reset or a user's disable, and the table is swept hourly.
 *
 * Lives under `server/auth/` rather than `server/oidc/` on purpose: the latter
 * carries an 85 % coverage gate (TST-1) and dragging a small module under it
 * buys nothing. It has its own tests either way.
 */

import { and, desc, eq, like } from "drizzle-orm"

import type { DbHandle } from "../db/client"

/** Better Auth's own literal (`plugins/two-factor`), and the whole scope. */
export const TRUST_DEVICE_PREFIX = "trust-device-"

/**
 * Forgets every browser this user has trusted. Returns how many there were.
 *
 * The count goes into the audit metadata of whatever caused it — there is no
 * `trusteddevice.cleared` action, because clearing is never the event: it is
 * part of a reset or a disable, and those already have a row.
 */
export async function clearTrustedDevices(
  database: DbHandle,
  userId: string
): Promise<number> {
  const { verification } = database.schema
  const deleted = await database.db
    .delete(verification)
    .where(trustedDevicesOf(database, userId))
    .returning({ id: verification.id })
  return deleted.length
}

/** The one predicate every function here shares. */
export function trustedDevicesOf(database: DbHandle, userId: string) {
  const { verification } = database.schema
  return and(
    eq(verification.value, userId),
    like(verification.identifier, `${TRUST_DEVICE_PREFIX}%`)
  )
}

export interface TrustedDevice {
  /** The row id, which is the form handle. Never the `identifier`. */
  id: string
  createdAt: Date
  expiresAt: Date
}

/**
 * The browsers this user has trusted, most recently trusted first.
 *
 * **The `identifier` never leaves this module.** It is half the credential —
 * the cookie carries `HMAC(secret, "<userId>!<identifier>")` beside it — so
 * rendering it into a page would put the server half of a second-factor bypass
 * into the document. The row `id` is a handle to the same row and buys an
 * attacker nothing.
 *
 * There is nothing else to show. A trust row records no user agent and no
 * address: Better Auth writes an identifier, a value and an expiry, and the
 * honest list is "you trusted a browser on this date". Inventing a device name
 * from the request that happens to be reading the page would name the wrong
 * one.
 */
export async function listTrustedDevices(
  database: DbHandle,
  userId: string
): Promise<TrustedDevice[]> {
  const { verification } = database.schema
  return database.db
    .select({
      id: verification.id,
      createdAt: verification.createdAt,
      expiresAt: verification.expiresAt,
    })
    .from(verification)
    .where(trustedDevicesOf(database, userId))
    .orderBy(desc(verification.createdAt))
}

/**
 * Forgets one browser. `false` when the id was not this user's to forget.
 *
 * Ownership is in the `WHERE`, not in a check before it: the id comes off a
 * form, and "it was on a page I rendered" is not an authorization check. The
 * prefix is in there too, so a row id from some *other* part of the
 * verification table — a password-reset token, say — cannot be deleted
 * through this form even by its owner.
 *
 * Deleting the row **is** the revocation. The browser keeps a cookie that now
 * names nothing, and Better Auth looks the row up on the next sign-in before
 * it will skip the second factor.
 */
export async function clearTrustedDevice(
  database: DbHandle,
  userId: string,
  id: string
): Promise<boolean> {
  if (id === "") return false
  const { verification } = database.schema
  const deleted = await database.db
    .delete(verification)
    .where(and(eq(verification.id, id), trustedDevicesOf(database, userId)))
    .returning({ id: verification.id })
  return deleted.length > 0
}
