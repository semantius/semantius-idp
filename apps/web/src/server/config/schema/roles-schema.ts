/**
 * zod schema for `roles.json` (FR-ROLE-1).
 *
 * Roles are labels for downstream applications — the IdP evaluates no
 * permissions from them. Exactly one entry carries `default: true`; it feeds
 * the admin plugin's `defaultRole` and is assigned at self-registration.
 *
 * When the file is absent the built-in catalog below is used.
 */

import { z } from "zod"

import { flexBoolean } from "../zod-helpers"

/** No commas: `user.role` stores several roles comma-separated (FR-ROLE-2). */
const ROLE_NAME_RE = /^[a-z0-9_-]{1,64}$/

export const roleSchema = z.strictObject({
  name: z
    .string()
    .regex(
      ROLE_NAME_RE,
      "Role names must match ^[a-z0-9_-]{1,64}$ (no commas — `user.role` is comma-separated)."
    ),
  description: z.string().optional(),
  default: flexBoolean()
    .default(false)
    .describe("Assigned at self-registration. Exactly one role must set it."),
})

export const rolesFileSchema = z.strictObject({
  roles: z.array(roleSchema).min(1),
})

export type RoleEntry = z.infer<typeof roleSchema>
export type RolesFile = z.infer<typeof rolesFileSchema>

/** Catalog used when `roles.json` is absent (FR-ROLE-1). */
export const BUILT_IN_ROLES: RoleEntry[] = [
  {
    name: "admin",
    description: "Full access to the admin UI and admin API.",
    default: false,
  },
  {
    name: "user",
    description: "Default role for every registered user.",
    default: true,
  },
]
