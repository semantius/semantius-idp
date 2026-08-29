/**
 * The `gateway` table's Better Auth schema declaration (FR-GW-2, **D91**).
 *
 * **Here rather than in `idp-plugin.ts`, for the reason that file's own
 * neighbours give.** `admin/endpoints.ts` says it: `idp-plugin.ts` carries an
 * 85 % coverage gate written for the approval workflow, and adding things to
 * it makes that number say less than it does now. A table declaration is three
 * arrow functions no test calls — the `defaultValue` thunks the generator
 * turns into `.defaultNow()` — so putting it there drops that gate's function
 * coverage without telling anyone anything about approvals.
 *
 * The plugin still *contributes* it: `idp-plugin.ts` spreads this into its
 * `schema`, which is what `getAuthTables()` reads and therefore what the DM-1
 * generator and the drift gate see. Only the source file moved.
 */

/**
 * The API gateways of FR-GW-2 (**D91**).
 *
 * A table rather than "read `config.gateways` on every request", for the same
 * reason `oauth_client` is one: the admin page adds rows the file does not
 * know about, and something has to hold them. Config entries are reconciled
 * into it at boot and swept when they leave the file.
 *
 * **`source` is an explicit column, and that is a deliberate divergence from
 * `oauth_client`**, where "the file owns this row" is spelled `userId === null`
 * (D50). The marker there is a side effect of a column that exists for another
 * reason and has to be explained every time it is read; here the sweep is a
 * plain `where source = 'config'` and the row says what it is.
 *
 * No `id` field: the schema generator prepends one to every model.
 */
export const gatewaySchema = {
  gateway: {
    modelName: "gateway",
    fields: {
      /** The URL path segment: `/gateway/<name>`. Unique, lower-case. */
      name: { type: "string" as const, required: true, unique: true },
      /** Absolute http(s) URL, no trailing slash (`lib/gateway-rules.ts`). */
      url: { type: "string" as const, required: true },
      /**
       * Refuse an unauthenticated request rather than forwarding it
       * anonymously (FR-GW-4). For an upstream with no anonymous role.
       */
      requireAuth: {
        type: "boolean" as const,
        required: false,
        defaultValue: false,
      },
      /**
       * Forward the edge's `X-Forwarded-*` rather than this hop's own view
       * (FR-GW-3, **D92**). Off unless a trusted proxy sits in front.
       */
      trustProxy: {
        type: "boolean" as const,
        required: false,
        defaultValue: false,
      },
      /** `config` (file-owned, swept by reconcile) or `manual` (admin-owned). */
      source: { type: "string" as const, required: true, index: true },
      enabled: {
        type: "boolean" as const,
        required: false,
        defaultValue: true,
      },
      createdAt: {
        type: "date" as const,
        required: true,
        defaultValue: () => new Date(),
      },
      updatedAt: {
        type: "date" as const,
        required: true,
        defaultValue: () => new Date(),
        onUpdate: () => new Date(),
      },
    },
  },
} as const
