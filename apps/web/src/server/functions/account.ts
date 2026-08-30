/**
 * Everything `/account/*` renders from (FR-ACCT-1).
 *
 * Route loaders are isomorphic — they run on the server for the first paint
 * and in the browser on every client-side navigation — so anything they import
 * ends up in the client bundle. `createServerFn` is the seam that keeps the
 * database, Better Auth and the config out of it (the rule `functions/ui.ts`
 * documents at length).
 *
 * Every function here returns `null` for an anonymous caller rather than
 * throwing: the loader turns that into a redirect to `/login`, which is a
 * cheaper and more honest answer than a 500 with a stack in it.
 *
 * These are **reads only**. Every mutation is a form POST to a route's own
 * `server.handlers`, where the session gate (`http/require-session.ts`) and
 * the audit trail live — a server function called from the browser would
 * bypass both if
 * anyone ever wired one up.
 */

import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import { and, desc, eq, gt } from "drizzle-orm"
import { toString } from "qrcode"

import { getRuntime } from "../runtime"
import type { Runtime } from "../runtime"
import { claim } from "../http/one-shot"
import { readSession } from "../http/session"
import { readSidebarOpen } from "../http/sidebar-cookie"
import type { RouteSession } from "../http/session"
import { effectiveRoles, isAdmin } from "../role-utils"
import { activeGrantsFor, liveTokenClientsBySession } from "../oidc/grants"
import { listTrustedDevices } from "../auth/trusted-devices"

export interface ProfileView {
  email: string
  emailVerified: boolean
  name: string
  firstName: string
  lastName: string
  /** Catalog-filtered, in catalog order (FR-ROLE-2). */
  roles: string[]
  /**
   * Whether any held role opens `/admin` (FR-ROLE-3).
   *
   * Resolved here, on the server, against `admin.adminRoles` — not in the
   * browser from `roles`, and pointedly not in `UiContext`, which is sent to
   * anonymous visitors. It exists so the account shell can offer the
   * administrator a way *into* the admin area; the area itself is gated by
   * `routes/admin.tsx` and re-checked by every server function under it, so
   * this flag decides a link and nothing else.
   */
  isAdmin: boolean
  twoFactorEnabled: boolean
  /** True while an administrator is impersonating (FR-ADMIN-5). */
  impersonated: boolean
  /**
   * The sidebar's collapse state, read from the browser's cookie so the
   * server's first paint is already right (**D82**, `http/sidebar-cookie.ts`).
   */
  sidebarOpen: boolean
}

export interface SessionView {
  id: string
  /** The one making this request; it has no "sign out" of its own. */
  current: boolean
  createdAt: string
  expiresAt: string
  /**
   * `session.updatedAt`, which Better Auth moves when it extends a session
   * past `session.updateAge` — so the granularity is about a day and the cost
   * is zero. A per-request "last seen" column would be a write on every page
   * load to sharpen a number nobody reads to the minute.
   */
  lastActiveAt: string
  ipAddress?: string
  userAgent?: string
  /**
   * The applications holding a live refresh token minted through this session
   * (**D101**). Names only — the page renders them so "sign this one out" can
   * say what it disconnects.
   */
  clients: string[]
  /** True while an administrator is signed in as the user (FR-ADMIN-5). */
  impersonated: boolean
}

export interface ApiKeyView {
  id: string
  name: string
  /** The first few characters, which is all that survives creation. */
  start?: string
  createdAt: string
  expiresAt?: string
  enabled: boolean
  lastRequest?: string
}

/**
 * One browser the user told to skip the second factor (**D104**, FR-2FA-1).
 *
 * The row `id` and two dates, and nothing else, because there is nothing else:
 * a trust row records no user agent and no address. The `identifier` is
 * deliberately absent — it is half the credential (`auth/trusted-devices.ts`).
 */
export interface TrustedDeviceView {
  id: string
  createdAt: string
  expiresAt: string
}

export interface EnrollmentView {
  /** Inline SVG for the `otpauth://` URI, rendered on the server. */
  qrSvg: string
  /** The base32 secret, for an authenticator that cannot scan. */
  manualKey: string
  /** Shown once, and only here. */
  backupCodes: string[]
}

/**
 * One connected application (**D102**).
 *
 * `hasConsent` and `activeTokens` are carried but not rendered: the page says
 * "connected", and whether that rests on a stored consent, on a live refresh
 * token, or on both is an implementation detail the user cannot act on
 * differently. They are here because `activeGrantsFor` computes them anyway
 * and the integration suite asserts on them — a badge that distinguishes the
 * two would be a design decision, not a mapping change.
 */
