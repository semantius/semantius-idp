/**
 * The browsers allowed to skip the second factor.
 *
 * Ticking "trust this device" at a 2FA challenge writes a `verification` row —
 * `identifier` a random `trust-device-…`, `value` the user's id, `expiresAt`
 * `twoFactor.trustDeviceDays` out — and a signed cookie naming it. The row is
 * the credential's server half: on the next sign-in Better Auth looks it up,
 * **deletes it and writes a fresh one** with a full expiry. So a browser in
 * daily use is never more than a day from a thirty-day extension, and a trust
 * that is actually used never lapses — up to the hard ceiling **the spec puts
 * on it (`trustedDeviceVerificationHooks` below): three windows from the day
 * the box was ticked, after which the browser is asked again.
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
 * carries an 85 % coverage gate and dragging a small module under it
 * buys nothing. It has its own tests either way.
 */

import { and, desc, eq, like } from "drizzle-orm"

import type { BetterAuthOptions } from "better-auth"

import type { DbHandle } from "../db/client"

/** Better Auth's own literal (`plugins/two-factor`), and the whole scope. */
export const TRUST_DEVICE_PREFIX = "trust-device-"

export function isTrustedDeviceIdentifier(identifier: unknown): boolean {
  return (
    typeof identifier === "string" && identifier.startsWith(TRUST_DEVICE_PREFIX)
  )
}

/**
 * How many rolling windows a trust may live through in total.
 *
 * Rotation makes `twoFactor.trustDeviceDays` a *sliding* window: every
 * sign-in re-mints the row with a full expiry, so a browser used once a
 * month is trusted for ever, and so is a cookie copied off one. The row is
 * bound to the cookie and the user and to nothing else — no address, no user
 * agent — so nothing about the presenting browser can ever refuse it. What
 * can is time: a trust is now also bounded by a hard ceiling measured from
 * the day the box was ticked, after which the browser meets the second
 * factor again whatever its rotation history.
 *
 * Three windows, not a second setting. The ceiling exists to bound a stolen
 * cookie, and its right size is relative to the window the operator already
 * chose: a deployment trusting for a week wants the ceiling in weeks, and
 * `trustDeviceDays: 0` ("always ask") gives a ceiling of zero without a
 * cross-check to say the two disagree. A separate `trustDeviceMaxDays` was
 * considered and rejected for exactly that cross-check — `365` days of
 * trust silently capped at a `90`-day default would have needed a warning,
 * a docs row and a schema regeneration to buy one number nobody asked for.
 */
export const TRUST_DEVICE_MAX_WINDOWS = 3

const DAY_MS = 24 * 60 * 60 * 1000

/** The ceiling, in milliseconds from first issue. */
export function trustedDeviceCeilingMs(trustDeviceDays: number): number {
  return Math.max(0, trustDeviceDays) * TRUST_DEVICE_MAX_WINDOWS * DAY_MS
}

/**
 * The expiry a trust row may carry: what the plugin asked for, or the
 * ceiling from first issue, whichever is sooner. Pure, and tested on its own.
 */
export function capTrustedDeviceExpiry(input: {
  firstIssued: Date
  requested: Date
  ceilingMs: number
}): Date {
  const ceiling = input.firstIssued.getTime() + input.ceilingMs
  return input.requested.getTime() <= ceiling
    ? input.requested
    : new Date(ceiling)
}

/**
 * The first-issue time of the row a sign-in is about to replace, carried
 * from the delete to the create it is followed by.
 *
 * Keyed on the per-request auth context — the object Better Auth hands every
 * database hook, and the same one `hooks.ts` keys `REVOKED_SESSION` on — in a
 * `WeakMap`, so a delete that no create follows (`/two-factor/disable`
 * forgetting the presenting browser) leaves nothing behind.
 */
const FIRST_ISSUED = new WeakMap<object, Date>()

type VerificationHooks = NonNullable<
  NonNullable<BetterAuthOptions["databaseHooks"]>["verification"]
>

/**
 * The two database hooks that put the ceiling on.
 *
 * There is no plugin seam for this. Better Auth's re-mint is three
 * `internalAdapter` calls in its own after-hook — find, delete, create — and
 * the create is handed a fresh `expiresAt` and nothing about the row it
 * replaces. The one thing that does see the old row is the `delete.before`
 * database hook, which receives the entity about to go; so it stashes the
 * old `createdAt` on the request, and `create.before` on the same request
 * reads it back, **keeps it as the new row's `createdAt`** — which is how
 * the anchor survives any number of rotations — and caps `expiresAt` at
 * `createdAt + ceiling`. The plugin's own `expiresAt > now` check then
 * refuses the device once the ceiling has passed; nothing else has to know.
 *
 * A create with nothing stashed is a first issue (`verify-totp` with
 * `trustDevice: true`), and `createdAt` is the anchor from here on. A hook
 * with no context — the CLI, a background job — is treated the same way.
 * `listTrustedDevices` reports `createdAt` as "trusted since", which this
 * makes true for the first time: it used to be the last rotation.
 *
 * Rows that predate this carry the last rotation as `createdAt`, so their
 * ceiling counts from there. Accepted: a row in use rotates on the next
 * sign-in and is bounded from that day; one not in use expires on its own.
 *
 * Wired from `buildDatabaseHooks` as the `verification` entry:
 * `verification: trustedDeviceVerificationHooks(config.file.twoFactor.trustDeviceDays)`.
 */
export function trustedDeviceVerificationHooks(
  trustDeviceDays: number
): VerificationHooks {
  const ceilingMs = trustedDeviceCeilingMs(trustDeviceDays)
  return {
    delete: {
      before: async (verification, context) => {
        if (!context || !isTrustedDeviceIdentifier(verification.identifier))
          return
        const created = asDate(verification.createdAt)
        if (created) FIRST_ISSUED.set(context, created)
      },
    },
    create: {
      before: async (verification, context) => {
        if (!isTrustedDeviceIdentifier(verification.identifier)) return
        const firstIssued =
          (context ? FIRST_ISSUED.get(context) : undefined) ??
          asDate(verification.createdAt) ??
          new Date()
        const requested = asDate(verification.expiresAt) ?? new Date()
        return {
          data: {
            ...verification,
            createdAt: firstIssued,
            expiresAt: capTrustedDeviceExpiry({
              firstIssued,
              requested,
              ceilingMs,
            }),
          },
        }
      },
    },
  }
}

function asDate(value: unknown): Date | undefined {
  if (value instanceof Date) return value
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? undefined : parsed
  }
  return undefined
}

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
 * honest list is "you trusted a browser on this date" — `createdAt`, which
 * survives rotation and really is that date. Inventing a
 * device name from the request that happens to be reading the page would name
 * the wrong one.
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
