/**
 * The IdP's own Better Auth plugin (DM-1, SEC-6, FR-SIGNUP-2, FR-2FA-2, FR-OIDC-9).
 *
 * It exists for two reasons.
 *
 * **Schema.** A Better Auth plugin's `schema` is picked up by
 * `getAuthTables()`, so `audit_log` and `pending_authorization` come out of the
 * same generator as `user` and `session` and are covered by the DM-1 drift gate
 * rather than being a hand-written addendum nobody regenerates.
 *
 * **Endpoints Better Auth has no equivalent for.** The admin plugin ships ban,
 * impersonation and CRUD but no approval workflow (V6), so approve and reject
 * live here — as endpoints rather than page-only logic, because FR-ADMIN-6 says
 * the admin API is the documented management interface and the UI is one of its
 * callers.
 */

import { APIError, createAuthEndpoint } from "better-auth/api"
import { z } from "zod"

import type { BetterAuthPlugin } from "better-auth"
import type { AuthMiddleware } from "better-auth/api"

import type { Audit } from "../../audit"
import type { IdpConfig } from "../../config/derive"
import type { Mailer } from "../../email/mailer"
import { NOT_AN_ADMIN, requireAdmin } from "../../admin/gate"
import { gatewaySchema } from "../../gateways/schema"
import { registerHostTemplateDiscovery } from "../../oidc/host-template-clients"

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
      /** Anonymized (SEC-5). */
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

export interface IdpPluginOptions {
  config: IdpConfig
  /** Absent while the schema is generated, which needs no behavior. */
  audit?: Audit
  mailer?: Mailer
  /**
   * The SEC-6 audit middleware. Registered through this plugin so it runs
   * *after* every other plugin's `after` hook — see the comment at the
   * bottom of {@link idpPlugin}.
   */
  afterHook?: AuthMiddleware
  /**
   * FR-ADMIN-3: the invariants that wrap Better Auth's own admin endpoints.
   * Registered here rather than in `options.hooks.before` so it sits next to
   * the endpoints it guards and travels with this plugin.
   */
  adminGuard?: AuthMiddleware
  /** FR-ADMIN-4/FR-OIDC-12: what a completed admin mutation still owes. */
  adminAfterHook?: AuthMiddleware
  /**
   * FR-ADMIN-2/6: the administrative endpoints, built in `admin/endpoints.ts`.
   * Passed in rather than built here so this file stays about the approval
   * workflow its coverage gate is written for.
   */
  adminEndpoints?: BetterAuthPlugin["endpoints"]
}

export const IDP_ERROR_CODES = {
  NOT_AN_ADMIN,
  USER_NOT_FOUND: "No such user.",
  NOT_PENDING: "That account is not waiting for a decision.",
} as const

interface UserRow {
  id: string
  email: string
  status?: string | null
  name?: string | null
}

