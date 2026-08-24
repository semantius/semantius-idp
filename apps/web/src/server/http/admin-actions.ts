/**
 * What the buttons on a user's admin page actually do (FR-ADMIN-2..6,
 * FR-KEY-1, FR-2FA-2, FR-OIDC-12).
 *
 * One dispatcher rather than a handler per action, for a reason that is about
 * safety and not tidiness: every one of these is a `POST` to the same URL, and
 * they must all pass through the same three things — the freshness gate, the
 * invariants, and the audit trail. A file of near-identical handlers is a file
 * where one of them is missing a step.
 *
 * Everything goes **through Better Auth's own endpoints**, never straight to
 * the database. That is what puts `admin/guard.ts` in front of the write and
 * the SEC-6 trail behind it; a direct `update` here would be a way to ban the
 * last administrator that the API refuses.
 */

import { callAuth, errorCodeFor } from "./auth-proxy"
import type { AuthCallResult } from "./auth-proxy"
import { revokeAllForUser } from "../oidc/revoke-user-tokens"
import type { Runtime } from "../runtime"

export interface AdminActionInput {
  runtime: Runtime
  request: Request
  form: Record<string, string>
  /** The user being acted on. */
  userId: string
  /** The administrator doing it, for the audit rows this file writes itself. */
  actorId: string
}

export interface AdminActionOutcome {
  /** A `notices.*` key when it worked. */
  notice?: string
  /** An error code for `messageForErrorCode` when it did not. */
  error?: string
  /** Where to go instead of back to the user's page. */
  redirect?: string
  /** Cookies to replay — impersonation sets a session. */
  cookies?: string[]
}

/** Every action the user detail page can post. */
export type AdminActionName =
  | "approve"
  | "reject"
  | "ban"
  | "unban"
  | "delete"
  | "revoke-sessions"
  | "reset-two-factor"
  | "send-reset"
  | "temporary-password"
  | "set-roles"
  | "impersonate"
  | "revoke-key"