export interface GrantView {
  clientId: string
  clientName: string
  scopes: string[]
  connectedAt: string
  hasConsent: boolean
  activeTokens: number
}

/**
 * Profile plus the flags the account pages branch on.
 *
 * **Authoritative**, for the same reason `functions/admin.ts` is: this is the
 * guard on `/account/*` as well as the data behind it, and the ≤ 5 min cookie
 * cache carries a *copy* of the user as they were when it was minted. Two
 * things went wrong with the cached copy, and the e2e suite found both. A
 * session signed out from "Sign out everywhere else" kept working in the other
 * browser until the cache expired — which FR-OIDC-12 ("revocation is immediate
 * at all IdP endpoints") does not allow, and which the sessions page
 * flatly contradicts in its own description. And saving the profile appeared
 * to do nothing: the redirect re-read the cache, so the form came back with
 * the name the user had just replaced.
 */
export const fetchProfile = createServerFn({ method: "GET" }).handler(
  async (): Promise<ProfileView | null> => {
    const runtime = await getRuntime()
    const current = await readSession(runtime, getRequest(), {
      authoritative: true,
    })
    if (!current) return null

    return {
      email: current.user.email,
      emailVerified: current.user.emailVerified,
      name: current.user.name,
      firstName: current.user.firstName ?? "",
      lastName: current.user.lastName ?? "",
      roles: effectiveRoles(current.user.roles.join(","), runtime.config.roles),
      isAdmin: isAdmin(current.user.roles.join(","), runtime.config.adminRoles),
      twoFactorEnabled: current.user.twoFactorEnabled,
      impersonated: current.session.impersonatedBy !== undefined,
      sidebarOpen: readSidebarOpen(getRequest()),
    }
  }
)

/**
 * The **live** sessions, and what signed in through each of them.
 *
 * Expired rows are filtered out (**D103**). Better Auth deletes one lazily,
 * when its cookie is next presented, and the retention sweep clears the rest
 * hourly — so between the two an expired row could sit in this list for an
 * hour under a heading that says every session here is live, offering a "Sign
 * out" for something already signed out. What that costs is the per-row kill
 * switch for an expired session whose tokens are still alive; "Sign out
 * everywhere else" enumerates those rows deliberately, and Disconnect reaches
 * the same tokens by client.
 */
export const fetchSessions = createServerFn({ method: "GET" }).handler(
  async (): Promise<SessionView[] | null> => {
    const runtime = await getRuntime()
    const current = await readSession(runtime, getRequest())
    if (!current) return null

    const now = new Date()
    const { session } = runtime.database.schema
    const rows = await runtime.database.db
      .select()
      .from(session)
      .where(
        and(eq(session.userId, current.user.id), gt(session.expiresAt, now))
      )
      .orderBy(desc(session.createdAt))

    const clientsBySession = await liveTokenClientsBySession(
      runtime.database,
      current.user.id,
      now
    )

    return rows.map((row) => ({
      id: row.id,
      current: row.id === current.session.id,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      lastActiveAt: row.updatedAt.toISOString(),
      ipAddress: row.ipAddress ?? undefined,
      userAgent: row.userAgent ?? undefined,
      clients: clientsBySession.get(row.id) ?? [],
      impersonated: row.impersonatedBy !== null,
    }))
  }
)

export const fetchApiKeys = createServerFn({ method: "GET" }).handler(
  async (): Promise<ApiKeyView[] | null> => {
    const runtime = await getRuntime()
    if (!runtime.config.file.apiKeys.enabled) return []

    const current = await readSession(runtime, getRequest())
    if (!current) return null

    const rows = await runtime.database.db
      .select()
      .from(runtime.database.schema.apikey)
      .where(eq(runtime.database.schema.apikey.referenceId, current.user.id))
      .orderBy(desc(runtime.database.schema.apikey.createdAt))

    return rows.map((row) => ({
      id: row.id,
      name: row.name ?? "",
      start: row.start ?? undefined,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt?.toISOString(),
      enabled: row.enabled !== false,
      lastRequest: row.lastRequest?.toISOString(),
    }))
  }
)

