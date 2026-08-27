/**
 * Reading the caller's session from a server route or a server function.
 *
 * One place, because "who is this" is asked from three different kinds of
 * code — page loaders (through `server/functions/*`), form POST handlers, and
 * the admin API — and each of them getting it slightly differently is how a
 * guard ends up applying to the page but not to the endpoint behind it.
 *
 * `auth.api.getSession` is deliberate rather than reading the cookie: it
 * honours the cookie cache, the ban/approval state and the impersonation
 * fields, so a session that Better Auth considers dead is not resurrected here.
 *
 * **"No session" and "the database is unreachable" are not the same answer**
 * (**D59**). See {@link readSession}.
 */

import { APIError } from "better-auth/api"

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
  /** Catalog-filtered role names (FR-ROLE-2). */
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
  /** Set while an administrator is impersonating (FR-ADMIN-5). */
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
   * state as they were when it was minted, so a write authorised from it is a
   * write authorised by a copy of the world up to five minutes old. Every form
   * POST handler asks for the row (`http/require-session.ts`, **D81**).
   */
  authoritative?: boolean
}

/**
 * The caller's session, or `null` when there is none.
 *
 * **A failure to read is not an absence** (**D59**). Better Auth answers `null`
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
