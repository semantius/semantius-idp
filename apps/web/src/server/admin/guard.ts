/**
 * The invariants, enforced where the writes actually happen (FR-ADMIN-3/5,
 * FR-ROLE-3, FR-ADMIN-6).
 *
 * Better Auth's admin plugin does the bans, the role changes and the deletes,
 * and it does them well — but it has no idea that this deployment must always
 * keep one administrator, and no opinion about an admin banning themselves.
 * Those rules cannot live in the UI: FR-ADMIN-6 says the admin API is a
 * documented interface, so anything the buttons refuse must also be refused to
 * a `curl` holding an admin API key. Hence a `before` hook on the mutating
 * endpoints, with the UI simply never offering what the hook would refuse.
 *
 * **Impersonation** is gated here rather than by leaving the endpoint out:
 * `admin.allowImpersonation` defaults to false and the plugin has no switch
 * for it, so with the endpoint registered unconditionally this hook is the
 * thing that answers 403 (FR-ADMIN-5).
 *
 * What this hook deliberately does *not* do is authorise. The admin plugin's
 * own middleware already refuses non-admins on every one of these paths; a
 * second implementation of that check here would be a second thing to keep in
 * step with `admin.adminRoles`.
 */

import {
  APIError,
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
} from "better-auth/api"

import type { AuthMiddleware } from "better-auth/api"

import type { Audit } from "../audit"
import type { AuditAction } from "../auth/plugins/idp-plugin"
import type { IdpConfig } from "../config/derive"
import type { DbHandle } from "../db/client"
import type { Logger } from "../logger"
import { resetGatewayTokenCache } from "../gateways/proxy"
import { revokeAllForUser } from "../oidc/revoke-user-tokens"
import { loadAdmins } from "./admins"
import {
  AdminInvariantError,
  assertAdminInvariants
  
  
} from "./invariants"
import type {AdminAction, AdminInvariantUser} from "./invariants";

/**
 * Who was being impersonated, remembered across the two hooks (**D66**).
 *
 * `/admin/stop-impersonating` is the one endpoint whose audit row cannot be
 * assembled after the fact. It declares no session middleware, so
 * `ctx.context.session` is not populated for it; by the time the *after* hook
 * runs the impersonated session row has been deleted, so reading the request's
 * cookie then finds nothing; and what the endpoint returns is the
 * administrator's restored session, which does not name the person they were
 * impersonating. So the before hook reads it and leaves it here.
 *
 * Keyed on the per-request context object — `ctx.context` is where Better Auth
 * puts `returned` and `responseHeaders`, so it is per-request and not the
 * shared instance — and a `WeakMap`, so a request that never reaches the after
 * hook leaves nothing behind.
 */
const IMPERSONATION_ENDING = new WeakMap<
  object,
  { impersonated: string; by?: string }
>()

/**
 * The before hook's half of that, exported so the pairing is one named thing
 * rather than a `WeakMap` two functions happen to share — and so the after
 * hook's behaviour can be asserted without a running Better Auth.
 */
export function rememberEndingImpersonation(
  context: object,
  ending: { impersonated: string; by?: string }
): void {
  IMPERSONATION_ENDING.set(context, ending)
}

export interface AdminGuardDeps {
  config: IdpConfig
  /** Absent during schema generation, which performs no writes. */
  database?: DbHandle
  audit?: Audit
  logger?: Logger
}

/**
 * The paths this guard has an opinion about.
 *
 * Two kinds, and the second is newer (**D66**). The first five carry an
 * *invariant* — the last administrator, self-bans, impersonation being off —
 * and the guard refuses them. The rest carry no invariant at all and are here
 * for the audit row: FR-ADMIN-6 says the admin API is a supported interface,
 * and until D66 a `curl` to `/admin/create-user`, `/admin/set-user-password`
 * or `/admin/revoke-user-sessions` left no trace, because the only writes were
 * in the route handlers behind the buttons.
 *
 * **`guard.ts` owns `/admin/*` auditing** from here on. `hooks.ts`'s
 * `auditEventFor` stays the choke point for Better Auth's own surface, and a
 * manual write in a route survives only where no hook can see the event. That
 * split is the thing D66 records, because the alternative had already
 * happened: `impersonation.started` was written twice on the UI path, once
 * here and once in `http/admin-actions.ts`.
 */
