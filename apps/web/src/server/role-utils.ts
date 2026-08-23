/**
 * Role helpers (FR-ROLE-2).
 *
 * `user.role` is a Better-Auth-fixed single column, so several roles are stored
 * comma-separated in it. Splitting lives here rather than in `startup.ts`
 * because the admin gate, the claims builder and the admin UI all need the same
 * answer, and a second implementation is a second chance to get it wrong.
 */

/** Splits the stored column into role names, trimming and dropping blanks. */
export function splitRoles(value: string | null | undefined): string[] {
  if (!value) return []
  return value
    .split(",")
    .map((role) => role.trim())
    .filter((role) => role !== "")
}

/** Joins role names back into the stored form. */
export function joinRoles(roles: readonly string[]): string {
  return roles
    .map((role) => role.trim())
    .filter((role) => role !== "")
    .join(",")
}

/**
 * The roles a user actually has, in catalog order, dropping any that are no
 * longer defined (FR-ROLE-2: "role values no longer in the catalog are dropped
 * from claims"). Catalog order keeps the `roles` claim stable across users.
 */
export function effectiveRoles(
  stored: string | null | undefined,
  catalog: readonly { name: string }[]
): string[] {
  const held = new Set(splitRoles(stored))
  return catalog.map((role) => role.name).filter((name) => held.has(name))
}

/** Whether any held role unlocks the admin area (FR-ROLE-3). */
export function isAdmin(
  stored: string | null | undefined,
  adminRoles: readonly string[]
): boolean {
  const held = new Set(splitRoles(stored))
  return adminRoles.some((role) => held.has(role))
}
