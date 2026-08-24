/**
 * Everything `/admin/*` renders from (FR-ADMIN-2).
 *
 * The same rule as `functions/account.ts`: loaders are isomorphic, so anything
 * they import reaches the client bundle, and `createServerFn` is the seam that
 * keeps Drizzle, Better Auth and the configuration out of it. **Reads only** —
 * every mutation is a form POST to a route's own `server.handlers`, where the
 * invariants (`admin/guard.ts`), the fresh-session gate and the audit trail
 * live.
 *
 * Each function checks the admin role itself rather than trusting the layout
 * route to have done it. A server function is an HTTP endpoint whatever the
 * page around it does, and "the loader already checked" is not true of a
 * `POST /_serverFn/…` someone types by hand.
 *
 * A caller who is not an administrator gets `null`, not a 403: the pages turn
 * that into the same "you do not have access" screen an anonymous visitor sees,
 * which keeps the existence of an admin area from being a probe target.
 */

import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lt,
  or,
} from "drizzle-orm"

import type { SQL } from "drizzle-orm"

import { readSession } from "../http/session"
import type { RouteSession } from "../http/session"
import { isAdmin, splitRoles } from "../role-utils"
import { getRuntime } from "../runtime"
import type { Runtime } from "../runtime"

/** A row of the user list. */
export interface AdminUserRow {
  id: string
  email: string
  name: string
  status: string
  banned: boolean
  banReason?: string
  banExpires?: string
  emailVerified: boolean
  twoFactorEnabled: boolean
  mustChangePassword: boolean
  /** Every stored role, catalog or not — the detail page flags the unknown ones. */
  roles: string[]
  createdAt: string
}

export interface AdminUserPage {
  users: AdminUserRow[]
  total: number
  page: number
  pageSize: number
}

export interface AdminUserDetail extends AdminUserRow {
  identities: {
    providerId: string
    accountId: string
    createdAt: string
  }[]
  sessions: {
    id: string
    createdAt: string
    expiresAt: string
    ipAddress?: string
    userAgent?: string
    impersonated: boolean
  }[]
  apiKeys: {
    id: string
    name: string
    start?: string
    enabled: boolean
    createdAt: string
    expiresAt?: string
    lastRequest?: string
  }[]
  events: AdminAuditRow[]
  /** True when this account has ever hit the D24 address collision. */
  profileConflict: boolean
  /** Roles held that are no longer in `roles.json` (FR-ROLE-2). */
  unknownRoles: string[]
}

export interface AdminAuditRow {
  id: string
  action: string
  outcome: string
  actorUserId?: string
  actorType?: string
  targetType?: string
  targetId?: string
  ipAddress?: string
  requestId?: string
  /**
   * Compact JSON, not the object. Server functions serialise their return
   * value through a typed channel that refuses `unknown`, and the page renders
   * this as text anyway — parsing it back to re-print it would be a round trip
   * with nothing in the middle.
   */
  metadata?: string
  createdAt: string
}

export interface AdminStats {
  users: {
    total: number
    pending: number
    active: number
    rejected: number
    banned: number
    admins: number
  }
  sessions: number
  clients: { total: number; disabled: number }
  signIns24h: number
  signInFailures24h: number
  /** Warnings the operator should see on the dashboard, not only in the log. */
  warnings: string[]
}

export interface AdminClientRow {
  clientId: string
  name: string
  disabled: boolean
  isPublic: boolean
  redirectUris: string[]
  scopes: string[]
  audience: string[]
  skipConsent: boolean
  /** File-managed clients cannot be edited here (FR-OIDC-2). */
  managedBy: "file" | "database"
}

export interface AdminRoleRow {
  name: string
  description?: string
  isDefault: boolean
  isAdmin: boolean
  /** How many users hold it, counted across the comma-separated column. */
  users: number
}

export interface AdminSystemInfo {
  version: string
  revision: string | null
  issuer: string
  email: { enabled: boolean; transport: string }
  signingKeys: {
    algorithm: string
    activeKeyId: string | null
    published: number
    retiring: number
  }
  startup: { steps: { name: string; skipped?: string }[] }
  /** Pretty-printed JSON; the page shows it in a `<pre>`. */
  reconcile: string | null
  /** Pretty-printed **masked** JSON (SEC-5). */
  config: string
  warnings: string[]
}

