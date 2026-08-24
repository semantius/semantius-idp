/**
 * A short-lived, single-use, server-side stash.
 *
 * Some flows have to hand a value from a form POST to the page the browser
 * lands on afterwards — a TOTP secret and its backup codes, most obviously
 * (FR-2FA-1). Putting those in the redirect URL is what a query parameter
 * looks like it is for, and it is wrong: the URL survives in browser history,
 * in `Referer` on the next outbound request, and in any proxy log between
 * here and the user. So the redirect carries an opaque handle and the value
 * stays on this side.
 *
 * The store is Better Auth's `verification` table, which already exists, is
 * already scoped to this schema and is already swept when rows expire. Nothing
 * new to migrate, and nothing left behind: a claim consumes the row, so a
 * refresh of the landing page shows the value gone rather than showing it
 * again to whoever has the URL.
 */

import { randomBytes } from "node:crypto"

import { runWithEndpointContext } from "@better-auth/core/context"

import type { Runtime } from "../runtime"

/** Namespaced so a handle can never collide with a real verification token. */
const PREFIX = "one-shot-"

export interface StashOptions {
  /** How long the value stays claimable. Keep it as short as the flow allows. */
  ttlSeconds?: number
}

/**
 * Stores a value and returns the handle that claims it.
 *
 * The handle is 32 random bytes: it is the only thing standing between the URL
 * and the value, so it has to be unguessable rather than merely unique.
 */
export async function stash(
  runtime: Runtime,
  value: string,
  { ttlSeconds = 600 }: StashOptions = {}
): Promise<string> {
  const handle = randomBytes(32).toString("base64url")
  const context = await runtime.auth.$context

  await runWithEndpointContext({ context }, () =>
    context.internalAdapter.createVerificationValue({
      identifier: `${PREFIX}${handle}`,
      value,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    })
  )

  return handle
}

/**
 * Claims a stashed value, consuming it. Returns `undefined` for a handle that
 * is unknown, already claimed or expired — all three are the same answer to
 * whoever is asking.
 */
export async function claim(
  runtime: Runtime,
  handle: string | undefined
): Promise<string | undefined> {
  if (!handle) return undefined
  const context = await runtime.auth.$context

  const consumed = await runWithEndpointContext({ context }, () =>
    context.internalAdapter
      .consumeVerificationValue(`${PREFIX}${handle}`)
      .catch(() => null)
  )
  if (!consumed) return undefined
  if (consumed.expiresAt.getTime() <= Date.now()) return undefined
  return consumed.value
}
