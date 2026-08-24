/**
 * The things `/admin/system` and the key-rotation button need but cannot be
 * handed at construction time (FR-ADMIN-2, FR-OIDC-16).
 *
 * The order of construction is fixed and awkward: migrations run, then the
 * Better Auth instance is built, then startup runs against that instance. So
 * an endpoint *inside* the instance cannot be given the instance, nor the
 * startup result that does not exist yet — and the system page wants both.
 *
 * A module-level singleton would be the obvious shortcut and the wrong one:
 * the integration tests build several instances against several throwaway
 * schemas in one process, and a singleton would have them answering each
 * other's questions. So this is a plain mutable object, created per instance
 * and filled in by `runtime.ts` the moment each piece exists.
 *
 * Everything on it is optional, and every reader treats "not filled in yet" as
 * a fact to report rather than an error — a system page asked for during boot
 * should say what it knows.
 */

import type { Auth } from "../auth/instance"
import type { StartupResult } from "../startup"

export interface AdminContext {
  /** Set immediately after `createAuth`; needed to rotate signing keys. */
  auth?: Auth
  /** Set once startup finishes; the step list and the FR-OIDC-2 diff. */
  startup?: StartupResult
}

/** A fresh, empty context. One per Better Auth instance. */
export function createAdminContext(): AdminContext {
  return {}
}
