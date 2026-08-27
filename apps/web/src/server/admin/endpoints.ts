/**
 * The administrative endpoints Better Auth has no equivalent for
 * (FR-ADMIN-2/6, FR-2FA-2, FR-OIDC-16).
 *
 * They are endpoints rather than server functions on purpose. FR-ADMIN-6 makes
 * the admin API the documented management interface and the admin UI one of
 * its callers, so anything the UI can do has to be reachable with an admin API
 * key and a `curl`. The alternative — server functions for the pages plus a
 * parallel API for scripts — is two implementations of every rule, and the
 * second one is always the one that forgets the audit row.
 *
 * They live here rather than in `idp-plugin.ts` because that file carries an
 * 85% coverage gate for the approval workflow, and mixing a read-only stats
 * query into it makes that number say less than it does now.
 */

import { randomBytes } from "node:crypto"

import { APIError, createAuthEndpoint } from "better-auth/api"
import { and, count, desc, eq, gte, lt } from "drizzle-orm"
import { z } from "zod"

import type { Audit } from "../audit"
import type { IdpConfig } from "../config/derive"
import { maskConfig } from "../config/mask"
import {
  PUBLIC_CLIENT_TYPES,
  clientSchema,
} from "../config/schema/clients-schema"
import { withAdvisoryLock } from "../db/advisory-lock"
import { createDb } from "../db/client"
import type { DbHandle } from "../db/client"
import type { Logger } from "../logger"
import type { Mailer } from "../email/mailer"
import { createBasePaths, discoveryUrls } from "../oidc/base-path"
import { refreshDatabaseClientOrigins } from "../oidc/client-origins"
import { isPublic, resourceLinksFor, toClientRow } from "../oidc/client-mapping"
import { revokeTokensFor, syncResourceLinks } from "../oidc/reconcile"
import { rotateKeys } from "../oidc/rotate-keys"
import { revokeAllForUser } from "../oidc/revoke-user-tokens"
import { hashClientSecret } from "../oidc/secret-hash"
import { splitRoles } from "../role-utils"
import { revision, version } from "../version"
import type { AdminContext } from "./context"
import { requireAdmin } from "./gate"

export interface AdminEndpointDeps {
  config: IdpConfig
  /** Absent while the schema is generated, which needs no connection. */
  database?: DbHandle
  audit?: Audit
  logger?: Logger
  mailer?: Mailer
  /** Filled in by `runtime.ts` as each piece becomes available. */
  context?: AdminContext
}

const NO_DATABASE = "This server is running without a database connection."

function db(deps: AdminEndpointDeps): DbHandle {
  if (!deps.database) {
    throw new APIError("SERVICE_UNAVAILABLE", { message: NO_DATABASE })
  }
  return deps.database
}