const GUARDED = new Set([
  "/admin/set-role",
  "/admin/ban-user",
  "/admin/remove-user",
  "/admin/update-user",
  "/admin/impersonate-user",
  "/admin/create-user",
  "/admin/set-user-password",
  "/admin/revoke-user-sessions",
  "/admin/stop-impersonating",
])

export function isGuardedAdminPath(path: string): boolean {
  return GUARDED.has(path)
}

/**
 * Endpoints that end a credential's usefulness without being admin endpoints
 * (**D91**, extended by **D92**).
 *
 * The gateway caches a credential → JWT exchange, and a cache hit skips the
 * re-check — so anything that revokes a credential has to empty that cache in
 * the same process, or it goes on opening gateways for up to ten minutes.
 *
 * `/api-key/delete` is the api-key plugin's own, reachable from `/account` and
 * from `/admin/users/:id` alike; `/api-key/update` is how a key is disabled or
 * re-dated. The four session paths arrived with **D92**, which made a session
 * cookie a gateway credential in its own right: without them, signing out
 * would leave the JWT that cookie was exchanged for working until the TTL.
 * `/admin/revoke-user-sessions` needs no entry — it is already `GUARDED`.
 */
const ENDS_CREDENTIAL_ACCESS = new Set([
  "/api-key/delete",
  "/api-key/update",
  "/sign-out",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
])

interface AdminBody {
  userId?: unknown
  role?: unknown
  data?: unknown
}

/**
 * Turns a request into the action the rules are written in terms of.
 *
 * `update-user` is the awkward one: it is a generic patch, so it counts as a
 * ban or a rejection only when the patch actually contains one. A patch that
 * changes a display name is not an administrative action in this sense and
 * must not be refused for being the last admin's.
 */
export function actionForPath(
  path: string,
  body: AdminBody
): AdminAction | undefined {
  switch (path) {
    case "/admin/set-role":
      return { kind: "set-role", roles: rolesFrom(body.role) }
    case "/admin/ban-user":
      return { kind: "ban" }
    case "/admin/remove-user":
      return { kind: "delete" }
    case "/admin/impersonate-user":
      return { kind: "impersonate" }
    case "/admin/update-user": {
      const data = (body.data ?? {}) as Record<string, unknown>
      if (data.banned === true) return { kind: "ban" }
      if (data.status === "rejected") return { kind: "reject" }
      if (typeof data.role === "string" || Array.isArray(data.role)) {
        return { kind: "set-role", roles: rolesFrom(data.role) }
      }
      return undefined
    }
    default:
      return undefined
  }
}

function rolesFrom(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string")
  }
  if (typeof value === "string") return value.split(",").map((r) => r.trim())
  return []
}

/** The `before` hook. Throws an `APIError`, or returns and lets the write run. */
export function buildAdminGuard(deps: AdminGuardDeps): AuthMiddleware {
  return createAuthMiddleware(async (ctx) => {
    const path = ctx.path
    if (!isGuardedAdminPath(path)) return

    if (path === "/admin/impersonate-user" && !deps.config.allowImpersonation) {
      // FR-ADMIN-5: off by default, and off means the endpoint does not work —
      // not that it works and the UI hides the button.
      throw new APIError("FORBIDDEN", {
        message: "Impersonation is disabled on this server.",
        code: "IMPERSONATION_DISABLED",
      })
    }

    if (path === "/admin/stop-impersonating") {
      const ending = await getAuthoritativeSessionFromCtx(ctx)
      const impersonated = ending?.user.id
      const by = (ending?.session as { impersonatedBy?: unknown } | undefined)
        ?.impersonatedBy
      if (typeof impersonated === "string") {
        rememberEndingImpersonation(ctx.context, {
          impersonated,
          by: typeof by === "string" ? by : undefined,
        })
      }
      return
    }

    const body = (ctx.body ?? {}) as AdminBody
    const action = actionForPath(path, body)
    if (!action) return

    const targetId = typeof body.userId === "string" ? body.userId : undefined
    // No target, no session, no database: each of these is somebody else's
    // answer to give — the endpoint's validation, the admin gate, or the
    // schema generator that has no connection at all.
    if (!targetId || !deps.database) return

    const session = await getAuthoritativeSessionFromCtx(ctx)
    if (!session?.user) return

    const target = (await ctx.context.internalAdapter.findUserById(
      targetId
    )) as AdminInvariantUser | null
    if (!target) return

    try {
      assertAdminInvariants({
        actor: session.user as AdminInvariantUser,
        target,
        action,
        adminRoles: deps.config.adminRoles,
        admins: await loadAdmins(deps.database, deps.config.adminRoles),
      })
    } catch (error) {
      if (!(error instanceof AdminInvariantError)) throw error
      // A refused administrative action is worth a row of its own: it is how
      // an operator later explains why the ban they remember ordering never
      // happened.
      await deps.audit?.record({
        action: auditActionFor(action),
        outcome: "denied",
        actorType: "session",
        actorUserId: session.user.id,
        target: { type: "user", id: targetId },
        metadata: { reason: error.code },
      })
      throw new APIError("FORBIDDEN", {
        message: error.message,
        code: error.code.toUpperCase(),
      })
    }
  })
}

