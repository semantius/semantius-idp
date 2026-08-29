/**
 * What the buttons on a user's admin page actually do (FR-ADMIN-2..6,
 * FR-KEY-1, FR-2FA-2, FR-OIDC-12).
 *
 * One dispatcher rather than a handler per action, for a reason that is about
 * safety and not tidiness: every one of these is a `POST` to the same URL, and
 * they must all pass through the same three things — the session gate, the
 * invariants, and the audit trail. A file of near-identical handlers is a file
 * where one of them is missing a step.
 *
 * Everything goes **through Better Auth's own endpoints**, never straight to
 * the database. That is what puts `admin/guard.ts` in front of the write and
 * the SEC-6 trail behind it; a direct `update` here would be a way to ban the
 * last administrator that the API refuses.
 */

import { eq } from "drizzle-orm"

import { adminErrorCodeFor, callAuth } from "./auth-proxy"
import type { AuthCallResult } from "./auth-proxy"
import { displayName } from "../display-name"
import type { Runtime } from "../runtime"

export interface AdminActionInput {
  runtime: Runtime
  request: Request
  form: Record<string, string>
  /**
   * The repeated fields, as `readFormMulti` reads them (**D93**).
   *
   * One field needs it — `roles`, which is a checkbox group — and the join
   * used to live in the route: `$userId.tsx` did `readFormMulti` *and*
   * `form.roles = valuesOf("roles").join(",")` before dispatching, because
   * `set-roles` splits a comma string while `readForm` keeps only the last
   * value of a repeated key. Naming the reader without the join means ticking
   * `admin` and `billing` stores `billing` alone — a silent privilege
   * reduction under a success toast. It is here now so the next route to
   * dispatch this cannot forget it.
   */
  list: (name: string) => string[]
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
  /**
   * The account the notice is about, so the toast can name it (**D78**).
   *
   * Only ever set where the page the notice lands on cannot work the address
   * out for itself. Every action that comes back to `/admin/users/:id` can —
   * its loader re-reads the account — so `delete` is the one case, because
   * the row it would have read is the thing that just went away.
   */
  subject?: string
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
  | "edit-profile"
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
      // Read **before** the removal (**D78**). "The account has been deleted."
      // lands on the list, where the row that could answer *which* account is
      // the one thing that is certainly gone — so the address is taken while
      // it still exists and carried to the toast. A read, not a write: the
      // rule at the top of this file is that nothing here writes to the
      // database, because a direct write is a write the invariants and the
      // audit trail never see. A select is neither.
      const email = await emailOf(input)
      const result = await simple(
        input,
        "/admin/remove-user",
        { userId: input.userId },
        "deleted"
      )
      // The account is gone, so its page is gone with it.
      if (!result.error) {
        return { ...result, subject: email, redirect: "/admin/users" }
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
      // Nothing else here. Both halves of "sign out everywhere" — the audit
      // row (**D66**) and the OAuth revocation (**D67**) — belong to the
      // guard's after-hook, which runs for every caller of the endpoint. This
      // is where the revocation used to live, which is exactly why a direct
      // API call did not get one.
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
      // `password.changed` comes from the guard's hook on
      // `/admin/set-user-password` (**D66**). The `temporary: true` metadata
      // this used to add is gone with it: it was true of *this route*, which
      // follows the password with a second call setting `mustChangePassword`,
      // and is not derivable from the endpoint. A flag that means "probably"
      // is worse than no flag in a table whose value is that it does not.
      return { notice: "temporaryPasswordSet" }
    }

    /**
     * FR-ADMIN-2's "edit (name, e-mail, verified flag)", which had no
     * implementation at all: the only `/admin/update-user` call in the codebase
     * set `mustChangePassword`, so an administrator could ban, delete and
     * re-role an account but not correct a typo in its address.
     *
     * The display name is **derived** from the two parts rather than typed
     * (D49) — the same rule the account page and the sign-up form follow, so a
     * name an administrator fixes reads the same way as one its owner did.
     */
    case "edit-profile": {
      const firstName = (input.form.firstName ?? "").trim()
      const lastName = (input.form.lastName ?? "").trim()
      const email = (input.form.email ?? "").trim().toLowerCase()

      const data: Record<string, unknown> = {
        firstName,
        lastName,
        name:
          displayName(
            firstName,
            lastName,
            input.runtime.config.file.site.nameFormat
          ) || email,
        // An unticked checkbox posts nothing, so absence is `false` — which is
        // the point: this control takes verification *away* as well as gives
        // it, and an admin who unticks it means it.
        emailVerified: input.form.emailVerified === "on",
      }
      // Only when one was typed. An empty field is "leave it alone", not
      // "clear the address", which the unique index would refuse anyway.
      if (email !== "") data.email = email

      const result = await callAuth(
        input.runtime,
        "/admin/update-user",
        { userId: input.userId, data },
        input.request
      )
      if (!result.ok) return failed(result)
      await input.runtime.audit.record({
        action: "user.profile_changed",
        outcome: "success",
        actorType: "session",
        actorUserId: input.actorId,
        target: { type: "user", id: input.userId },
        metadata: { emailChanged: email !== "", emailVerified: data.emailVerified },
      })
      return { notice: "profileSaved" }
    }

    case "set-roles": {
      // The checkbox group, read as a list rather than reassembled from a
      // string the caller had to remember to build (**D93**). `/admin/set-role`
      // takes an array, so nothing is joined at all any more.
      const roles = input
        .list("roles")
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
      // No audit row here: the guard's after-hook already writes
      // `impersonation.started` for `/admin/impersonate-user`, and this wrote
      // a second one for the same event on the UI path (**D66**).
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
        // The **key** is what was acted on, and the owner is context. This
        // used to be the other way round while `/account/api-keys` recorded
        // the key — so the same event had two shapes and the audit page's
        // "What" column could not resolve either reliably.
        target: { type: "apikey", id: input.form.keyId ?? "" },
        metadata: { userId: input.userId },
      })
      return { notice: "keyRevoked" }
    }

    default:
      return { error: "invalid_request" }
  }
}

/**
 * The account's e-mail address, or `undefined` if it cannot be read.
 *
 * `undefined` rather than a throw: this is the label on a confirmation, and a
 * deletion that worked must not be reported as a failure because the sentence
 * above it would have been less specific.
 */
async function emailOf(input: AdminActionInput): Promise<string | undefined> {
  try {
    const { db, schema } = input.runtime.database
    const [row] = await db
      .select({ email: schema.user.email })
      .from(schema.user)
      .where(eq(schema.user.id, input.userId))
      .limit(1)
    return row?.email
  } catch {
    return undefined
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
  // `adminErrorCodeFor` lowercases into something the catalog can look up — so
  // a refusal explains itself instead of saying "something went wrong". The
  // admin variant because everything routed through here is an authenticated
  // administrator's action: an unrecognised refusal is a failed request, not a
  // wrong password (**D70**).
  return { error: adminErrorCodeFor(result) }
}