/** Contributes the IdP's tables and its approval endpoints. */
export function idpPlugin(options: IdpPluginOptions): BetterAuthPlugin {
  const { config, audit, mailer } = options
  const adminGate = requireAdmin(config)

  const approveUser = createAuthEndpoint(
    "/idp/approve-user",
    {
      method: "POST",
      body: z.object({ userId: z.string().min(1) }),
      requireHeaders: true,
      use: [adminGate],
    },
    async (ctx) => {
      const actor = ctx.context.session.user
      const user = (await ctx.context.internalAdapter.findUserById(
        ctx.body.userId
      )) as UserRow | null
      if (!user)
        throw new APIError("NOT_FOUND", {
          message: IDP_ERROR_CODES.USER_NOT_FOUND,
        })

      // Idempotent for an already-active user, but a rejected one has to be
      // approved deliberately rather than by a stale button.
      if (user.status === "active") return ctx.json({ user })

      const updated = await ctx.context.internalAdapter.updateUser(user.id, {
        status: "active",
        approvedAt: new Date(),
        approvedBy: actor.id,
      })

      await audit?.record({
        action: "signup.approved",
        outcome: "success",
        actorUserId: actor.id,
        actorType: "session",
        target: { type: "user", id: user.id },
        // Deliberately not read from a header here: `X-Forwarded-For` is
        // attacker-controlled at the left, and the audit writer already has
        // the address the edge resolved under `server.trustProxy`.
        ipAddress: undefined,
        userAgent: ctx.request?.headers.get("user-agent"),
        metadata: { previousStatus: user.status },
      })

      // FR-SIGNUP-2: the approval e-mail links to /login. It deliberately does
      // not resume an OAuth flow — the user restarts from the application.
      await mailer?.send("accountApproved", user.email)

      return ctx.json({ user: updated })
    }
  )

  const rejectUser = createAuthEndpoint(
    "/idp/reject-user",
    {
      method: "POST",
      body: z.object({
        userId: z.string().min(1),
        /** Whether to tell them. The rejection e-mail is optional (FR-MAIL-1). */
        notify: z.boolean().optional(),
      }),
      requireHeaders: true,
      use: [adminGate],
    },
    async (ctx) => {
      const actor = ctx.context.session.user
      const user = (await ctx.context.internalAdapter.findUserById(
        ctx.body.userId
      )) as UserRow | null
      if (!user)
        throw new APIError("NOT_FOUND", {
          message: IDP_ERROR_CODES.USER_NOT_FOUND,
        })

      const updated = await ctx.context.internalAdapter.updateUser(user.id, {
        status: "rejected",
        approvedAt: null,
        approvedBy: actor.id,
      })

      // FR-SIGNUP-2: the row stays, so the address remains reserved; and any
      // session they somehow hold goes away now.
      await ctx.context.internalAdapter.deleteUserSessions(user.id)

      await audit?.record({
        action: "signup.rejected",
        outcome: "success",
        actorUserId: actor.id,
        actorType: "session",
        target: { type: "user", id: user.id },
        // Deliberately not read from a header here: `X-Forwarded-For` is
        // attacker-controlled at the left, and the audit writer already has
        // the address the edge resolved under `server.trustProxy`.
        ipAddress: undefined,
        userAgent: ctx.request?.headers.get("user-agent"),
        metadata: {
          previousStatus: user.status,
          notified: ctx.body.notify === true,
        },
      })

      if (ctx.body.notify === true)
        await mailer?.send("accountRejected", user.email)

      return ctx.json({ user: updated })
    }
  )

  return {
    id: IDP_PLUGIN_ID,
    // Registers the `{host}` client-discovery with the oauth-provider plugin
    // (`server.dynamicIssuer`, D-dynamic-issuer). In `init` because that is
    // the provider's documented extension seam, and unconditional because a
    // deployment with no template clients simply never stamps
    // `clientDiscoveryId` on a row — the discovery is then never consulted.
    init(ctx) {
      registerHostTemplateDiscovery(ctx)
    },
    schema: {
      ...auditLogSchema,
      ...pendingAuthorizationSchema,
      ...gatewaySchema,
    },
    endpoints: {
      approveUser,
      rejectUser,
      ...(options.adminEndpoints ?? {}),
    },
    // The SEC-6 trail runs **here** rather than as `options.hooks.after`,
    // and the difference is not cosmetic. Better Auth runs the options hook
    // first and every plugin hook after it, replacing `context.returned` as
    // it goes — so from the options slot a sign-in that ended in a 2FA
    // challenge still looks like a completed sign-in, and the trail said
    // "signed in" for someone who had not been. This plugin is registered
    // last, so it sees what the caller will actually receive.
    ...buildHooks(options),
  } satisfies BetterAuthPlugin
}

/**
 * `before` guards first, then the trail.
 *
 * Better Auth merges every plugin's hooks into one chain in registration
 * order, so the only thing this decides is the order *within* this plugin —
 * and the audit middleware has to be last of all, which is why it is
 * registered from here at all.
 */
function buildHooks(options: IdpPluginOptions) {
  const before = options.adminGuard
    ? [{ matcher: () => true, handler: options.adminGuard }]
    : []
  const after = [options.adminAfterHook, options.afterHook]
    .filter((handler): handler is AuthMiddleware => handler !== undefined)
    .map((handler) => ({ matcher: () => true, handler }))

  if (before.length === 0 && after.length === 0) return {}
  return {
    hooks: {
      ...(before.length ? { before } : {}),
      ...(after.length ? { after } : {}),
    },
  }
}

export type AuditAction =
  | "signin.success"
  | "signin.failure"
  // D66: an account somebody made for somebody else — an administrator, or
  // the first-run wizard. `signup.created` stays what it has always meant:
  // a self-service registration.
  | "user.created"
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
  | "user.profile_changed"
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
  | "client.created"
  // D72: an admin-registered client is editable, and rotating its secret is
  // its own event — the trail has to distinguish "the URIs changed" from "the
  // credential changed", because only one of those explains a client that
  // stopped working this morning.
  | "client.updated"
  | "client.secret_rotated"
  | "client.deleted"
  | "client.disabled"
  | "keys.rotated"
  // D91: the API gateways of FR-GW. `reconciled` is the boot sweep (ids and
  // counts only); the other four are one administrator, one row.
  | "gateway.reconciled"
  | "gateway.created"
  | "gateway.updated"
  | "gateway.deleted"
  | "gateway.disabled"
  // D83: one row per `/admin/database` execution, success or not. The console
  // can read everything at rest, so "an administrator ran SQL" is exactly the
  // kind of event SEC-6 exists to make undeniable -- and the statement itself
  // (first 500 characters) is the only useful part of the record.
  | "database.queried"
  | "social.profile_conflict"
