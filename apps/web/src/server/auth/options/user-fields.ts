/**
 * Custom `user` columns (DM-3) and the mass-assignment rules that protect them
 * (FR-AUTH-7).
 *
 * Better Auth's own columns (`role`, `banned`, `banReason`, `banExpires`,
 * `emailVerified`) are already `input: false` in the core and admin plugin
 * schemas. The four the IdP adds must be too: `status` in particular is the
 * approval gate, so a sign-up body claiming `"status": "active"` has to be
 * ignored, not honored.
 *
 * `input: false` is Better Auth's own mechanism — the field is stripped from
 * request bodies and can only be written through internal/admin paths — which
 * is exactly the guarantee FR-AUTH-7 asks for.
 */

import type { DBFieldAttribute } from "@better-auth/core/db"

/** Approval state of a user (FR-SIGNUP-2). */
export const USER_STATUSES = ["pending", "active", "rejected"] as const
export type UserStatus = (typeof USER_STATUSES)[number]

export const userAdditionalFields = {
  /**
   * Optional given name. Collected at sign-up and mapped from a provider's
   * `given_name` (FR-SIGNUP-5); emitted as the `given_name` claim.
   */
  firstName: {
    type: "string",
    required: false,
    input: true,
  },
  lastName: {
    type: "string",
    required: false,
    input: true,
  },
  /**
   * Approval state. A non-`active` user gets no session, no authorization code,
   * no token and no API-key authentication on any path (FR-SIGNUP-2).
   */
  status: {
    type: USER_STATUSES as unknown as string[],
    required: true,
    defaultValue: "pending",
    input: false,
    index: true,
  },
  approvedAt: {
    type: "date",
    required: false,
    input: false,
  },
  /** User id of the admin who approved, or `system` for bootstrap. */
  approvedBy: {
    type: "string",
    required: false,
    input: false,
  },
  /**
   * Set for the bootstrap admin and for any admin-assigned temporary password.
   * Interposes a change-password step before anything else completes, including
   * an OAuth continuation (FR-AUTH-4).
   */
  mustChangePassword: {
    type: "boolean",
    required: false,
    defaultValue: false,
    input: false,
  },
} satisfies Record<string, DBFieldAttribute>

/**
 * Fields that must never be settable from a request body (FR-AUTH-7). The ones
 * Better Auth owns are listed for the test that asserts the whole set, not
 * because we declare them.
 */
export const MASS_ASSIGNMENT_PROTECTED_FIELDS = [
  "role",
  "banned",
  "banReason",
  "banExpires",
  "emailVerified",
  "status",
  "approvedAt",
  "approvedBy",
  "mustChangePassword",
] as const
