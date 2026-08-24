/**
 * The administrative endpoints Better Auth has no equivalent for
 * (FR-ADMIN-2/6, FR-2FA-2, FR-OIDC-16).
 *
 * They are endpoints rather than server functions on purpose. FR-ADMIN-6 makes
 * the admin API the documented management interface and the admin UI one of
 * its callers, so anything the UI can do has to be reachable with an admin API
 * key and a `curl`. The alternative — server functions for the pages plus a
 * parallel API for scripts — is two implementations of every rule, and the
 * second one is always the one that forgets the audit row.
 *
 * They live here rather than in `idp-plugin.ts` because that file carries an
 * 85% coverage gate for the approval workflow, and mixing a read-only stats
 * query into it makes that number say less than it does now.
 */

import { APIError, createAuthEndpoint } from "better-auth/api"
import { and, count, desc, eq, gte, lt } from "drizzle-orm"
import { z } from "zod"

import type { Audit } from "../audit"
import type { IdpConfig } from "../config/derive"
import { maskConfig } from "../config/mask"
import { createDb  } from "../db/client"
import type {DbHandle} from "../db/client";
import type { Logger } from "../logger"
import type { Mailer } from "../email/mailer"
import { rotateKeys } from "../oidc/rotate-keys"
import { revokeAllForUser } from "../oidc/revoke-user-tokens"
import { splitRoles } from "../role-utils"
import { revision, version } from "../version"
import type { AdminContext } from "./context"
import { requireAdmin } from "./gate"

export interface AdminEndpointDeps {
  config: IdpConfig
  /** Absent while the schema is generated, which needs no connection. */
  database?: DbHandle
  audit?: Audit
  logger?: Logger
  mailer?: Mailer
  /** Filled in by `runtime.ts` as each piece becomes available. */
  context?: AdminContext
}

const NO_DATABASE = "This server is running without a database connection."

function db(deps: AdminEndpointDeps): DbHandle {
  if (!deps.database) {
    throw new APIError("SERVICE_UNAVAILABLE", { message: NO_DATABASE })
  }
  return deps.database
}

