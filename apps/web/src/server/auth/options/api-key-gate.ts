/**
 * Re-checking the owner on every API-key request (FR-KEY-2, FR-SIGNUP-2).
 *
 * A key is a long-lived credential handed out once. Everything that can happen
 * to the person holding it — banned, un-approved, rejected — happens *after*
 * the key exists, so "may this account sign in" has to be asked on every use,
 * not only at creation.
 *
 * Better Auth's api-key plugin does not ask. Its `before` hook resolves the
 * key, looks up the user and assigns `ctx.context.session` itself, so
 * `databaseHooks.session.create.before` — the gate every other sign-in path
 * goes through — never runs. A banned user's key kept working; the integration
 * suite found it.
 *
 * **Why this wraps the plugin's own hook rather than adding one.** Hooks are a
 * chain, and a hook that returns a value ends it: for `/get-session` the
 * api-key hook returns the session as the response, so the endpoint, every
 * later before-hook and every after-hook are skipped. A gate registered
 * downstream would then cover every endpoint except the one an API client
 * calls to find out who it is. Wrapping the handler is the only position that
 * sees the session in both cases.
 */

import type { BetterAuthPlugin } from "better-auth"

import type { Audit } from "../../audit"
import { assertUserMaySignIn } from "./database-hooks"
import type { GateUser } from "./database-hooks"

/** The header the api-key plugin reads, and the one this gate watches for. */
export const API_KEY_HEADER = "x-api-key"

export interface ApiKeyGateDeps {
  /** Absent during schema generation. */
  audit?: Audit
}

interface GateContext {
  path?: string
  context: {
    session?: {
      user?: (GateUser & { id?: unknown }) | null
    } | null
  }
}

type HookEntry = NonNullable<
  NonNullable<BetterAuthPlugin["hooks"]>["before"]
>[number]

/**
 * Returns the api-key plugin with its `before` hooks wrapped in the owner
 * re-check.
 */
export function gateApiKeyPlugin(
  plugin: BetterAuthPlugin,
  deps: ApiKeyGateDeps
): BetterAuthPlugin {
  const before = plugin.hooks?.before
  if (!before) return plugin

  return {
    ...plugin,
    hooks: {
      ...plugin.hooks,
      before: before.map((entry) => wrap(entry, deps)),
    },
  }
}

function wrap(entry: HookEntry, deps: ApiKeyGateDeps): HookEntry {
  const original = entry.handler
  const handler = (async (ctx: Parameters<typeof original>[0]) => {
    const result = await original(ctx)

    // The plugin mutates `ctx.context.session` in place, so the session it
    // just built is readable here whether or not it also returned one.
    const gate = ctx as unknown as GateContext
    const user = gate.context.session?.user
    // No session means the key was already refused — invalid, expired or
    // revoked — and the plugin has thrown.
    if (!user) return result

    try {
      assertUserMaySignIn(user)
    } catch (error) {
      await deps.audit?.record({
        action: "apikey.failed",
        outcome: "failure",
        actorType: "api-key",
        actorUserId: typeof user.id === "string" ? user.id : undefined,
        metadata: { reason: reasonFor(error), path: gate.path },
      })
      throw error
    }

    return result
  }) as HookEntry["handler"]

  return { ...entry, handler }
}

function reasonFor(error: unknown): string {
  const code = (error as { body?: { code?: unknown } } | undefined)?.body?.code
  return typeof code === "string" ? code : "refused"
}
