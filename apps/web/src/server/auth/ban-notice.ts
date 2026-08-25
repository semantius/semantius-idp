/**
 * What `/banned` is told about a suspension (FR-ADMIN-4).
 *
 * The page has always had the wording for a reason and an expiry and was never
 * given either, so a suspended user saw a bare "this account is suspended" and
 * went on retrying a password that was perfectly correct. The e2e suite is
 * what noticed.
 *
 * **Read from the ban record, never from the refusal.** The refusal that
 * actually fires on the password path is the admin plugin's own `BANNED_USER`
 * (its `session.create.before` hook runs ahead of this deployment's gate), and
 * it carries neither field. Reading the row instead also means one code path
 * covers both refusals.
 *
 * **And never from anything the browser sent.** The address is only used to
 * find the row; every value on the page comes from the database. This is not a
 * disclosure either: the ban is checked when the session is created, so the
 * password has already been verified and the only person who can reach it is
 * the account's owner — SEC-7's uniform refusals are untouched.
 *
 * A server module rather than a function inside `routes/login.tsx`, because a
 * route file's imports are isomorphic: a top-level `drizzle-orm` import there
 * is one tree-shaking decision away from the client bundle, which is the R-4
 * failure the bundle gate exists to catch.
 */

import { eq } from "drizzle-orm"

import type { Runtime } from "../runtime"

/**
 * The reason and expiry as query parameters, or `""` when there is nothing to
 * say — a permanent ban with no recorded reason is a real case, and the page
 * then shows only "contact your administrator".
 */
export async function banNoticeFor(
  runtime: Runtime,
  email: string
): Promise<string> {
  const address = email.trim().toLowerCase()
  if (address === "") return ""

  const { user } = runtime.database.schema
  const [row] = await runtime.database.db
    .select({ reason: user.banReason, expires: user.banExpires })
    .from(user)
    .where(eq(user.email, address))
    .limit(1)

  const params = new URLSearchParams()
  if (row?.reason) params.set("reason", row.reason)
  if (row?.expires) params.set("expires", row.expires.toISOString())
  return params.toString()
}