export function buildAdminEndpoints(deps: AdminEndpointDeps) {
  const gate = requireAdmin(deps.config)

  /**
   * FR-2FA-2: an administrator resets a locked-out user's second factor.
   *
   * Three things have to happen together, and skipping any one of them leaves
   * the account in a state nobody can reason about: the enrolment rows go, the
   * flag on the user goes, and every live session goes with them — because a
   * session that was minted *behind* a second factor is exactly what an
   * attacker who triggered the reset would be holding.
   */
  const resetTwoFactor = createAuthEndpoint(
    "/idp/reset-two-factor",
    {
      method: "POST",
      body: z.object({ userId: z.string().min(1) }),
      requireHeaders: true,
      use: [gate],
    },
    async (ctx) => {
      const handle = db(deps)
      const actor = ctx.context.session.user
      const user = await ctx.context.internalAdapter.findUserById(
        ctx.body.userId
      )
      if (!user) {
        throw new APIError("NOT_FOUND", { message: "No such user." })
      }

      await handle.db
        .delete(handle.schema.twoFactor)
        .where(eq(handle.schema.twoFactor.userId, user.id))
      await ctx.context.internalAdapter.updateUser(user.id, {
        twoFactorEnabled: false,
      })
      await ctx.context.internalAdapter.deleteUserSessions(user.id)
      await revokeAllForUser(
        { database: handle, audit: deps.audit },
        { userId: user.id, reason: "admin:two_factor_reset" }
      )

      await deps.audit?.record({
        action: "twofactor.reset",
        outcome: "success",
        actorType: "session",
        actorUserId: actor.id,
        target: { type: "user", id: user.id },
      })
      await deps.mailer?.send(
        "twoFactorReset",
        (user as { email: string }).email
      )

      return ctx.json({ ok: true })
    }
  )

  /** The numbers the dashboard opens with (FR-ADMIN-2). */
  const adminStats = createAuthEndpoint(
    "/idp/admin-stats",
    { method: "GET", requireHeaders: true, use: [gate] },
    async (ctx) => {
      const handle = db(deps)
      const { user, session, oauthClient, auditLog } = handle.schema
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)

      const [byStatus, sessions, clients, recentSignIns, failures, roles] =
        await Promise.all([
          handle.db
            .select({ status: user.status, total: count() })
            .from(user)
            .groupBy(user.status),
          handle.db
            .select({ total: count() })
            .from(session)
            .where(gte(session.expiresAt, new Date())),
          handle.db
            .select({ disabled: oauthClient.disabled, total: count() })
            .from(oauthClient)
            // Postgres refuses a bare column beside an aggregate; without this
            // the whole endpoint answered 500 and nothing said why.
            .groupBy(oauthClient.disabled),
          handle.db
            .select({ total: count() })
            .from(auditLog)
            .where(
              and(
                eq(auditLog.action, "signin.success"),
                gte(auditLog.createdAt, dayAgo)
              )
            ),
          handle.db
            .select({ total: count() })
            .from(auditLog)
            .where(
              and(
                eq(auditLog.action, "signin.failure"),
                gte(auditLog.createdAt, dayAgo)
              )
            ),
          // Counted in JS: `role` is a comma-separated column, so no `group by`
          // can answer this question correctly.
          handle.db.select({ role: user.role, banned: user.banned }).from(user),
        ])

      const adminRoles = new Set(deps.config.adminRoles)
      return ctx.json({
        users: {
          total: byStatus.reduce((sum, row) => sum + row.total, 0),
          pending: totalFor(byStatus, "pending"),
          active: totalFor(byStatus, "active"),
          rejected: totalFor(byStatus, "rejected"),
          banned: roles.filter((row) => row.banned === true).length,
          admins: roles.filter((row) =>
            splitRoles(row.role).some((role) => adminRoles.has(role))
          ).length,
        },
        sessions: { active: sessions[0]?.total ?? 0 },
        clients: {
          total: clients.reduce((sum, row) => sum + row.total, 0),
          disabled: clients
            .filter((row) => row.disabled === true)
            .reduce((sum, row) => sum + row.total, 0),
        },
        signIns24h: recentSignIns[0]?.total ?? 0,
        signInFailures24h: failures[0]?.total ?? 0,
      })
    }
  )

  /**
   * The audit browser's query (SEC-6).
   *
   * Keyset pagination on `(createdAt, id)` rather than `offset`: the table only
   * ever grows at the head, and an offset walk over a busy trail silently
   * repeats and skips rows as new ones land between pages.
   */
  const auditQuery = createAuthEndpoint(
    "/idp/audit",
    {
      method: "GET",
      requireHeaders: true,
      query: z.object({
        action: z.string().optional(),
        outcome: z.enum(["success", "failure", "denied"]).optional(),
        actorUserId: z.string().optional(),
        targetId: z.string().optional(),
        /** `createdAt` of the last row on the previous page, ISO-8601. */
        before: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      use: [gate],
    },
    async (ctx) => {
      const handle = db(deps)
      const { auditLog } = handle.schema
      const query = ctx.query

      const filters = [
        query.action ? eq(auditLog.action, query.action) : undefined,
        query.outcome ? eq(auditLog.outcome, query.outcome) : undefined,
        query.actorUserId
          ? eq(auditLog.actorUserId, query.actorUserId)
          : undefined,
        query.targetId ? eq(auditLog.targetId, query.targetId) : undefined,
        query.before
          ? lt(auditLog.createdAt, new Date(query.before))
          : undefined,
      ].filter((filter) => filter !== undefined)

      const rows = await handle.db
        .select()
        .from(auditLog)
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
        .limit(query.limit + 1)

      const page = rows.slice(0, query.limit)
      return ctx.json({
        events: page,
        // The cursor is the *row's* timestamp, so the next page starts exactly
        // where this one stopped however many rows share that second.
        nextBefore:
          rows.length > query.limit ? (page.at(-1)?.createdAt ?? null) : null,
      })
    }
  )

  /** What this process is actually running (FR-ADMIN-2, OPS-3). */
  const systemInfo = createAuthEndpoint(
    "/idp/system",
    { method: "GET", requireHeaders: true, use: [gate] },
    async (ctx) => {
      const handle = db(deps)
      const { jwks } = handle.schema

      const keys = await handle.db
        .select({
          id: jwks.id,
          createdAt: jwks.createdAt,
          expiresAt: jwks.expiresAt,
        })
        .from(jwks)
        .orderBy(desc(jwks.createdAt))

      const now = Date.now()
      return ctx.json({
        version,
        revision: revision ?? null,
        issuer: deps.config.base.origin + deps.config.base.basePath,
        // SEC-5: masked, positionally, by the same function `idp config
        // validate` prints through.
        config: maskConfig(deps.config.file),
        email: {
          enabled: deps.mailer?.enabled ?? false,
          transport: deps.mailer?.transport ?? "none",
        },
        signingKeys: {
          algorithm: deps.config.file.jwt.algorithm,
          // The *newest live* key is the one signing, which is the whole point
          // of the publish-then-sign rotation (R11) and not obvious from a
          // list ordered by age alone.
          activeKeyId:
            keys.find((key) => !key.expiresAt || key.expiresAt.getTime() > now)
              ?.id ?? null,
          published: keys.length,
          retiring: keys.filter(
            (key) => key.expiresAt && key.expiresAt.getTime() > now
          ).length,
        },
        startup: {
          steps: deps.context?.startup?.steps ?? [],
          reconcile: deps.context?.startup?.reconcile ?? null,
        },
      })
    }
  )

  /**
   * FR-OIDC-16: rotate the signing key now.
   *
   * The rotation needs a *direct* connection for its advisory lock — a session
   * lock does not survive a transaction pooler (S4) — and the one startup used
   * is closed by then. So this opens its own, and closes it whatever happens:
   * a leaked direct connection is one of the few things that can exhaust a
   * small Postgres `max_connections` from a button nobody presses twice.
   */
  const rotateKeysEndpoint = createAuthEndpoint(
    "/idp/rotate-keys",
    { method: "POST", requireHeaders: true, use: [gate] },
    async (ctx) => {
      const handle = db(deps)
      const auth = deps.context?.auth
      if (!auth) {
        throw new APIError("SERVICE_UNAVAILABLE", {
          message: "The server is still starting up.",
        })
      }

      const locking = createDb(deps.config, { direct: true, max: 1 })
      try {
        const result = await rotateKeys({
          config: deps.config,
          database: handle,
          locking,
          auth,
          audit: deps.audit,
          logger: deps.logger,
        })
        return ctx.json({
          ...result,
          actorUserId: ctx.context.session.user.id,
        })
      } finally {
        await locking.close().catch(() => undefined)
      }
    }
  )

  return {
    resetTwoFactor,
    adminStats,
    auditQuery,
    systemInfo,
    rotateKeys: rotateKeysEndpoint,
  }
}

function totalFor(
  rows: { status: string | null; total: number }[],
  status: string
): number {
  return rows.find((row) => row.status === status)?.total ?? 0
}