/** Resolves the caller, and refuses anyone who is not an administrator. */
async function admin(): Promise<
  { runtime: Runtime; session: RouteSession } | undefined
> {
  const runtime = await getRuntime()
  // Authoritative: a role taken away has to bite on the next page load, not
  // whenever the ≤ 5 min cookie cache happens to expire (FR-AUTH-5).
  const session = await readSession(runtime, getRequest(), {
    authoritative: true,
  })
  if (!session) return undefined
  if (!isAdmin(session.user.roles.join(","), runtime.config.adminRoles)) {
    return undefined
  }
  return { runtime, session }
}

/**
 * Whether the caller may see `/admin/*` at all — the layout route's gate.
 *
 * Three answers, not two. "Not signed in" and "signed in but not an
 * administrator" want different treatment: the first is fixed by signing in,
 * so it redirects; the second is not, so bouncing them to a login form they
 * have already completed would be a loop. The distinction is safe to reveal —
 * anyone can tell whether they are signed in.
 */
export type AdminGate =
  | { signedIn: false }
  | { signedIn: true; admin: false }
  | { signedIn: true; admin: true; email: string; impersonated: boolean }

export const fetchAdminGate = createServerFn({ method: "GET" }).handler(
  async (): Promise<AdminGate> => {
    const runtime = await getRuntime()
    const session = await readSession(runtime, getRequest(), {
      authoritative: true,
    })
    if (!session) return { signedIn: false }
    if (!isAdmin(session.user.roles.join(","), runtime.config.adminRoles)) {
      return { signedIn: true, admin: false }
    }
    return {
      signedIn: true,
      admin: true,
      email: session.user.email,
      impersonated: session.session.impersonatedBy !== undefined,
    }
  }
)

export const fetchAdminStats = createServerFn({ method: "GET" }).handler(
  async (): Promise<AdminStats | null> => {
    const context = await admin()
    if (!context) return null
    const { runtime } = context
    const { user, session, oauthClient } = runtime.database.schema
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)

    const [rows, sessions, clients, signIns, failures] = await Promise.all([
      runtime.database.db
        .select({
          status: user.status,
          banned: user.banned,
          role: user.role,
        })
        .from(user),
      runtime.database.db
        .select({ total: count() })
        .from(session)
        .where(gte(session.expiresAt, new Date())),
      runtime.database.db
        .select({ disabled: oauthClient.disabled, total: count() })
        .from(oauthClient)
        .groupBy(oauthClient.disabled),
      countEvents(runtime, "signin.success", dayAgo),
      countEvents(runtime, "signin.failure", dayAgo),
    ])

    const adminRoles = new Set(runtime.config.adminRoles)
    return {
      users: {
        total: rows.length,
        pending: rows.filter((row) => row.status === "pending").length,
        active: rows.filter((row) => row.status === "active").length,
        rejected: rows.filter((row) => row.status === "rejected").length,
        banned: rows.filter((row) => row.banned === true).length,
        admins: rows.filter((row) =>
          splitRoles(row.role).some((role) => adminRoles.has(role))
        ).length,
      },
      sessions: sessions[0]?.total ?? 0,
      clients: {
        total: clients.reduce((sum, row) => sum + row.total, 0),
        disabled: clients
          .filter((row) => row.disabled === true)
          .reduce((sum, row) => sum + row.total, 0),
      },
      signIns24h: signIns,
      signInFailures24h: failures,
      warnings: runtime.warnings.map((warning) => warning.message),
    }
  }
)

async function countEvents(
  runtime: Runtime,
  action: string,
  since: Date
): Promise<number> {
  const { auditLog } = runtime.database.schema
  const rows = await runtime.database.db
    .select({ total: count() })
    .from(auditLog)
    // `gte`, not a raw `sql` template. The template binds the `Date` with no
    // type for the driver to work from, and Postgres refuses to compare it
    // with a `timestamp` — which took the whole dashboard down with a 500 that
    // said nothing until the page was actually loaded.
    .where(and(eq(auditLog.action, action), gte(auditLog.createdAt, since)))
  return rows[0]?.total ?? 0
}

