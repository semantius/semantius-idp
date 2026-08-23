/**
 * The IdP's own Better Auth plugin (DM-1, SEC-6, FR-SIGNUP-2, FR-OIDC-9).
 *
 * It exists mainly so the tables the IdP adds are part of the *generated*
 * schema rather than a hand-written addendum: a Better Auth plugin's `schema`
 * is picked up by `getAuthTables()`, so `audit_log` and `pending_authorization`
 * come out of the same generator as `user` and `session` and are covered by the
 * DM-1 drift gate.
 *
 * The endpoints it adds are the ones Better Auth has no equivalent for:
 * approving and rejecting a pending sign-up (FR-SIGNUP-2) and resetting another
 * user's second factor (FR-2FA-2). They are added in M5/M10; the schema is
 * needed from M3 so migrations do not have to be rewritten later.
 */

import type { BetterAuthPlugin } from "better-auth"

/**
 * Append-only audit trail (SEC-6). No secrets are ever stored: `metadata`
 * carries identifiers and outcomes, never tokens or passwords.
 */
const auditLogSchema = {
  auditLog: {
    modelName: "auditLog",
    fields: {
      /** Dotted event name, e.g. `signin.success`, `social.profile_conflict`. */
      action: { type: "string" as const, required: true, index: true },
      /** `success` | `failure` | `denied`. */
      outcome: { type: "string" as const, required: true },
      /** User id of whoever caused the event, when there is one. */
      actorUserId: { type: "string" as const, required: false, index: true },
      /** How the actor authenticated: `session`, `api-key`, `system`, `cli`. */
      actorType: { type: "string" as const, required: false },
      /** The object of the action — usually a user id, sometimes a client id. */
      targetType: { type: "string" as const, required: false },
      targetId: { type: "string" as const, required: false, index: true },
      /** Anonymised (SEC-5). */
      ipAddress: { type: "string" as const, required: false },
      userAgent: { type: "string" as const, required: false },
      /** Correlates the row with the request log line. */
      requestId: { type: "string" as const, required: false },
      metadata: { type: "json" as const, required: false },
      createdAt: {
        type: "date" as const,
        required: true,
        defaultValue: () => new Date(),
        index: true,
      },
    },
  },
} as const

/**
 * The authorization request that survives the interstitials of FR-OIDC-9.
 *
 * Held server-side and keyed to the browser session so that login, the status
 * gate, 2FA, a forced password change and consent can each redirect away and
 * come back without the client's parameters ever passing through a URL the user
 * could edit. Rows expire after ten minutes and are swept by the cleanup job.
 */
const pendingAuthorizationSchema = {
  pendingAuthorization: {
    modelName: "pendingAuthorization",
    fields: {
      /** Opaque handle held in a short-lived, host-only cookie. */
      handle: { type: "string" as const, required: true, unique: true },
      clientId: { type: "string" as const, required: true },
      /** The original authorize query, serialized. Contains no credentials. */
      query: { type: "json" as const, required: true },
      /** Set once the browser has a session, so a different session cannot resume it. */
      sessionId: { type: "string" as const, required: false },
      /** Which gate the flow is waiting on, for the resume decision. */
      stage: { type: "string" as const, required: true },
      createdAt: {
        type: "date" as const,
        required: true,
        defaultValue: () => new Date(),
      },
      expiresAt: { type: "date" as const, required: true, index: true },
    },
  },
} as const

export const IDP_PLUGIN_ID = "idp"

/**
 * Contributes the IdP's tables. Endpoints are attached in later milestones;
 * keeping the plugin itself minimal means the generated schema is stable.
 */
export function idpPlugin(): BetterAuthPlugin {
  return {
    id: IDP_PLUGIN_ID,
    schema: {
      ...auditLogSchema,
      ...pendingAuthorizationSchema,
    },
  } satisfies BetterAuthPlugin
}

export type AuditAction =
  | "signin.success"
  | "signin.failure"
  | "signup.created"
  | "signup.approved"
  | "signup.rejected"
  | "email.verified"
  | "password.reset_requested"
  | "password.reset_completed"
  | "password.changed"
  | "session.revoked"
  | "user.banned"
  | "user.unbanned"
  | "user.deleted"
  | "user.roles_changed"
  | "twofactor.enabled"
  | "twofactor.disabled"
  | "twofactor.reset"
  | "apikey.created"
  | "apikey.revoked"
  | "apikey.failed"
  | "impersonation.started"
  | "impersonation.stopped"
  | "consent.granted"
  | "consent.revoked"
  | "token.issued"
  | "token.revoked"
  | "client.reconciled"
  | "keys.rotated"
  | "social.profile_conflict"