/**
 * What a completed admin mutation has to do beyond the row it wrote
 * (FR-ADMIN-4, FR-OIDC-12, SEC-6).
 *
 * The admin plugin deletes the user's sessions when it bans or removes them,
 * but it knows nothing about OAuth: without this, a banned user's refresh
 * token keeps minting access tokens for as long as the client cares to ask.
 *
 * The revocation runs *after* the write and a failure is logged rather than
 * thrown — the ban is already real, and turning a partial success into a 500
 * would invite the administrator to press the button again instead of telling
 * them what actually needs fixing.
 */
export function buildAdminAfterHook(deps: AdminGuardDeps): AuthMiddleware {
  return createAuthMiddleware(async (ctx) => {
    const path = ctx.path
    const isUnban = path === "/admin/unban-user"

    // **D91's punch-through**, widened to sessions by **D92**. The gateway
    // caches a credential → JWT exchange for up to ten minutes, and a cache
    // hit skips the FR-KEY-2 owner re-check — so without this a suspended
    // user's key, or a signed-out browser's session, would keep opening every
    // gateway until the entry expired. Cheap (three `Map.clear()`s) and rare,
    // so it is unconditional rather than scoped to the affected credential:
    // this hook does not know which key or session belongs to whom, and a
    // targeted invalidation would be a second place that has to agree.
    //
    // Here, in the hook, rather than in the route handlers behind the buttons,
    // for **D67**'s reason: the admin API is a supported interface, so a
    // `curl` to `/admin/ban-user` has to leave the process in the same state
    // the UI does.
    if (
      (isUnban ||
        isGuardedAdminPath(path) ||
        ENDS_CREDENTIAL_ACCESS.has(path)) &&
      !(ctx.context.returned instanceof APIError)
    ) {
      resetGatewayTokenCache()
    }

    if (!isUnban && !isGuardedAdminPath(path)) return

    // A thrown `APIError` reaches this slot as the returned value; there is
    // nothing to follow up on a write that did not happen.
    if (ctx.context.returned instanceof APIError) return

    const body = (ctx.body ?? {}) as AdminBody
    const actorId = ctx.context.session?.user.id

    // The endpoints that carry no invariant and are guarded purely so that a
    // direct API call leaves the same trail the UI does (**D66**).
    const plain = plainAuditFor(path, ctx, body)
    if (plain) {
      await deps.audit?.record({
        action: plain.action,
        outcome: "success",
        actorType: "session",
        actorUserId: plain.actorId ?? actorId,
        target: { type: "user", id: plain.targetId },
        metadata: plain.metadata,
      })
      if (plain.endsAccess) await revokeTokens(deps, plain.targetId, "revoke")
      return
    }

    const targetId = typeof body.userId === "string" ? body.userId : undefined
    if (!targetId) return

    if (isUnban) {
      // FR-KEY-2: nothing to restore explicitly — the API keys were never
      // deleted, and the per-use check starts passing again by itself.
      await deps.audit?.record({
        action: "user.unbanned",
        outcome: "success",
        actorType: "session",
        actorUserId: actorId,
        target: { type: "user", id: targetId },
      })
      return
    }

    const action = actionForPath(path, body)
    if (!action) return

    await deps.audit?.record({
      action: auditActionFor(action),
      outcome: "success",
      actorType: "session",
      actorUserId: actorId,
      target: { type: "user", id: targetId },
      metadata:
        action.kind === "set-role" ? { roles: action.roles } : undefined,
    })

    if (!endsAccess(action)) return
    await revokeTokens(deps, targetId, action.kind)
  })
}