export interface UserQuery {
  q?: string
  status?: string
  role?: string
  banned?: boolean
  sort?: "createdAt" | "email" | "status"
  direction?: "asc" | "desc"
  page?: number
  pageSize?: number
}

export const fetchUsers = createServerFn({ method: "GET" })
  .inputValidator((input: UserQuery) => input)
  .handler(async ({ data }): Promise<AdminUserPage | null> => {
    const context = await admin()
    if (!context) return null
    const { runtime } = context
    const { user } = runtime.database.schema

    const pageSize = clamp(data.pageSize ?? 25, 10, 200)
    const page = Math.max(1, data.page ?? 1)

    const filters: SQL[] = []
    if (data.q) {
      const needle = `%${data.q}%`
      const matched = or(ilike(user.email, needle), ilike(user.name, needle))
      if (matched) filters.push(matched)
    }
    if (data.status) {
      filters.push(eq(user.status, data.status as "pending"))
    }
    // The comma-separated column again: `like` narrows, `splitRoles` decides.
    if (data.role) filters.push(ilike(user.role, `%${data.role}%`))
    if (data.banned === true) filters.push(eq(user.banned, true))

    const where = filters.length ? and(...filters) : undefined
    const column =
      data.sort === "email"
        ? user.email
        : data.sort === "status"
          ? user.status
          : user.createdAt
    const order = data.direction === "asc" ? asc(column) : desc(column)

    const [rows, totals] = await Promise.all([
      runtime.database.db
        .select()
        .from(user)
        .where(where)
        .orderBy(order)
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      runtime.database.db.select({ total: count() }).from(user).where(where),
    ])

    const exact = data.role
      ? rows.filter((row) => splitRoles(row.role).includes(data.role as string))
      : rows

    return {
      users: exact.map(toUserRow),
      total: totals[0]?.total ?? 0,
      page,
      pageSize,
    }
  })

export const fetchUserDetail = createServerFn({ method: "GET" })
  .inputValidator((userId: string) => userId)
  .handler(async ({ data: userId }): Promise<AdminUserDetail | null> => {
    const context = await admin()
    if (!context) return null
    const { runtime } = context
    const schema = runtime.database.schema

    const rows = await runtime.database.db
      .select()
      .from(schema.user)
      .where(eq(schema.user.id, userId))
      .limit(1)
    const found = rows[0]
    if (!found) return null

    const [identities, sessions, apiKeys, events] = await Promise.all([
      runtime.database.db
        .select()
        .from(schema.account)
        .where(eq(schema.account.userId, userId)),
      runtime.database.db
        .select()
        .from(schema.session)
        .where(eq(schema.session.userId, userId))
        .orderBy(desc(schema.session.createdAt)),
      runtime.database.db
        .select()
        .from(schema.apikey)
        // `referenceId`, not `userId`: the api-key plugin names its owner
        // column that, and the table has no `userId` at all.
        .where(eq(schema.apikey.referenceId, userId))
        .orderBy(desc(schema.apikey.createdAt)),
      runtime.database.db
        .select()
        .from(schema.auditLog)
        .where(
          or(
            eq(schema.auditLog.targetId, userId),
            eq(schema.auditLog.actorUserId, userId)
          )
        )
        .orderBy(desc(schema.auditLog.createdAt))
        .limit(25),
    ])

    const catalog = new Set(runtime.config.roles.map((role) => role.name))
    const held = splitRoles(found.role)

    return {
      ...toUserRow(found),
      identities: identities.map((row) => ({
        providerId: row.providerId,
        accountId: row.accountId,
        createdAt: iso(row.createdAt),
      })),
      sessions: sessions.map((row) => ({
        id: row.id,
        createdAt: iso(row.createdAt),
        expiresAt: iso(row.expiresAt),
        ipAddress: row.ipAddress ?? undefined,
        userAgent: row.userAgent ?? undefined,
        impersonated: row.impersonatedBy !== null,
      })),
      apiKeys: apiKeys.map((row) => ({
        id: row.id,
        name: row.name ?? "",
        start: row.start ?? undefined,
        enabled: row.enabled ?? false,
        createdAt: iso(row.createdAt),
        expiresAt: row.expiresAt ? iso(row.expiresAt) : undefined,
        lastRequest: row.lastRequest ? iso(row.lastRequest) : undefined,
      })),
      events: events.map(toAuditRow),
      // D24: the sign-in that was refused because the address already belonged
      // to someone else. Worth surfacing on the person's own page — it is the
      // single most confusing failure a user reports.
      profileConflict: events.some(
        (row) => row.action === "social.profile_conflict"
      ),
      unknownRoles: held.filter((role) => !catalog.has(role)),
    }
  })