export function buildAdminEndpoints(deps: AdminEndpointDeps) {
  const gate = requireAdmin(deps.config)

  /**
   * FR-2FA-2: an administrator resets a locked-out user's second factor.
   *
   * Three things have to happen together, and skipping any one of them leaves
   * the account in a state nobody can reason about: the enrolment rows go, the
   * flag on the user goes, and every live session goes with them — because a
   * session that was minted *behind* a second factor is exactly what an
   * attacker who triggered the reset would be holding.
   */
  const resetTwoFactor = createAuthEndpoint(
    "/idp/reset-two-factor",
    {
      method: "POST",
      body: z.object({ userId: z.string().min(1) }),
      requireHeaders: true,
      use: [gate],
    },
    async (ctx) => {
      const handle = db(deps)
      const actor = ctx.context.session.user
      const user = await ctx.context.internalAdapter.findUserById(
        ctx.body.userId
      )
      if (!user) {
        throw new APIError("NOT_FOUND", { message: "No such user." })
      }

      await handle.db
        .delete(handle.schema.twoFactor)
        .where(eq(handle.schema.twoFactor.userId, user.id))
      await ctx.context.internalAdapter.updateUser(user.id, {
        twoFactorEnabled: false,
      })
      await ctx.context.internalAdapter.deleteUserSessions(user.id)
      await revokeAllForUser(
        { database: handle, audit: deps.audit },
        { userId: user.id, reason: "admin:two_factor_reset" }
      )

      await deps.audit?.record({
        action: "twofactor.reset",
        outcome: "success",
        actorType: "session",
        actorUserId: actor.id,
        target: { type: "user", id: user.id },
      })
      await deps.mailer?.send(
        "twoFactorReset",
        (user as { email: string }).email
      )

      return ctx.json({ ok: true })
    }
  )

  /** The numbers the dashboard opens with (FR-ADMIN-2). */
  const adminStats = createAuthEndpoint(
    "/idp/admin-stats",
    { method: "GET", requireHeaders: true, use: [gate] },
    async (ctx) => {
      const handle = db(deps)
      const { user, session, oauthClient, auditLog } = handle.schema
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)

      const [byStatus, sessions, clients, recentSignIns, failures, roles] =
        await Promise.all([
          handle.db
            .select({ status: user.status, total: count() })
            .from(user)
            .groupBy(user.status),
          handle.db
            .select({ total: count() })
            .from(session)
            .where(gte(session.expiresAt, new Date())),
          handle.db
            .select({ disabled: oauthClient.disabled, total: count() })
            .from(oauthClient)
            // Postgres refuses a bare column beside an aggregate; without this
            // the whole endpoint answered 500 and nothing said why.
            .groupBy(oauthClient.disabled),
          handle.db
            .select({ total: count() })
            .from(auditLog)
            .where(
              and(
                eq(auditLog.action, "signin.success"),
                gte(auditLog.createdAt, dayAgo)
              )
            ),
          handle.db
            .select({ total: count() })
            .from(auditLog)
            .where(
              and(
                eq(auditLog.action, "signin.failure"),
                gte(auditLog.createdAt, dayAgo)
              )
            ),
          // Counted in JS: `role` is a comma-separated column, so no `group by`
          // can answer this question correctly.
          handle.db.select({ role: user.role, banned: user.banned }).from(user),
        ])

      const adminRoles = new Set(deps.config.adminRoles)
      return ctx.json({
        users: {
          total: byStatus.reduce((sum, row) => sum + row.total, 0),
          pending: totalFor(byStatus, "pending"),
          active: totalFor(byStatus, "active"),
          rejected: totalFor(byStatus, "rejected"),
          banned: roles.filter((row) => row.banned === true).length,
          admins: roles.filter((row) =>
            splitRoles(row.role).some((role) => adminRoles.has(role))
          ).length,
        },
        sessions: { active: sessions[0]?.total ?? 0 },
        clients: {
          total: clients.reduce((sum, row) => sum + row.total, 0),
          disabled: clients
            .filter((row) => row.disabled === true)
            .reduce((sum, row) => sum + row.total, 0),
        },
        signIns24h: recentSignIns[0]?.total ?? 0,
        signInFailures24h: failures[0]?.total ?? 0,
      })
    }
  )

  /**
   * The audit browser's query (SEC-6).
   *
   * Keyset pagination on `(createdAt, id)` rather than `offset`: the table only
   * ever grows at the head, and an offset walk over a busy trail silently
   * repeats and skips rows as new ones land between pages.
   */
  const auditQuery = createAuthEndpoint(
    "/idp/audit",
    {
      method: "GET",
      requireHeaders: true,
      query: z.object({
        action: z.string().optional(),
        outcome: z.enum(["success", "failure", "denied"]).optional(),
        actorUserId: z.string().optional(),
        targetId: z.string().optional(),
        /** `createdAt` of the last row on the previous page, ISO-8601. */
        before: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      use: [gate],
    },
    async (ctx) => {
      const handle = db(deps)
      const { auditLog } = handle.schema
      const query = ctx.query

      const filters = [
        query.action ? eq(auditLog.action, query.action) : undefined,
        query.outcome ? eq(auditLog.outcome, query.outcome) : undefined,
        query.actorUserId
          ? eq(auditLog.actorUserId, query.actorUserId)
          : undefined,
        query.targetId ? eq(auditLog.targetId, query.targetId) : undefined,
        query.before
          ? lt(auditLog.createdAt, new Date(query.before))
          : undefined,
      ].filter((filter) => filter !== undefined)

      const rows = await handle.db
        .select()
        .from(auditLog)
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
        .limit(query.limit + 1)

      const page = rows.slice(0, query.limit)
      return ctx.json({
        events: page,
        // The cursor is the *row's* timestamp, so the next page starts exactly
        // where this one stopped however many rows share that second.
        nextBefore:
          rows.length > query.limit ? (page.at(-1)?.createdAt ?? null) : null,
      })
    }
  )

  /** What this process is actually running (FR-ADMIN-2, OPS-3). */
  const systemInfo = createAuthEndpoint(
    "/idp/system",
    { method: "GET", requireHeaders: true, use: [gate] },
    async (ctx) => {
      const handle = db(deps)
      const { jwks } = handle.schema

      const keys = await handle.db
        .select({
          id: jwks.id,
          createdAt: jwks.createdAt,
          expiresAt: jwks.expiresAt,
        })
        .from(jwks)
        .orderBy(desc(jwks.createdAt))

      const now = Date.now()
      return ctx.json({
        version,
        revision: revision ?? null,
        issuer: deps.config.base.origin + deps.config.base.basePath,
        // D55: the URLs an operator actually has to paste into the other
        // system. Absolute, and built here rather than in the browser, because
        // the sub-path forms are not derivable from the issuer by hand.
        discovery: discoveryUrls(createBasePaths(deps.config.base), {
          securityTxt: deps.context?.securityTxt ?? false,
        }),
        // SEC-5: masked, positionally, by the same function `idp config
        // validate` prints through.
        config: maskConfig(deps.config.file),
        email: {
          enabled: deps.mailer?.enabled ?? false,
          transport: deps.mailer?.transport ?? "none",
        },
        signingKeys: {
          algorithm: deps.config.file.jwt.algorithm,
          // The *newest live* key is the one signing, which is the whole point
          // of the publish-then-sign rotation (R11) and not obvious from a
          // list ordered by age alone.
          activeKeyId:
            keys.find((key) => !key.expiresAt || key.expiresAt.getTime() > now)
              ?.id ?? null,
          published: keys.length,
          retiring: keys.filter(
            (key) => key.expiresAt && key.expiresAt.getTime() > now
          ).length,
        },
        startup: {
          steps: deps.context?.startup?.steps ?? [],
          reconcile: deps.context?.startup?.reconcile ?? null,
        },
      })
    }
  )

  /**
   * FR-OIDC-16: rotate the signing key now.
   *
   * The rotation needs a *direct* connection for its advisory lock — a session
   * lock does not survive a transaction pooler (S4) — and the one startup used
   * is closed by then. So this opens its own, and closes it whatever happens:
   * a leaked direct connection is one of the few things that can exhaust a
   * small Postgres `max_connections` from a button nobody presses twice.
   */
  const rotateKeysEndpoint = createAuthEndpoint(
    "/idp/rotate-keys",
    { method: "POST", requireHeaders: true, use: [gate] },
    async (ctx) => {
      const handle = db(deps)
      const auth = deps.context?.auth
      if (!auth) {
        throw new APIError("SERVICE_UNAVAILABLE", {
          message: "The server is still starting up.",
        })
      }

      const locking = createDb(deps.config, { direct: true, max: 1 })
      try {
        const result = await rotateKeys({
          config: deps.config,
          database: handle,
          locking,
          auth,
          audit: deps.audit,
          logger: deps.logger,
        })
        return ctx.json({
          ...result,
          actorUserId: ctx.context.session.user.id,
        })
      } finally {
        await locking.close().catch(() => undefined)
      }
    }
  )

  /**
   * Registering an OAuth client from the admin UI (**D50**, FR-OIDC-2/4,
   * FR-ADMIN-2, SEC-4).
   *
   * File clients and database clients coexist, and the thing that keeps them
   * apart is one column: reconciliation's orphan sweep is scoped to
   * `userId === null`, so a row that carries the creating administrator's id
   * survives every restart untouched. That scoping is not new — it is what made
   * this feature a hundred lines rather than a redesign.
   *
   * Three properties are load-bearing:
   *
   *  - **The entry is validated by the same zod schema `oauth_clients.jsonc`
   *    is.** A redirect URI that the file would refuse — a wildcard, a
   *    fragment, plain http off loopback — is refused here too, from one
   *    definition rather than two that drift.
   *  - **The secret is generated server-side and shown once.** An administrator
   *    typing one is a secret that exists in a browser history; 48 random bytes
   *    is well past the schema's 32-character floor.
   *  - **The origin cache is refreshed before the response returns**, or the
   *    new client's first sign-in is blocked by `form-action` in Chrome and by
   *    CORS at the token endpoint, with nothing in the logs naming either.
   *
   * The provider needs no restart: `getClient` falls back to a database lookup
   * for ids outside its trusted-client cache, so a client created here works on
   * the next request.
   */
  const createClient = createAuthEndpoint(
    "/idp/create-client",
    {
      method: "POST",
      body: z.object({
        clientId: z.string().min(1),
        name: z.string().min(1),
        type: z.string().min(1),
        redirectUris: z.array(z.string()).min(1),
        postLogoutRedirectUris: z.array(z.string()).optional(),
        scopes: z.array(z.string()).optional(),
        skipConsent: z.boolean().optional(),
        enableEndSession: z.boolean().optional(),
      }),
      requireHeaders: true,
      use: [gate],
    },
    async (ctx) => {
      const handle = db(deps)
      const actor = ctx.context.session.user

      // Public clients keep no secret; the schema refuses one outright, so it
      // is generated only where it belongs.
      const secret =
        ctx.body.type === "web" ? generateClientSecret() : undefined

      const parsed = clientSchema.safeParse({
        clientId: ctx.body.clientId,
        name: ctx.body.name,
        type: ctx.body.type,
        redirectUris: ctx.body.redirectUris,
        ...(ctx.body.postLogoutRedirectUris?.length
          ? { postLogoutRedirectUris: ctx.body.postLogoutRedirectUris }
          : {}),
        ...(ctx.body.scopes?.length ? { scopes: ctx.body.scopes } : {}),
        ...(ctx.body.skipConsent === undefined
          ? {}
          : { skipConsent: ctx.body.skipConsent }),
        ...(ctx.body.enableEndSession === undefined
          ? {}
          : { enableEndSession: ctx.body.enableEndSession }),
        ...(secret ? { clientSecret: secret } : {}),
      })
      if (!parsed.success) {
        throw new APIError("BAD_REQUEST", {
          code: "INVALID_CLIENT_DEFINITION",
          // The zod message, which already names the offending URI and says
          // why. Re-wording it here would only make it vaguer.
          message: parsed.error.issues.map((issue) => issue.message).join(" "),
        })
      }
      const entry = parsed.data

      // Scopes a client may ask for are bounded by the deployment's own list
      // (FR-OIDC-3); the file schema cannot check that because it does not see
      // `config.jsonc`, and the cross-checks that do only run at load.
      const allowed = new Set(deps.config.file.oauth.scopes)
      const stray = (entry.scopes ?? []).filter((scope) => !allowed.has(scope))
      if (stray.length > 0) {
        throw new APIError("BAD_REQUEST", {
          code: "SCOPE_NOT_ALLOWED",
          message: `Not in \`oauth.scopes\`: ${stray.join(", ")}.`,
        })
      }

      // The same lock reconciliation takes, on a direct connection: a client
      // created while a container is booting must not race the sweep that
      // decides which rows are orphans (D27, S4).
      const locking = createDb(deps.config, { direct: true, max: 1 })
      try {
        await withAdvisoryLock(locking.sql, "reconcileClients", async () => {
          await handle.db.transaction(async (tx) => {
            const [existing] = await tx
              .select({ clientId: handle.schema.oauthClient.clientId })
              .from(handle.schema.oauthClient)
              .where(eq(handle.schema.oauthClient.clientId, entry.clientId))
              .limit(1)
            if (existing) {
              throw new APIError("CONFLICT", {
                code: "CLIENT_ALREADY_EXISTS",
                message: "A client with that id is already registered.",
              })
            }

            await tx.insert(handle.schema.oauthClient).values({
              id: crypto.randomUUID(),
              ...toClientRow(entry, {
                ...(secret ? { hashedSecret: hashClientSecret(secret) } : {}),
                // The marker. Everything about how this row is treated at the
                // next restart follows from it (D50).
                userId: actor.id,
              }),
              createdAt: new Date(),
              updatedAt: new Date(),
            })

            await syncResourceLinks(
              tx,
              handle.schema,
              entry.clientId,
              resourceLinksFor(entry, deps.config)
            )
          })
        })
      } finally {
        await locking.close().catch(() => undefined)
      }

      await refreshDatabaseClientOrigins(handle, deps.logger)
      await deps.audit?.record({
        action: "client.created",
        outcome: "success",
        actorType: "session",
        actorUserId: actor.id,
        target: { type: "client", id: entry.clientId },
        // Never the secret (SEC-6, SEC-10).
        metadata: { type: entry.type, redirectUris: entry.redirectUris.length },
      })

      // The only time the secret is ever readable. The row holds a hash.
      return ctx.json({
        clientId: entry.clientId,
        clientSecret: secret ?? null,
        isPublic: isPublic(entry),
      })
    }
  )

  /**
   * Editing an admin-registered client (**D72**, FR-OIDC-2/4, FR-ADMIN-2).
   *
   * **Full replace, not a patch.** The body carries the same fields the create
   * form does, and that field set *is* the writable surface: a partial update
   * would need a way to say "unset `postLogoutRedirectUris`" that is different
   * from "did not mention it", and every caller — the dialog included — has
   * the whole row in front of it anyway.
   *
   * Better Auth ships `/oauth2/update-client` and it stays unreachable, for
   * the reasons D50 gave for not using its registration endpoint either: it is
   * scoped to the client's creator rather than to an administrator, it does
   * not know half these fields, and it validates against nothing this
   * deployment recognises — no `clientSchema`, no `oauth.scopes` bound, no
   * reconcile lock, no audit row.
   *
   * Five things are load-bearing, and each of them is a way to quietly break a
   * working client:
   *
   *  - **`userId` is written back explicitly.** `toClientRow` defaults it to
   *    `null`, which is the file marker — so an update that forgot it would
   *    hand the row to reconciliation's orphan sweep, and the next restart
   *    would disable a client nobody touched.
   *  - **`disabled` comes from the existing row**, not from the schema's
   *    `false` default: an edit to a disabled client's name must not turn it
   *    back on.
   *  - **The stored hash is passed through, never re-hashed.** A confidential
   *    client that stays confidential goes on working with the secret its
   *    operator already deployed. The hash is also what the schema sees as
   *    `clientSecret` — 64 hex characters clears its 32-character floor —
   *    because the plaintext is gone and the field is mandatory for `web`.
   *  - **The whole merged entry is re-validated**, so a type change re-checks
   *    the stored URIs: a private-scheme redirect is legal for `native` and
   *    not for `web`, and this is the only moment that can be caught.
   *  - **Tokens are revoked only when the credential model flips.** Public and
   *    confidential are different ways of authenticating, so a token issued
   *    under one is not evidence under the other; a renamed client or an added
   *    redirect URI revokes nothing, which is what the file path's own update
   *    does at reconcile time.
   */
  const updateClient = createAuthEndpoint(
    "/idp/update-client",
    {
      method: "POST",
      body: z.object({
        clientId: z.string().min(1),
        name: z.string().min(1),
        type: z.string().min(1),
        redirectUris: z.array(z.string()).min(1),
        postLogoutRedirectUris: z.array(z.string()).optional(),
        scopes: z.array(z.string()).optional(),
        skipConsent: z.boolean().optional(),
        enableEndSession: z.boolean().optional(),
      }),
      requireHeaders: true,
      use: [gate],
    },
    async (ctx) => {
      const handle = db(deps)
      const actor = ctx.context.session.user
      await assertMutableClient(handle, ctx.body.clientId)

      let freshSecret: string | undefined
      let publicAfter = false

      const locking = createDb(deps.config, { direct: true, max: 1 })
      try {
        await withAdvisoryLock(locking.sql, "reconcileClients", async () => {
          await handle.db.transaction(async (tx) => {
            // Re-read inside the lock. `assertMutableClient` answered before it
            // was taken, and what the lock serialises against is a reconcile
            // that could have turned this row into a file client, or removed
            // it, in between.
            const [existing] = await tx
              .select()
              .from(handle.schema.oauthClient)
              .where(eq(handle.schema.oauthClient.clientId, ctx.body.clientId))
              .limit(1)
            if (!existing) {
              throw new APIError("NOT_FOUND", {
                code: "CLIENT_NOT_FOUND",
                message: "No such client.",
              })
            }
            if (existing.userId === null) {
              throw new APIError("BAD_REQUEST", {
                code: "CLIENT_MANAGED_BY_FILE",
                message:
                  "That client comes from oauth_clients.jsonc. Edit the file and restart.",
              })
            }

            const wasPublic = existing.clientSecret === null
            const targetPublic = (
              PUBLIC_CLIENT_TYPES as readonly string[]
            ).includes(ctx.body.type)

            // Three dispositions, one per transition. Confidential → the same
            // secret; public → confidential mints one; anything → public keeps
            // none, and `toClientRow` nulls the column either way.
            const carriedSecret = targetPublic
              ? undefined
              : (existing.clientSecret ?? undefined)
            freshSecret =
              targetPublic || carriedSecret ? undefined : generateClientSecret()
            const hashedSecret = targetPublic
              ? undefined
              : (carriedSecret ?? hashClientSecret(freshSecret!))

            const parsed = clientSchema.safeParse({
              clientId: ctx.body.clientId,
              name: ctx.body.name,
              type: ctx.body.type,
              redirectUris: ctx.body.redirectUris,
              ...(ctx.body.postLogoutRedirectUris?.length
                ? { postLogoutRedirectUris: ctx.body.postLogoutRedirectUris }
                : {}),
              ...(ctx.body.scopes?.length ? { scopes: ctx.body.scopes } : {}),
              ...(ctx.body.skipConsent === undefined
                ? {}
                : { skipConsent: ctx.body.skipConsent }),
              ...(ctx.body.enableEndSession === undefined
                ? {}
                : { enableEndSession: ctx.body.enableEndSession }),
              // The stored hash stands in for the secret the schema demands of
              // a `web` client. Never the plaintext — there is none to have.
              ...(hashedSecret ? { clientSecret: hashedSecret } : {}),
              // Not the schema default: an edit must not un-disable a client.
              disabled: existing.disabled,
            })
            if (!parsed.success) {
              throw new APIError("BAD_REQUEST", {
                code: "INVALID_CLIENT_DEFINITION",
                message: parsed.error.issues
                  .map((issue) => issue.message)
                  .join(" "),
              })
            }
            const entry = parsed.data

            const allowed = new Set(deps.config.file.oauth.scopes)
            const stray = (entry.scopes ?? []).filter(
              (scope) => !allowed.has(scope)
            )
            if (stray.length > 0) {
              throw new APIError("BAD_REQUEST", {
                code: "SCOPE_NOT_ALLOWED",
                message: `Not in \`oauth.scopes\`: ${stray.join(", ")}.`,
              })
            }

            publicAfter = isPublic(entry)

            await tx
              .update(handle.schema.oauthClient)
              .set({
                ...toClientRow(entry, {
                  ...(hashedSecret ? { hashedSecret } : {}),
                  // Non-negotiable: the default is `null`, and a nulled owner
                  // is what the next reconcile's orphan sweep disables.
                  userId: existing.userId,
                }),
                updatedAt: new Date(),
              })
              .where(eq(handle.schema.oauthClient.clientId, ctx.body.clientId))

            // The credential model changed, so what was issued under the old
            // one is no longer evidence of anything. A name or URI edit falls
            // straight through here, matching the file path's own update.
            if (wasPublic !== publicAfter) {
              await revokeTokensFor(tx, handle.schema, ctx.body.clientId)
            }

            await syncResourceLinks(
              tx,
              handle.schema,
              entry.clientId,
              resourceLinksFor(entry, deps.config)
            )
          })
        })
      } finally {
        await locking.close().catch(() => undefined)
      }

      // The redirect URIs feed CORS and the `form-action` CSP directive, so an
      // edited URI that is not in the cache is a client that cannot be
      // redirected to, with nothing in the log naming why (D50).
      await refreshDatabaseClientOrigins(handle, deps.logger)
      await deps.audit?.record({
        action: "client.updated",
        outcome: "success",
        actorType: "session",
        actorUserId: actor.id,
        target: { type: "client", id: ctx.body.clientId },
        // Counts and flags only, never secret material (SEC-6, SEC-10).
        metadata: {
          type: ctx.body.type,
          redirectUris: ctx.body.redirectUris.length,
          isPublic: publicAfter,
          secretIssued: freshSecret !== undefined,
        },
      })

      // Create's shape, so the route reuses its stash-and-show logic verbatim.
      return ctx.json({
        clientId: ctx.body.clientId,
        clientSecret: freshSecret ?? null,
        isPublic: publicAfter,
      })
    }
  )

  /**
   * Replacing an admin-registered client's secret (**D72**).
   *
   * Deliberately smaller than it looks. Rotation is **hygiene, not incident
   * response**: it writes one column and revokes nothing, because a live
   * refresh token was issued to the client that still is that client, and an
   * administrator who believes a secret is compromised has Disable and Remove,
   * both of which do revoke. There is no dual-secret grace window in v1 — the
   * old secret stops working the moment this returns, which is what the dialog
   * says before it is confirmed.
   *
   * No advisory lock, on `set-client-disabled`'s precedent: a single-column
   * write to one row races nothing a reconcile does, and the lock is there to
   * serialise the sweep that decides which rows are orphans. No origin refresh
   * either — a secret is not a redirect URI.
   */
  const rotateClientSecret = createAuthEndpoint(
    "/idp/rotate-client-secret",
    {
      method: "POST",
      body: z.object({ clientId: z.string().min(1) }),
      requireHeaders: true,
      use: [gate],
    },
    async (ctx) => {
      const handle = db(deps)
      const actor = ctx.context.session.user
      await assertMutableClient(handle, ctx.body.clientId)

      const [existing] = await handle.db
        .select({ clientSecret: handle.schema.oauthClient.clientSecret })
        .from(handle.schema.oauthClient)
        .where(eq(handle.schema.oauthClient.clientId, ctx.body.clientId))
        .limit(1)
      if (!existing) {
        throw new APIError("NOT_FOUND", {
          code: "CLIENT_NOT_FOUND",
          message: "No such client.",
        })
      }
      if (existing.clientSecret === null) {
        // A public client authenticates with PKCE and nothing else. Minting a
        // secret here would silently change what it is; that is an edit, and
        // `/idp/update-client` is where an edit belongs.
        throw new APIError("BAD_REQUEST", {
          code: "CLIENT_HAS_NO_SECRET",
          message:
            "That application is a public client and has no secret to rotate.",
        })
      }

      const secret = generateClientSecret()
      await handle.db
        .update(handle.schema.oauthClient)
        .set({ clientSecret: hashClientSecret(secret), updatedAt: new Date() })
        .where(eq(handle.schema.oauthClient.clientId, ctx.body.clientId))

      await deps.audit?.record({
        action: "client.secret_rotated",
        outcome: "success",
        actorType: "session",
        actorUserId: actor.id,
        target: { type: "client", id: ctx.body.clientId },
      })

      // The only time the new secret is readable; the row holds a hash.
      return ctx.json({ clientId: ctx.body.clientId, clientSecret: secret })
    }
  )

  /**
   * Removing an admin-registered client (**D50**).
   *
   * Tokens and consents go with it, for the same reason reconciliation revokes
   * them when a client leaves the file: a client that is gone must stop
   * working, and a refresh token outliving its client is a credential with no
   * owner. Consents too — a client that comes back is a new grant decision.
   */
  const deleteClient = createAuthEndpoint(
    "/idp/delete-client",
    {
      method: "POST",
      body: z.object({ clientId: z.string().min(1) }),
      requireHeaders: true,
      use: [gate],
    },
    async (ctx) => {
      const handle = db(deps)
      const actor = ctx.context.session.user
      await assertMutableClient(handle, ctx.body.clientId)

      const locking = createDb(deps.config, { direct: true, max: 1 })
      try {
        await withAdvisoryLock(locking.sql, "reconcileClients", async () => {
          await handle.db.transaction(async (tx) => {
            await revokeTokensFor(tx, handle.schema, ctx.body.clientId)
            await tx
              .delete(handle.schema.oauthClientResource)
              .where(
                eq(
                  handle.schema.oauthClientResource.clientId,
                  ctx.body.clientId
                )
              )
            await tx
              .delete(handle.schema.oauthClient)
              .where(eq(handle.schema.oauthClient.clientId, ctx.body.clientId))
          })
        })
      } finally {
        await locking.close().catch(() => undefined)
      }

      await refreshDatabaseClientOrigins(handle, deps.logger)
      await deps.audit?.record({
        action: "client.deleted",
        outcome: "success",
        actorType: "session",
        actorUserId: actor.id,
        target: { type: "client", id: ctx.body.clientId },
      })
      return ctx.json({ ok: true })
    }
  )

  /**
   * Switching an admin-registered client off, and on again (**D50**).
   *
   * Disabling revokes what it was holding — the point is that it stops working
   * now, not when its access tokens expire — and takes its origin out of the
   * CORS and `form-action` sets, which is the difference between "cannot get a
   * token" and "cannot be redirected to at all".
   */
  const setClientDisabled = createAuthEndpoint(
    "/idp/set-client-disabled",
    {
      method: "POST",
      body: z.object({ clientId: z.string().min(1), disabled: z.boolean() }),
      requireHeaders: true,
      use: [gate],
    },
    async (ctx) => {
      const handle = db(deps)
      const actor = ctx.context.session.user
      await assertMutableClient(handle, ctx.body.clientId)

      await handle.db.transaction(async (tx) => {
        await tx
          .update(handle.schema.oauthClient)
          .set({ disabled: ctx.body.disabled, updatedAt: new Date() })
          .where(eq(handle.schema.oauthClient.clientId, ctx.body.clientId))
        if (ctx.body.disabled) {
          await revokeTokensFor(tx, handle.schema, ctx.body.clientId)
        }
      })

      await refreshDatabaseClientOrigins(handle, deps.logger)
      await deps.audit?.record({
        action: "client.disabled",
        outcome: "success",
        actorType: "session",
        actorUserId: actor.id,
        target: { type: "client", id: ctx.body.clientId },
        metadata: { disabled: ctx.body.disabled },
      })
      return ctx.json({ ok: true })
    }
  )

  /**
   * Refuses to touch a row the configuration file owns.
   *
   * `userId === null` is the file marker (FR-OIDC-2). Editing one here would be
   * a change the next restart silently undoes, which is worse than no control
   * at all — it is the exact reason this page was read-only until D50.
   */
  async function assertMutableClient(
    handle: DbHandle,
    clientId: string
  ): Promise<void> {
    const [row] = await handle.db
      .select({ userId: handle.schema.oauthClient.userId })
      .from(handle.schema.oauthClient)
      .where(eq(handle.schema.oauthClient.clientId, clientId))
      .limit(1)
    if (!row) {
      throw new APIError("NOT_FOUND", {
        code: "CLIENT_NOT_FOUND",
        message: "No such client.",
      })
    }
    if (row.userId === null) {
      throw new APIError("BAD_REQUEST", {
        code: "CLIENT_MANAGED_BY_FILE",
        message:
          "That client comes from oauth_clients.jsonc. Edit the file and restart.",
      })
    }
  }

  return {
    resetTwoFactor,
    adminStats,
    auditQuery,
    systemInfo,
    rotateKeys: rotateKeysEndpoint,
    createClient,
    updateClient,
    rotateClientSecret,
    deleteClient,
    setClientDisabled,
  }
}

/**
 * A client secret nobody chose.
 *
 * 48 random bytes, base64url — 64 characters, well past the schema's 32, and
 * generated where it is stored rather than typed into a form.
 */
function generateClientSecret(): string {
  return randomBytes(48).toString("base64url")
}

function totalFor(
  rows: { status: string | null; total: number }[],
  status: string
): number {
  return rows.find((row) => row.status === status)?.total ?? 0
}
