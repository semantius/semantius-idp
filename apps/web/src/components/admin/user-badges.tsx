import { Badge } from "@workspace/ui/components/badge"

import type { AdminUserRow } from "@/server/functions/admin"
import type { Catalog } from "@/server/i18n"

/**
 * The state of an account, at a glance.
 *
 * Shared between the list and the detail page so the two cannot disagree about
 * what "suspended" looks like — the list is where an administrator decides who
 * to open, and a status that reads differently in the two places is how the
 * wrong account gets acted on.
 *
 * Suspension is shown *instead of* the status rather than beside it: a
 * suspended account is still nominally "active", and printing both invites the
 * reader to think the ban did not take.
 */
export function UserBadges({
  user,
  t,
}: {
  user: Pick<
    AdminUserRow,
    | "status"
    | "banned"
    | "emailVerified"
    | "twoFactorEnabled"
    | "mustChangePassword"
  >
  t: Catalog
}) {
  // A status the catalog has no word for is shown verbatim rather than blank:
  // an unrecognized value is exactly when an administrator needs to see it.
  const label = (t.admin.status as Record<string, string | undefined>)[
    user.status
  ]

  return (
    <span className="flex flex-wrap gap-1">
      {user.banned ? (
        <Badge variant="destructive">{t.admin.status.banned}</Badge>
      ) : (
        <Badge
          variant={
            user.status === "active"
              ? "secondary"
              : user.status === "rejected"
                ? "destructive"
                : "default"
          }
        >
          {label ?? user.status}
        </Badge>
      )}
      {!user.emailVerified ? (
        <Badge variant="outline">{t.admin.status.unverified}</Badge>
      ) : null}
      {user.mustChangePassword ? (
        <Badge variant="outline">{t.admin.status.mustChangePassword}</Badge>
      ) : null}
      {user.twoFactorEnabled ? (
        <Badge variant="outline">{t.admin.status.twoFactor}</Badge>
      ) : null}
    </span>
  )
}