export interface AuditQuery {
  action?: string
  outcome?: string
  actorUserId?: string
  targetId?: string
  before?: string
  limit?: number
}

export const fetchAuditPage = createServerFn({ method: "GET" })
  .inputValidator((input: AuditQuery) => input)
  .handler(
    async ({
      data,
    }): Promise<{
      events: AdminAuditRow[]
      nextBefore: string | null
      actions: string[]
    } | null> => {
      const context = await admin()
      if (!context) return null
      const { runtime } = context
      const { auditLog } = runtime.database.schema
      const limit = clamp(data.limit ?? 50, 10, 200)

      const filters: SQL[] = []
      if (data.action) filters.push(eq(auditLog.action, data.action))
      if (data.outcome) filters.push(eq(auditLog.outcome, data.outcome))
      if (data.actorUserId) {
        filters.push(eq(auditLog.actorUserId, data.actorUserId))
      }
      if (data.targetId) filters.push(eq(auditLog.targetId, data.targetId))
      if (data.before) {
        filters.push(lt(auditLog.createdAt, new Date(data.before)))
      }

      const rows = await runtime.database.db
        .select()
        .from(auditLog)
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
        .limit(limit + 1)

      const page = rows.slice(0, limit)
      const actions = await runtime.database.db
        .selectDistinct({ action: auditLog.action })
        .from(auditLog)
        .orderBy(asc(auditLog.action))

      return {
        events: page.map(toAuditRow),
        // Keyset, not offset: the trail only grows at the head, and an offset
        // walk silently repeats rows as new ones land between pages.
        nextBefore: rows.length > limit ? iso(page.at(-1)?.createdAt) : null,
        actions: actions.map((row) => row.action),
      }
    }
  )

export const fetchClients = createServerFn({ method: "GET" }).handler(
  async (): Promise<AdminClientRow[] | null> => {
    const context = await admin()
    if (!context) return null
    const { runtime } = context
    const schema = runtime.database.schema

    const [clients, links, resources] = await Promise.all([
      runtime.database.db
        .select()
        .from(schema.oauthClient)
        .orderBy(asc(schema.oauthClient.name)),
      runtime.database.db.select().from(schema.oauthClientResource),
      runtime.database.db.select().from(schema.oauthResource),
    ])

    const fileClients = new Set(
      runtime.config.clients.map((client) => client.clientId)
    )
    const resourceById = new Map(
      resources.map((row) => [row.id, row.identifier])
    )

    return clients.map((row) => ({
      clientId: row.clientId,
      name: row.name ?? row.clientId,
      disabled: row.disabled === true,
      // A client with no secret is a public client; the column that would say
      // so directly does not exist on this table.
      isPublic: row.clientSecret === null,
      redirectUris: row.redirectUris,
      scopes: row.scopes ?? [],
      audience: links
        .filter((link) => link.clientId === row.id)
        .map((link) => resourceById.get(link.resourceId))
        .filter((value): value is string => value !== undefined),
      skipConsent: row.skipConsent === true,
      managedBy: fileClients.has(row.clientId) ? "file" : "database",
    }))
  }
)

export const fetchRoles = createServerFn({ method: "GET" }).handler(
  async (): Promise<AdminRoleRow[] | null> => {
    const context = await admin()
    if (!context) return null
    const { runtime } = context
    const rows = await runtime.database.db
      .select({ role: runtime.database.schema.user.role })
      .from(runtime.database.schema.user)

    const adminRoles = new Set(runtime.config.adminRoles)
    return runtime.config.roles.map((role) => ({
      name: role.name,
      description: role.description,
      isDefault: role.name === runtime.config.defaultRole,
      isAdmin: adminRoles.has(role.name),
      users: rows.filter((row) => splitRoles(row.role).includes(role.name))
        .length,
    }))
  }
)

