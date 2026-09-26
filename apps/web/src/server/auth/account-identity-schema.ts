/**
 * One sign-in identity, one account row — held by Postgres, not by a lookup.
 *
 * Better Auth 1.7.0 added `account.issuer` with a unique index on
 * `(issuer, account_id)`, and 1.7.3 reverted both in favor of the 1.6 shape,
 * which identifies an account by `(providerId, accountId)` and declares **no**
 * unique index for it. What is left is the library looking the pair up before
 * it links one — a read followed by a write, so two concurrent sign-ins with
 * the same social identity can both find nothing and both insert, and the
 * second user then owns an identity the first one also signs in with. The
 * index turns that race into a refused insert.
 *
 * `(providerId, accountId)` rather than the old pair because it is the key the
 * library now matches on, and because it is at least as strict: a credential
 * row's `accountId` is its user's id, and a social row's is the provider's
 * subject, so no existing database holds two rows that share it.
 *
 * Contributed through `idp-plugin.ts`'s `schema` — Better Auth merges a
 * plugin's `indexes` for a core table into that table — so `getAuthTables()`,
 * the schema generator and the drift gate all see it and nothing generated is
 * edited by hand. Its own file for the reason `gateways/schema.ts` gives.
 */
import type { BetterAuthPluginDBSchema } from "@better-auth/core/db"

export const accountIdentitySchema = {
  account: {
    fields: {},
    indexes: [{ fields: ["providerId", "accountId"], unique: true }],
  },
} satisfies BetterAuthPluginDBSchema