/**
 * The OAuth half of an administrative action (FR-OIDC-12).
 *
 * Better Auth's admin plugin deletes `session` rows and has no idea this
 * deployment issues tokens, so every action that ends someone's access has a
 * second half, and it is this one. It lives here — in the `after` hook — and
 * **not** in the route handler behind the button, because a hook runs for
 * every caller: FR-ADMIN-6 makes the admin API a supported interface, and
 * `docs/admin-api.md` promises `/admin/revoke-user-sessions` "signs them out
 * everywhere" whoever asks (**D67**).
 *
 * Runs after the write, and a failure is logged rather than thrown — the ban
 * is already real, and turning a partial success into a 500 would invite the
 * administrator to press the button again instead of telling them what
 * actually needs fixing.
 */
async function revokeTokens(
  deps: AdminGuardDeps,
  userId: string,
  reason: string
): Promise<void> {
  if (!deps.database) return
  try {
    await revokeAllForUser(
      { database: deps.database, audit: deps.audit },
      { userId, reason: `admin:${reason}` }
    )
  } catch (error) {
    deps.logger?.error("could not revoke OAuth tokens after an admin action", {
      error: error instanceof Error ? error.message : String(error),
      userId,
      action: reason,
    })
  }
}

export interface PlainAudit {
  action: AuditAction
  targetId: string
  actorId?: string
  metadata?: Record<string, unknown>
  /**
   * The user should hold no live OAuth tokens afterwards (**D67**).
   *
   * Same rule as {@link endsAccess} for the invariant-carrying paths; it is a
   * field here because these endpoints have no `AdminAction` to ask about.
   */
  endsAccess?: boolean
}

/**
 * The audit row for an endpoint with no invariant behind it (**D66**).
 *
 * Two things degrade here on purpose, and saying so is the point of the
 * comment. `/admin/create-user` has no `body.userId` — the account did not
 * exist when the request was made — so the target comes out of what the
 * endpoint returned. And `/admin/set-user-password`'s `temporary: true` is
 * gone: it was true of the *route*, which follows the password with a second
 * call setting `mustChangePassword`, and is not derivable from this one
 * endpoint. Half-deriving it would make the flag mean "probably" in a table
 * whose whole value is that it does not.
 */
export function plainAuditFor(
  path: string,
  ctx: { context: { returned?: unknown } },
  body: AdminBody
): PlainAudit | undefined {
  const targetId = typeof body.userId === "string" ? body.userId : undefined

  switch (path) {
    case "/admin/create-user": {
      const returned = ctx.context.returned as
        | { user?: { id?: unknown } }
        | undefined
      const id = returned?.user?.id
      if (typeof id !== "string") return undefined
      return {
        action: "user.created",
        targetId: id,
        metadata: { by: "admin", roles: rolesFrom(body.role) },
      }
    }
    case "/admin/set-user-password":
      if (!targetId) return undefined
      return { action: "password.changed", targetId }
    case "/admin/revoke-user-sessions":
      if (!targetId) return undefined
      return {
        action: "session.revoked",
        targetId,
        metadata: { scope: "all" },
        // FR-OIDC-12, and **D67**: the admin plugin deletes `session` rows and
        // knows nothing about OAuth, so without this the user is signed out of
        // the browser and their refresh token goes on minting access tokens.
        endsAccess: true,
      }
    case "/admin/stop-impersonating": {
      // Read by the *before* hook and left in `IMPERSONATION_ENDING`, for the
      // three reasons set out there. The target is the person who was being
      // impersonated; the actor is the administrator who started it
      // (FR-ADMIN-5).
      const ending = IMPERSONATION_ENDING.get(ctx.context)
      if (!ending) return undefined
      return {
        action: "impersonation.stopped",
        targetId: ending.impersonated,
        actorId: ending.by,
      }
    }
    default:
      return undefined
  }
}

/** Whether the action means the user should hold no live tokens afterwards. */
function endsAccess(action: AdminAction): boolean {
  return (
    action.kind === "ban" ||
    action.kind === "delete" ||
    action.kind === "reject"
  )
}

function auditActionFor(action: AdminAction): AuditAction {
  switch (action.kind) {
    case "ban":
      return "user.banned"
    case "reject":
      return "signup.rejected"
    case "delete":
      return "user.deleted"
    case "set-role":
      return "user.roles_changed"
    case "impersonate":
      return "impersonation.started"
    default:
      return "user.banned"
  }
}
