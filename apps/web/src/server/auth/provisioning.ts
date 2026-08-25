/**
 * Creating a user when there is no request behind it.
 *
 * The bootstrap admin (FR-ADMIN-1), `idp reset-admin` (OPS-6) and the test
 * fixtures all provision accounts outside any HTTP endpoint, and Better Auth
 * 1.7.1 refuses that as soon as `user.validateUserInfo` is configured — which
 * it is, because FR-SOC-3 and D24 have nowhere else to run. `createUser` looks
 * for an async-local *endpoint* context to hand the gate and throws
 * `validation_context_missing` when it cannot find one.
 *
 * `runWithEndpointContext` is Better Auth's own answer for callers like these:
 * it establishes that context from the auth context we already hold, without
 * inventing a fake request. Wrapping it once, here, is what keeps the rule
 * from being rediscovered — the failure mode is a 403 at start-up, which reads
 * like a permissions bug and is not one.
 */

import { runWithEndpointContext } from "@better-auth/core/context"

import type { Auth } from "./instance"

type AuthContext = Awaited<Auth["$context"]>
type InternalAdapter = AuthContext["internalAdapter"]

type CreateUserArgs = Parameters<InternalAdapter["createUser"]>
type CreatedUser = Awaited<ReturnType<InternalAdapter["createUser"]>>

/**
 * `internalAdapter.createUser`, with the endpoint context it now requires.
 *
 * `source` says which provisioning path this is; it reaches
 * `user.validateUserInfo` as `source.method`, and the social rules are scoped
 * to `method: "oauth"`, so an administrative creation passes straight through.
 */
export async function createUserWithoutRequest(
  context: AuthContext,
  user: CreateUserArgs[0],
  source: CreateUserArgs[1] = { method: "admin" }
): Promise<CreatedUser> {
  return runWithEndpointContext({ context }, () =>
    context.internalAdapter.createUser(user, source)
  )
}