export async function runAdminAction(
  action: string,
  input: AdminActionInput
): Promise<AdminActionOutcome> {
  switch (action as AdminActionName) {
    case "approve":
      return simple(
        input,
        "/idp/approve-user",
        { userId: input.userId },
        "approved"
      )

    case "reject":
      return simple(
        input,
        "/idp/reject-user",
        { userId: input.userId, notify: input.form.notify === "on" },
        "rejected"
      )

    case "ban": {
      const seconds = Number(input.form.banExpiresIn ?? "")
      return simple(
        input,
        "/admin/ban-user",
        {
          userId: input.userId,
          ...(input.form.banReason ? { banReason: input.form.banReason } : {}),
          // No expiry means permanent, which is what the empty option means.
          ...(Number.isFinite(seconds) && seconds > 0
            ? { banExpiresIn: seconds }
            : {}),
        },
        "banned"
      )
    }

    case "unban":
      return simple(
        input,
        "/admin/unban-user",
        { userId: input.userId },
        "unbanned"
      )

    case "delete": {
      const result = await simple(
        input,
        "/admin/remove-user",
        { userId: input.userId },
        "deleted"
      )
      // The account is gone, so its page is gone with it.
      if (!result.error) {
        return { ...result, redirect: "/admin/users?notice=deleted" }
      }
      return result
    }

    case "revoke-sessions": {
      const result = await callAuth(
        input.runtime,
        "/admin/revoke-user-sessions",
        { userId: input.userId },
        input.request
      )
      if (!result.ok) return failed(result)
      // FR-OIDC-12: "sign out everywhere" that leaves a refresh token alive is
      // not signing out everywhere. The admin plugin knows nothing about OAuth,
      // so this half is ours.
      await revokeAllForUser(
        { database: input.runtime.database, audit: input.runtime.audit },
        { userId: input.userId, reason: "admin:revoke_sessions" }
      )
      await input.runtime.audit.record({
        action: "session.revoked",
        outcome: "success",
        actorType: "session",
        actorUserId: input.actorId,
        target: { type: "user", id: input.userId },
        metadata: { scope: "all" },
      })
      return { notice: "sessionsRevoked" }
    }

    case "reset-two-factor":
      return simple(
        input,
        "/idp/reset-two-factor",
        { userId: input.userId },
        "twoFactorReset"
      )

    case "send-reset": {
      if (!input.runtime.mailer.enabled) return { error: "email_disabled" }
      const email = input.form.email ?? ""
      const result = await callAuth(
        input.runtime,
        "/request-password-reset",
        { email },
        input.request
      )
      // Better Auth answers 200 whether or not the address exists, which is
      // right for the public form and harmless here.
      if (!result.ok) return failed(result)
      return { notice: "resetSent" }
    }

    case "temporary-password": {
      const newPassword = input.form.newPassword ?? ""
      const set = await callAuth(
        input.runtime,
        "/admin/set-user-password",
        { userId: input.userId, newPassword },
        input.request
      )
      if (!set.ok) return failed(set)
      // FR-ADMIN-2: a password an administrator chose is temporary by
      // definition — the user has to replace it before they can do anything
      // else (FR-AUTH-4), and `endsForcedPasswordChange` already expects it.
      const flag = await callAuth(
        input.runtime,
        "/admin/update-user",
        { userId: input.userId, data: { mustChangePassword: true } },
        input.request
      )
      if (!flag.ok) return failed(flag)
      await input.runtime.audit.record({
        action: "password.changed",
        outcome: "success",
        actorType: "session",
        actorUserId: input.actorId,
        target: { type: "user", id: input.userId },
        metadata: { temporary: true },
      })
      return { notice: "temporaryPasswordSet" }
    }

    case "set-roles": {
      const roles = (input.form.roles ?? "")
        .split(",")
        .map((role) => role.trim())
        .filter((role) => role !== "")
      const result = await callAuth(
        input.runtime,
        "/admin/set-role",
        { userId: input.userId, role: roles },
        input.request
      )
      if (!result.ok) return failed(result)
      return { notice: "rolesSaved" }
    }

    case "impersonate": {
      const result = await callAuth(
        input.runtime,
        "/admin/impersonate-user",
        { userId: input.userId },
        input.request
      )
      if (!result.ok) return failed(result)
      await input.runtime.audit.record({
        action: "impersonation.started",
        outcome: "success",
        actorType: "session",
        actorUserId: input.actorId,
        target: { type: "user", id: input.userId },
      })
      // Into the impersonated user's own account area, which is the only place
      // the session is useful — and which shows the banner on every page.
      return { redirect: "/account", cookies: result.cookies }
    }

    case "revoke-key": {
      const result = await callAuth(
        input.runtime,
        "/api-key/delete",
        { keyId: input.form.keyId ?? "" },
        input.request
      )
      if (!result.ok) return failed(result)
      await input.runtime.audit.record({
        action: "apikey.revoked",
        outcome: "success",
        actorType: "session",
        actorUserId: input.actorId,
        target: { type: "user", id: input.userId },
        metadata: { keyId: input.form.keyId ?? null },
      })
      return { notice: "keyRevoked" }
    }

    default:
      return { error: "invalid_request" }
  }
}

async function simple(
  input: AdminActionInput,
  path: string,
  body: Record<string, unknown>,
  notice: string
): Promise<AdminActionOutcome> {
  const result = await callAuth(input.runtime, path, body, input.request)
  if (!result.ok) return failed(result)
  return { notice }
}

function failed(result: AuthCallResult): AdminActionOutcome {
  // The invariants answer with their own code (`LAST_ADMIN_PROTECTED`), which
  // `errorCodeFor` lowercases into something the catalog can look up — so a
  // refusal explains itself instead of saying "something went wrong".
  return { error: errorCodeFor(result) }
}
