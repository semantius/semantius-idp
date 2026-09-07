/**
 * Reading the caller's session from a server route or a server function.
 *
 * One place, because "who is this" is asked from three different kinds of
 * code — page loaders (through `server/functions/*`), form POST handlers, and
 * the admin API — and each of them getting it slightly differently is how a
 * guard ends up applying to the page but not to the endpoint behind it.
 *
 * `auth.api.getSession` is deliberate rather than reading the cookie: it
 * honors the cookie cache, the ban/approval state and the impersonation
 * fields, so a session that Better Auth considers dead is not resurrected here.
 *
 * **"No session" and "the database is unreachable" are not the same answer**
 *. See {@link readSession}.
 */

import { APIError } from "better-auth/api"

import { assertUserMaySignIn } from "../auth/options/database-hooks"
import type { GateUser } from "../auth/options/database-hooks"
import type { Runtime } from "../runtime"
import { splitRoles } from "../role-utils"

export interface SessionUser {
  id: string
  email: string
  name: string
  firstName?: string
  lastName?: string
  emailVerified: boolean
  image?: string
  /** Catalog-filtered role names. */
  roles: string[]
  twoFactorEnabled: boolean
  mustChangePassword: boolean
}

export interface SessionInfo {
  id: string
  token: string
  createdAt: Date
  expiresAt: Date
  ipAddress?: string
  userAgent?: string
  /** Set while an administrator is impersonating. */
  impersonatedBy?: string
}

export interface RouteSession {
  user: SessionUser
  session: SessionInfo
}

export interface ReadSessionOptions {
  /**
   * Ignore the signed session cookie and read the row.
   *
   * The cookie cache (`session.cookieCacheMinutes`, capped at 5) is what makes
   * a page load cheap, and it is exactly wrong for a decision that depends on
   * *current* state: the cached copy carries the ban flag and the approval
   * state as they were when it was minted, so a write authorized from it is a
   * write authorized by a copy of the world up to five minutes old. Every form
   * POST handler asks for the row (`http/require-session.ts`).
   */
  authoritative?: boolean
}

/**
 * The caller's session, or `null` when there is none.
 *
 * **A failure to read is not an absence**. Better Auth answers `null`
 * for an anonymous caller and *throws* for a refusal — a dead or banned
 * session, which is still "no session" and still belongs on the login page.
 * A query that could not run throws too, and it is a different thing entirely.
 * `.catch(() => null)` treated both alike, so on 2026-08-26 a schema dropped
 * under a running server produced `Failed query: select … from "idp"."session"`
 * in the log and an entirely ordinary sign-in page on the screen. The two never
 * met, and the operator was left to conclude they had been signed out.
 *
 * The discriminator is Better Auth's own: `dispatch` converts a refusal into an
 * `APIError` and rethrows anything else untouched, so a driver or query failure
 * arrives here as a plain `Error`. That, and any `APIError` that is itself a
 * 5xx, propagate to the error boundary — which is what the branded error page
 * is for. Everything else is a signed-out visitor.
 */
export async function readSession(
  runtime: Runtime,
  request: Request,
  { authoritative = false }: ReadSessionOptions = {}
): Promise<RouteSession | null> {
  const result = await runtime.auth.api
    .getSession({
      headers: request.headers,
      ...(authoritative ? { query: { disableCookieCache: true } } : {}),
    })
    .catch((error: unknown) => {
      if (error instanceof APIError && error.statusCode < 500) return null
      throw error
    })
  // The typed shape says `session` is always there when `user` is; the
  // check is on `user` alone so the narrowing is honest.
  if (!result?.user) return null

  const user = result.user as Record<string, unknown>
  const session = result.session as Record<string, unknown>

  // the standing gate, on the user this read produced.
  // A session outlives the approval or the ban that should have ended it
  // when the change was made by SQL, or by anything that skips the admin
  // endpoints' revocation — and "banned" or "pending" is still nobody signed
  // in. Until this line the only thing refusing such a read was the JWT
  // plugin's after hook on `/get-session`, which mints a `set-auth-jwt`
  // header through `sessionTokenPayload` and trips its gate by accident;
  // `disableSettingJwtHeader` would have taken the whole check with it.
  if (!maySignIn(user)) return null

  return {
    user: {
      id: String(user.id),
      email: String(user.email ?? ""),
      name: String(user.name ?? ""),
      firstName: optionalString(user.firstName),
      lastName: optionalString(user.lastName),
      emailVerified: user.emailVerified === true,
      image: optionalString(user.image),
      roles: splitRoles(optionalString(user.role)),
      twoFactorEnabled: user.twoFactorEnabled === true,
      mustChangePassword: user.mustChangePassword === true,
    },
    session: {
      id: String(session.id),
      token: String(session.token ?? ""),
      createdAt: toDate(session.createdAt),
      expiresAt: toDate(session.expiresAt),
      ipAddress: optionalString(session.ipAddress),
      userAgent: optionalString(session.userAgent),
      impersonatedBy: optionalString(session.impersonatedBy),
    },
  }
}

/**
 * `{ impersonatedBy }` while an administrator is signed in as the user, else
 * `undefined` — so it spreads into a metadata object or stands as one.
 *
 * Every `/account/*` audit write carries it. The row's actor is
 * the user, because it is their account that changed; the administrator is
 * the answer to "who was really there", and a trail that could not give it
 * named the victim as the author of a revocation they never made.
 */
export function actorMetadata(
  session: RouteSession
): { impersonatedBy: string } | undefined {
  const by = session.session.impersonatedBy
  return by ? { impersonatedBy: by } : undefined
}

function maySignIn(user: Record<string, unknown>): boolean {
  const standing: GateUser = {
    status: optionalString(user.status),
    banned: user.banned === true,
    banExpires:
      user.banExpires instanceof Date || typeof user.banExpires === "string"
        ? user.banExpires
        : null,
  }
  try {
    assertUserMaySignIn(standing)
    return true
  } catch (error) {
    if (error instanceof APIError) return false
    throw error
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value
  if (typeof value === "string" || typeof value === "number") {
    return new Date(value)
  }
  return new Date(0)
}
