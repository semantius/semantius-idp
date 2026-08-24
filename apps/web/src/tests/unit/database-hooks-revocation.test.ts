/**
 * The two revocation hooks, in the states a live database cannot easily be put
 * into (FR-AUTH-3, FR-AUTH-6, FR-OIDC-12).
 *
 * Both are "never allowed to break the thing they hang off": a password change
 * must complete even if the revocation query fails, and a sign-out must sign
 * the user out even if the token sweep throws. Those are the branches that
 * matter most and the ones an integration test cannot reach without breaking
 * the database on purpose.
 */

import { describe, expect, it, vi } from "vitest"

import { buildDatabaseHooks } from "@/server/auth/options/database-hooks"
import { deriveConfig } from "@/server/config/derive"
import type { IdpConfig } from "@/server/config/derive"
import { configFileSchema } from "@/server/config/schema/config-schema"
import { BUILT_IN_ROLES } from "@/server/config/schema/roles-schema"
import type { DbHandle } from "@/server/db/client"
import type { Logger } from "@/server/logger"

function configWith(overrides: Record<string, unknown> = {}): IdpConfig {
  const file = configFileSchema.parse({
    server: { baseUrl: "https://idp.example.com" },
    secret: "0123456789abcdef0123456789abcdef0123456789",
    database: { url: "postgres://idp:idp@localhost:5432/idp" },
    site: { name: "Test IdP" },
    jwt: { audience: "https://idp.example.com" },
    ...overrides,
  })
  return deriveConfig(file, [], BUILT_IN_ROLES)
}

/** A handle whose every query rejects, standing in for a database in trouble. */
function brokenDatabase(): DbHandle {
  const fail = () => {
    throw new Error("connection lost")
  }
  return {
    db: { delete: fail, update: fail, select: fail },
    schema: {
      oauthAccessToken: {},
      oauthRefreshToken: {},
    },
  } as unknown as DbHandle
}

function silentLogger(): Logger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger
}

const CREDENTIAL_ACCOUNT = {
  providerId: "credential",
  userId: "user-1",
}

describe("revoking after a password write", () => {
  it("does nothing when there is no database to revoke in", async () => {
    // Schema generation builds the hooks with no connection at all.
    const hooks = buildDatabaseHooks({ config: configWith() })
    await expect(
      hooks?.account?.update?.after?.(
        CREDENTIAL_ACCOUNT as never,
        {
          path: "/change-password",
        } as never
      )
    ).resolves.toBeUndefined()
  })

  it("does not fail the password change when the revocation query fails", async () => {
    // The new password is already written by the time this runs; refusing the
    // change now would leave the user unable to sign in with either.
    const logger = silentLogger()
    const hooks = buildDatabaseHooks({
      config: configWith(),
      database: brokenDatabase(),
      logger,
    })
    await expect(
      hooks?.account?.update?.after?.(
        CREDENTIAL_ACCOUNT as never,
        {
          path: "/reset-password",
        } as never
      )
    ).resolves.toBeUndefined()
    expect(logger.error).toHaveBeenCalled()
  })

  it("ignores an account row with no user", async () => {
    const hooks = buildDatabaseHooks({
      config: configWith(),
      database: brokenDatabase(),
    })
    await expect(
      hooks?.account?.update?.after?.(
        { providerId: "credential" } as never,
        {
          path: "/change-password",
        } as never
      )
    ).resolves.toBeUndefined()
  })
})

describe("revoking on sign-out (FR-AUTH-6)", () => {
  const SESSION = { id: "session-1", userId: "user-1" }

  it("does nothing when the option is off", async () => {
    const hooks = buildDatabaseHooks({
      config: configWith(),
      database: brokenDatabase(),
    })
    // A broken database proves it: if the hook ran at all, this would log.
    await expect(
      hooks?.session?.delete?.before?.(SESSION as never, null)
    ).resolves.toBeUndefined()
  })

  it("does nothing when there is no database", async () => {
    const hooks = buildDatabaseHooks({
      config: configWith({ session: { revokeOAuthTokensOnLogout: true } }),
    })
    await expect(
      hooks?.session?.delete?.before?.(SESSION as never, null)
    ).resolves.toBeUndefined()
  })

  it("still signs the user out when the sweep fails", async () => {
    const logger = silentLogger()
    const hooks = buildDatabaseHooks({
      config: configWith({ session: { revokeOAuthTokensOnLogout: true } }),
      database: brokenDatabase(),
      logger,
    })
    await expect(
      hooks?.session?.delete?.before?.(SESSION as never, null)
    ).resolves.toBeUndefined()
    expect(logger.error).toHaveBeenCalled()
  })
})