/**
 * The applications the account is connected to (**D102**).
 *
 * The union of stored consents and clients holding a live refresh token, which
 * is what `oidc/grants.ts` exists to compute and why this is four lines: the
 * merge rules are the interesting part and they belong somewhere the
 * integration suite can reach without a request.
 */
/**
 * The browsers this account has trusted with its second factor (**D104**).
 *
 * Empty when 2FA is off for this user, which is not the same as "there are
 * none": a user who turned it off has had every row cleared anyway, and a
 * deployment with `twoFactor.enabled: false` has no such rows at all. Either
 * way there is no section to render.
 */
export const fetchTrustedDevices = createServerFn({ method: "GET" }).handler(
  async (): Promise<TrustedDeviceView[] | null> => {
    const runtime = await getRuntime()
    const current = await readSession(runtime, getRequest())
    if (!current) return null
    if (!current.user.twoFactorEnabled) return []

    const rows = await listTrustedDevices(runtime.database, current.user.id)
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    }))
  }
)

export const fetchGrants = createServerFn({ method: "GET" }).handler(
  async (): Promise<GrantView[] | null> => {
    const runtime = await getRuntime()
    const current = await readSession(runtime, getRequest())
    if (!current) return null

    const grants = await activeGrantsFor(runtime.database, current.user.id)
    return grants.map((grant) => ({
      ...grant,
      connectedAt: grant.connectedAt.toISOString(),
    }))
  }
)

/**
 * Whether an API key belongs to the caller.
 *
 * Better Auth's own delete endpoint scopes by session, but the revoke handler
 * reads the id from a form field, and "the id came from a page I rendered" is
 * not an authorization check.
 */
export async function apiKeyBelongsTo(
  runtime: Runtime,
  session: RouteSession,
  keyId: string
): Promise<boolean> {
  const [row] = await runtime.database.db
    .select({ id: runtime.database.schema.apikey.id })
    .from(runtime.database.schema.apikey)
    .where(
      and(
        eq(runtime.database.schema.apikey.id, keyId),
        eq(runtime.database.schema.apikey.referenceId, session.user.id)
      )
    )
    .limit(1)
  return row !== undefined
}

/**
 * Claims the API key a creation just minted, if the landing URL carries a
 * handle (FR-KEY-1).
 *
 * The key itself never appears in a URL — the module header of
 * `server/http/one-shot.ts` is the argument, and this is the same shape the
 * 2FA enrollment below uses. Claiming consumes the stash, so the value can be
 * rendered on exactly one page load and a reload shows nothing.
 */
export const claimApiKeySecret = createServerFn({ method: "GET" })
  .validator((handle: unknown) => (typeof handle === "string" ? handle : ""))
  .handler(async ({ data: handle }): Promise<string | null> => {
    if (handle === "") return null
    const runtime = await getRuntime()
    const current = await readSession(runtime, getRequest())
    if (!current) return null

    const stashed = await claim(runtime, handle)
    if (!stashed) return null

    const payload = JSON.parse(stashed) as { userId: string; key: string }
    // The handle is unguessable, but a stash claimed by the wrong account
    // would still be a bug worth refusing rather than rendering.
    if (payload.userId !== current.user.id) return null
    return payload.key
  })

/**
 * Claims a pending 2FA enrollment, if the landing URL carries a handle.
 *
 * The QR is rendered here rather than in the browser for two reasons: the
 * `qrcode` package never reaches the client bundle, and the `otpauth://` URI —
 * which contains the shared secret — never leaves the server. What the page
 * receives is a picture of it.
 */
export const claimEnrollment = createServerFn({ method: "GET" })
  .validator((handle: unknown) => (typeof handle === "string" ? handle : ""))
  .handler(async ({ data: handle }): Promise<EnrollmentView | null> => {
    if (handle === "") return null
    const runtime = await getRuntime()
    const current = await readSession(runtime, getRequest())
    if (!current) return null

    const stashed = await claim(runtime, handle)
    if (!stashed) return null

    const payload = JSON.parse(stashed) as {
      userId: string
      totpUri: string
      backupCodes: string[]
    }
    // The handle is unguessable, but a stash claimed by the wrong account
    // would still be a bug worth refusing rather than rendering.
    if (payload.userId !== current.user.id) return null

    return {
      qrSvg: await toString(payload.totpUri, {
        type: "svg",
        margin: 1,
        width: 200,
      }),
      manualKey: new URL(payload.totpUri).searchParams.get("secret") ?? "",
      backupCodes: payload.backupCodes,
    }
  })
