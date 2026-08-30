/**
 * `oauth_clients.jsonc` → the `oauth_client` row (FR-OIDC-2/3).
 *
 * Pure: no database, no clock, no randomness. Reconciliation is the part that
 * is hard to test against a live schema, so everything that can be decided
 * without one is decided here and asserted directly.
 *
 * Two things the mapping is *not* allowed to do, both read off the 1.7.1
 * sources rather than its documentation:
 *
 * - **`userId` stays `null` for a file client.** A config-synced client belongs
 *   to the deployment, not to whoever happened to be signed in — and that is
 *   also the marker reconciliation scopes its orphan sweep by, so a row with a
 *   `userId` survives every restart (FR-OIDC-2, **D50**). An administrator
 *   registering a client through `/admin/clients` is the one caller that passes
 *   one: their own id.
 * - **`resourceServer` is not a column.** 1.7.1 decides introspection
 *   authorization from the `oauth_client_resource` links, so the flag becomes
 *   a link at reconcile time — see {@link resourceLinksFor} — and is mirrored
 *   into `metadata` only so an operator reading the row can see what the file
 *   asked for.
 */

import type { IdpConfig } from "../config/derive"
import type { ClientEntry } from "../config/schema/clients-schema"
import { PUBLIC_CLIENT_TYPES } from "../config/schema/clients-schema"

/** The v1 grant set (D26). `client_credentials` is not among them. */
export const DEFAULT_GRANT_TYPES = [
  "authorization_code",
  "refresh_token",
] as const

/** The row shape reconciliation writes. `clientSecret` is already hashed. */
export interface ClientRow {
  clientId: string
  clientSecret: string | null
  name: string | null
  disabled: boolean
  skipConsent: boolean
  enableEndSession: boolean
  scopes: string[] | null
  redirectUris: string[]
  postLogoutRedirectUris: string[]
  grantTypes: string[]
  responseTypes: string[]
  requirePKCE: boolean
  tokenEndpointAuthMethod: string
  applicationType: string | null
  uri: string | null
  icon: string | null
  contacts: string[]
  tos: string | null
  policy: string | null
  metadata: Record<string, unknown> | null
  /**
   * `null` for a config-synced client (FR-OIDC-2), the creating administrator's
   * id for one registered through `/admin/clients` (**D50**). Reconciliation's
   * orphan sweep is scoped to `userId === null`, so this is what keeps an
   * admin-created client alive across a restart.
   */
  userId: string | null
}

export interface MappingOptions {
  /** Already hashed by the caller, which owns the hashing function (R4). */
  hashedSecret?: string
  /** The owning administrator, for a client registered through the admin UI. */
  userId?: string
}

/**
 * The default token-endpoint auth method for a client type.
 *
 * A public client cannot keep a secret, so it authenticates with none and
 * proves possession of the authorization code with PKCE instead.
 */
export function authMethodFor(entry: ClientEntry): string {
  if (entry.tokenEndpointAuthMethod) return entry.tokenEndpointAuthMethod
  return isPublic(entry) ? "none" : "client_secret_basic"
}

export function isPublic(entry: ClientEntry): boolean {
  // `type` is validated by a `superRefine`, so its static type is `string`
  // even though only three values survive parsing.
  return (PUBLIC_CLIENT_TYPES as readonly string[]).includes(entry.type)
}

export function toClientRow(
  entry: ClientEntry,
  options: MappingOptions = {}
): ClientRow {
  const publicClient = isPublic(entry)

  return {
    clientId: entry.clientId,
    // A public client has no secret to store, whatever the file said — the
    // schema already refuses one, and this makes the row unambiguous.
    clientSecret: publicClient ? null : (options.hashedSecret ?? null),
    name: entry.name ?? null,
    disabled: entry.disabled,
    skipConsent: entry.skipConsent,
    enableEndSession: entry.enableEndSession,
    // `null` rather than `[]`: an absent `scopes` means "whatever the
    // deployment allows", and an empty array would mean "none at all".
    scopes: entry.scopes ? [...entry.scopes] : null,
    redirectUris: [...entry.redirectUris],
    postLogoutRedirectUris: [...entry.postLogoutRedirectUris],
    grantTypes: entry.grantTypes
      ? [...entry.grantTypes]
      : [...DEFAULT_GRANT_TYPES],
    responseTypes: entry.responseTypes ? [...entry.responseTypes] : ["code"],
    // PKCE is mandatory for public clients and the default for everyone else.
    requirePKCE: publicClient ? true : entry.requirePKCE,
    tokenEndpointAuthMethod: authMethodFor(entry),
    applicationType: entry.type === "native" ? "native" : null,
    uri: entry.uri ?? null,
    icon: entry.icon ?? null,
    contacts: [...entry.contacts],
    tos: entry.tos ?? null,
    policy: entry.policy ?? null,
    metadata: metadataFor(entry),
    userId: options.userId ?? null,
  }
}

/**
 * `metadata`, carrying the operator's own keys plus the two flags that have no
 * column of their own.
 *
 * `resourceServer` is mirrored here for legibility; the link is what actually
 * authorizes introspection. `firstParty` (FR-OIDC-14) has no 1.7.1 equivalent
 * at all, so this is its only home.
 */
function metadataFor(entry: ClientEntry): Record<string, unknown> | null {
  const own = entry.metadata ?? {}
  const flags: Record<string, unknown> = {}
  if (entry.resourceServer) flags.resourceServer = true
  if (entry.firstParty) flags.firstParty = true

  const merged = { ...own, ...flags }
  return Object.keys(merged).length > 0 ? merged : null
}

/**
 * Which resources a client may ask for (FR-OIDC-6).
 *
 * The deployment's default audience plus anything the client declares. The
 * link is not a convenience: with `enforcePerClientResources` on (the 1.7.1
 * default, S2), a `resource` the client is not linked to is refused, and a
 * client with no links at all could never obtain a JWT access token.
 *
 * A `resourceServer` client is linked to the whole registry instead, which is
 * what lets it introspect tokens it is an audience for rather than only its
 * own (FR-OIDC-4).
 */
export function resourceLinksFor(
  entry: ClientEntry,
  config: IdpConfig
): string[] {
  if (entry.resourceServer) {
    return dedupe(config.resources.map((resource) => resource.identifier))
  }

  const declared = entry.audience
    ? Array.isArray(entry.audience)
      ? entry.audience
      : [entry.audience]
    : []

  return dedupe([...config.defaultAudience, ...declared])
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)]
}
