/**
 * Who currently holds an admin role (FR-ADMIN-3, FR-ROLE-3).
 *
 * Separate from `invariants.ts` so the rules stay a pure function: this is the
 * one part that touches the database, and it is deliberately small.
 *
 * The `like` filters are a *narrowing*, not the answer. `user.role` is a
 * comma-separated column, so `'%admin%'` also matches `superadmin` and
 * `admin-assistant`; the rows it returns are re-checked with `splitRoles`,
 * which is exact. Doing it this way keeps the query from returning every user
 * in the deployment for what is nearly always a handful of rows.
 */

import { or, like } from "drizzle-orm"

import type { DbHandle } from "../db/client"
import { isAdmin } from "../role-utils"
import type { AdminInvariantUser } from "./invariants"

/** Every user holding one of `adminRoles`, banned and pending ones included. */
export async function loadAdmins(
  database: DbHandle,
  adminRoles: readonly string[]
): Promise<AdminInvariantUser[]> {
  if (adminRoles.length === 0) return []
  const { user } = database.schema

  const rows = await database.db
    .select({
      id: user.id,
      role: user.role,
      status: user.status,
      banned: user.banned,
      banExpires: user.banExpires,
    })
    .from(user)
    .where(or(...adminRoles.map((role) => like(user.role, `%${role}%`))))

  // The `like` was a net; this is the sieve.
  return rows.filter((row) => isAdmin(row.role, adminRoles))
}