export const fetchSystemInfo = createServerFn({ method: "GET" }).handler(
  async (): Promise<AdminSystemInfo | null> => {
    const context = await admin()
    if (!context) return null
    const { runtime } = context

    // Through the endpoint rather than around it, so the page and a `curl`
    // holding an admin API key see byte-for-byte the same document — including
    // the same masking (FR-ADMIN-6, SEC-5).
    const response = await runtime.auth.handler(
      new Request(
        `${runtime.config.base.origin}${runtime.config.base.basePath}/api/auth/idp/system`,
        { headers: getRequest().headers }
      )
    )
    if (!response.ok) return null
    const body = (await response.json()) as Record<string, unknown>
    const startup = (body.startup ?? {}) as Record<string, unknown>

    return {
      version: String(body.version ?? ""),
      revision: (body.revision as string | null) ?? null,
      issuer: String(body.issuer ?? ""),
      email: body.email as AdminSystemInfo["email"],
      signingKeys: body.signingKeys as AdminSystemInfo["signingKeys"],
      startup: {
        steps: (startup.steps ?? []) as { name: string; skipped?: string }[],
      },
      reconcile: startup.reconcile
        ? JSON.stringify(startup.reconcile, null, 2)
        : null,
      config: JSON.stringify(body.config, null, 2),
      warnings: runtime.warnings.map((warning) => warning.message),
    }
  }
)

/** Whether a user id exists, for the routes that mutate one. */
export async function userExists(
  runtime: Runtime,
  userId: string
): Promise<boolean> {
  const rows = await runtime.database.db
    .select({ id: runtime.database.schema.user.id })
    .from(runtime.database.schema.user)
    .where(eq(runtime.database.schema.user.id, userId))
    .limit(1)
  return rows.length > 0
}

/** The ids of every user holding one of a set of roles — for bulk screens. */
export async function idsWithRoles(
  runtime: Runtime,
  ids: readonly string[]
): Promise<string[]> {
  if (ids.length === 0) return []
  const rows = await runtime.database.db
    .select({ id: runtime.database.schema.user.id })
    .from(runtime.database.schema.user)
    .where(inArray(runtime.database.schema.user.id, [...ids]))
  return rows.map((row) => row.id)
}

interface UserRecord {
  id: string
  email: string
  name: string | null
  status: string | null
  banned: boolean | null
  banReason: string | null
  banExpires: Date | null
  emailVerified: boolean | null
  twoFactorEnabled: boolean | null
  mustChangePassword: boolean | null
  role: string | null
  createdAt: Date
}

function toUserRow(row: UserRecord): AdminUserRow {
  return {
    id: row.id,
    email: row.email,
    name: row.name ?? "",
    status: row.status ?? "pending",
    banned: row.banned === true,
    banReason: row.banReason ?? undefined,
    banExpires: row.banExpires ? iso(row.banExpires) : undefined,
    emailVerified: row.emailVerified === true,
    twoFactorEnabled: row.twoFactorEnabled === true,
    mustChangePassword: row.mustChangePassword === true,
    roles: splitRoles(row.role),
    createdAt: iso(row.createdAt),
  }
}

interface AuditRecord {
  id: string
  action: string
  outcome: string
  actorUserId: string | null
  actorType: string | null
  targetType: string | null
  targetId: string | null
  ipAddress: string | null
  requestId: string | null
  metadata: unknown
  createdAt: Date
}

function toAuditRow(row: AuditRecord): AdminAuditRow {
  return {
    id: row.id,
    action: row.action,
    outcome: row.outcome,
    actorUserId: row.actorUserId ?? undefined,
    actorType: row.actorType ?? undefined,
    targetType: row.targetType ?? undefined,
    targetId: row.targetId ?? undefined,
    ipAddress: row.ipAddress ?? undefined,
    requestId: row.requestId ?? undefined,
    metadata: row.metadata === null ? undefined : JSON.stringify(row.metadata),
    createdAt: iso(row.createdAt),
  }
}

function iso(value: Date | null | undefined): string {
  return value ? value.toISOString() : ""
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, Math.trunc(value)))
}
