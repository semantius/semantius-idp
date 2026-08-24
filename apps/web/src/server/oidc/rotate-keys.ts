/**
 * Rotating the signing key without breaking every verifier (FR-OIDC-16,
 * risk R11).
 *
 * **The hazard.** Better Auth picks the signing key as "the newest live key of
 * the configured algorithm" and mints a replacement the moment the current one
 * expires. A key created that way signs *immediately* — before any verifier
 * has seen it. Neon caches a JWKS for up to an hour, so every token signed in
 * that window fails verification with `no applicable key found`, and nothing in
 * the IdP's logs says why. R11 was never spiked; this is the pre-decided
 * fallback, and reading 1.7.1's key selection confirms the hazard is real.
 *
 * **The mechanism: publish, then sign.** Rotation happens in one step but takes
 * effect in two, using the two columns the selection rule already reads.
 *
 *  1. A successor key is created — published in the JWKS at once, because the
 *     endpoint lists every key until `expiresAt + gracePeriod`.
 *  2. Its `createdAt` is backdated behind every live key, so "newest live key"
 *     is still the *current* one and the successor signs nothing yet.
 *  3. The current key's `expiresAt` is brought forward to the end of the
 *     propagation window. When it lapses, the successor is the newest key that
 *     is still live and takes over — by which time it has been published for
 *     the whole window.
 *
 * Retired keys keep verifying until `expiresAt + jwt.gracePeriod`, which
 * defaults to the longest token lifetime plus an hour precisely so that a
 * token signed just before a rotation still verifies after it.
 *
 * Under `LOCK_KEYS.rotateKeys` on the **direct** connection: a session-level
 * advisory lock does not hold through a transaction pooler (D27, S4), and two
 * containers rotating at once would each publish a successor.
 */

import { runWithEndpointContext } from "@better-auth/core/context"
import { createJwk } from "better-auth/plugins/jwt"
import { asc, eq, gt, isNull, or } from "drizzle-orm"

import type { Audit } from "../audit"
import type { Auth } from "../auth/instance"
import type { IdpConfig } from "../config/derive"
import { withAdvisoryLock } from "../db/advisory-lock"
import type { DbHandle } from "../db/client"
import type { Logger } from "../logger"

/**
 * How long a published key waits before it starts signing.
 *
 * An hour, because that is Neon's JWKS cache ceiling and the longest of the
 * caches this deployment has to survive. Shorter would reintroduce exactly the
 * window the mechanism exists to close.
 */
export const DEFAULT_PROPAGATION_SECONDS = 3600

export interface RotateKeysDeps {
  config: IdpConfig
  database: DbHandle
  /** The direct connection, for the advisory lock (D27). */
  locking: DbHandle
  auth: Auth
  audit?: Audit
  logger?: Logger
}

export interface RotationResult {
  /** The key that will take over. */
  successorKeyId: string
  /** The key that keeps signing until then, if there was one. */
  retiringKeyId?: string
  /** When the successor starts signing. */
  effectiveAt: Date
}

export async function rotateKeys(
  deps: RotateKeysDeps,
  { propagationSeconds = DEFAULT_PROPAGATION_SECONDS } = {}
): Promise<RotationResult> {
  const result = await withAdvisoryLock(
    deps.locking.sql,
    "rotateKeys",
    async () => performRotation(deps, propagationSeconds),
    { timeoutSeconds: 60 }
  )
  if (!result) {
    throw new Error(
      "Could not take the key-rotation lock; nothing was changed."
    )
  }
  return result
}

async function performRotation(
  deps: RotateKeysDeps,
  propagationSeconds: number
): Promise<RotationResult> {
  const { config, database, auth, audit, logger } = deps
  const { jwks } = database.schema
  const now = new Date()

  // Every key that would still be chosen as a signer, oldest first.
  const live = await database.db
    .select()
    .from(jwks)
    .where(or(isNull(jwks.expiresAt), gt(jwks.expiresAt, now)))
    .orderBy(asc(jwks.createdAt))

  const context = await auth.$context
  const created = (await runWithEndpointContext({ context }, () =>
    createJwk({ context } as never, jwtOptionsFor(config))
  )) as { id: string }

  const effectiveAt = new Date(now.getTime() + propagationSeconds * 1000)
  const retiring = live[live.length - 1]

  // Behind every live key, so "newest live key" is unchanged until the
  // current one lapses. One second is enough — the ordering is by timestamp,
  // not by proximity.
  const backdated = new Date(
    (live[0]?.createdAt.getTime() ?? now.getTime()) - 1000
  )
  await database.db
    .update(jwks)
    .set({ createdAt: backdated })
    .where(eq(jwks.id, created.id))

  if (retiring) {
    // Brought forward, never pushed back: a key already due to expire sooner
    // keeps its own deadline.
    const current = retiring.expiresAt
    if (!current || current > effectiveAt) {
      await database.db
        .update(jwks)
        .set({ expiresAt: effectiveAt })
        .where(eq(jwks.id, retiring.id))
    }
  }

  logger?.info("signing key rotated", {
    successorKeyId: created.id,
    retiringKeyId: retiring?.id,
    effectiveAt: effectiveAt.toISOString(),
  })
  await audit?.record({
    action: "keys.rotated",
    outcome: "success",
    actorType: "system",
    metadata: {
      successorKeyId: created.id,
      retiringKeyId: retiring?.id,
      effectiveAt: effectiveAt.toISOString(),
      propagationSeconds,
    },
  })

  return {
    successorKeyId: created.id,
    ...(retiring ? { retiringKeyId: retiring.id } : {}),
    effectiveAt,
  }
}

/**
 * The `jwt` plugin options `createJwk` reads: the algorithm to generate, and
 * whether to encrypt the private half.
 *
 * Rebuilt here rather than dug out of the constructed instance, because the
 * plugin does not expose its own options and a mismatch would produce a key
 * of the wrong algorithm — which would sign tokens Neon refuses.
 */
function jwtOptionsFor(config: IdpConfig) {
  return {
    jwks: {
      keyPairConfig: { alg: config.file.jwt.algorithm },
      disablePrivateKeyEncryption: false,
      rotationInterval: config.file.jwt.rotationInterval,
      gracePeriod: config.jwksGracePeriodSeconds,
    },
  } as never
}
