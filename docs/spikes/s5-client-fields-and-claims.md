# S5 — Installed-version inventory (risks R9, R10, R4, R5)

**Status:** done · **Date:** 2026-08-23 · **Read against:** the installed packages, not the docs.

| Package | Version |
|---|---|
| `better-auth` | 1.7.1 |
| `@better-auth/oauth-provider` | 1.7.1 |
| `@better-auth/api-key` | 1.7.1 |

## 0. Packaging surprise (affects §4 of the spec)

In 1.7.x the OAuth provider and the API-key plugin are **no longer part of the
`better-auth` package**. `better-auth@1.7.1` ships `admin`, `jwt`, `two-factor`
and friends under `better-auth/plugins/*`; `oauthProvider` and `apiKey` come
from the separate, version-locked packages `@better-auth/oauth-provider@1.7.1`
and `@better-auth/api-key@1.7.1`.

> ## ⚠ Correction (2026-08-24) — this section's conclusion was wrong
>
> This spike concluded that the Better Auth CLI was version-stranded and
> therefore unusable. **It is not.** The CLI was *renamed*:
>
> - `@better-auth/cli` is **deprecated** — npm reports *"Package no longer
>   supported"* — and its `latest` is frozen at 1.4.21.
> - The current CLI is the **`auth`** package, at **1.7.1**, exposing the bins
>   `auth` and `better-auth`, and depending on `better-auth@1.7.1` and
>   `@better-auth/core@1.7.1` — exactly our pinned versions.
>
> The error was reading a stale `latest` as abandonment without checking for a
> rename, and without running `npm view @better-auth/cli deprecated`, which says
> so plainly.
>
> The custom generator described below still produces the committed schema, and
> that schema is validated against a real database and by the drift gate — but
> the *reason* given for it does not hold. Whether it should be replaced by
> `npx auth generate` is tracked as **R-2** in `status.md`; the open question
> there is whether the CLI can emit the `createAuthSchema(schemaName)` factory
> that a runtime-configurable `database.schema` (CFG-4, D27) requires.

Consequence for DM-1 *(as originally reasoned — see the correction above)*:
`@better-auth/cli` is at **1.4.21** on `latest` and depends on
`better-auth@1.4.21` as a *hard dependency*, so `@better-auth/cli generate`
would derive the core tables from a 1.4 core while our plugins are 1.7.

**Decision taken at the time:** generate the Drizzle schema from the *installed*
Better Auth using its own exported `getSchema()` (`better-auth/db`), driven by
our real auth instance. The DM-1 intent — one authoritative schema derived from
the enabled plugins, with a CI drift gate — is preserved either way; only the
tool differs.

### Resolved 2026-08-24 — R-2 settled, recorded as D29

The reasoning above is void. The CLI was **renamed**, not stranded:
`@better-auth/cli` is deprecated at 1.4.21, and `auth@1.7.1` (bins `auth` and
`better-auth`) depends on `better-auth@1.7.1` and `@better-auth/core@1.7.1` —
our exact pins. It was run, not assumed.

**What the diff showed.** Against a shim exporting our own option set, `auth
generate` emits the same **seventeen** tables. Comparing the two as *Drizzle
table objects* rather than as text — `getTableConfig()` on every column,
index and foreign key — the outputs are now **identical across all 17 tables**.

**The generator survives for a structural reason, and only that one.** Where a
Postgres schema is configured the CLI emits, from its own source:

```js
code += `
export const ${schemaVarName} = pgSchema(${JSON.stringify(schemaName)});

`
```

— a module-level `const` with the schema name baked in as a string literal at
generate time. `database.schema` is a **runtime** value (CFG-4, D27, DM-4), so
the module must be a `createAuthSchema(schemaName)` factory plus
`CANONICAL_SCHEMA_NAME` for the migrator to retarget. The CLI has no code path
that emits a function.

**Running it was worth doing anyway — it found two real defects in ours,** and
"identical across 17 tables" is true only *after* fixing them:

| | ours (before) | `auth generate` | who was right |
|---|---|---|---|
| `required` | `if (field.required)` | `attr.required !== false ? ".notNull()" : ""` | the CLI — Better Auth documents `required?: boolean` as `@default true` |
| date defaults | `.toString().includes("new Date()")` | same test | neither: 1.7.1's thunk stringifies as `() => new Date`, **no parentheses**, so both drop the default. Ours now *evaluates* the thunk instead |

The first was the serious one. Every field declaring no `required` became
nullable — including `oauth_access_token.token`, which is also `unique`, and
Postgres permits any number of rows sharing a NULL under a unique index. Also
`expires_at` on both token tables: a token with no expiry was representable.
Fixed in migration `0001_cheerful_korg.sql`, before M8 ever wrote a row.

A third, smaller gap closed at the same time: `field.onUpdate` was ignored
entirely, so `session.updated_at` and `account.updated_at` were not touched on
a Drizzle-side update. No DDL consequence; it is a JavaScript-side hook.

## 1. R9 — client fields (freezes the FR-OIDC-3 mapping)

The database row shape is `SchemaClient`; the RFC 7591 metadata shape is
`OAuthClient`. Reconciliation writes `SchemaClient`.

| `oauth_clients.json` (FR-OIDC-3) | `SchemaClient` field | Note |
|---|---|---|
| `clientId` | `clientId` | |
| `name` | `name` | |
| `type: web` | `tokenEndpointAuthMethod: client_secret_basic\|post`, `clientSecret` set | confidential |
| `type: spa` | `tokenEndpointAuthMethod: "none"`, `requirePKCE: true` | public |
| `type: native` | `tokenEndpointAuthMethod: "none"`, `requirePKCE: true`, `applicationType: "native"` | public |
| `clientSecret` | `clientSecret` | stored per `storeClientSecret` |
| `redirectUris` | `redirectUris` | |
| `postLogoutRedirectUris` | `postLogoutRedirectUris` | |
| `scopes` | `scopes` | |
| `grantTypes` | `grantTypes` | v1 writes `["authorization_code","refresh_token"]` |
| `responseTypes` | `responseTypes` | `["code"]` |
| `requirePKCE` | `requirePKCE` | |
| `skipConsent` | `skipConsent` | |
| `enableEndSession` | `enableEndSession` | |
| `disabled` | `disabled` | |
| `uri`/`icon`/`contacts`/`tos`/`policy` | `uri`/`icon`/`contacts`/`tos`/`policy` | |
| `metadata` | `metadata` (JSON string) | |
| — | `userId` | `null` for config-synced rows (FR-OIDC-2) |

**Gaps found:**

- `clientCredentialsScopes` exists on `SchemaClient` and is simply never written
  (D26 removed M2M from v1).
- **There is no `resourceServer` column.** FR-OIDC-4 wants a client that may
  introspect tokens it is an audience for. 1.7.1 implements this differently:
  introspection authorisation is decided by whether the caller is linked to the
  token's resource through `oauthClientResource`. Our `resourceServer: true`
  therefore becomes "link this client to the resource" at reconcile time and is
  additionally mirrored into `metadata`; no spec change is needed, but the
  mechanism is the resource link, not a client flag.
- `audience` is **not** a client column. Per-client audiences are modelled as
  resources plus `oauthClientResource` links, which is what FR-OIDC-6 already
  describes.

## 2. R10 — which claims the provider emits itself

`createJwtAccessToken` builds the payload as:

```js
{
  ...overrides.accessTokenClaims,   // ← customAccessTokenClaims land here, FIRST
  sub, aud, client_id, azp, scope, sid, iss, iat, exp, jti,
  ...(confirmation ? { cnf } : {}),
}
```

So the provider **always** emits `sub`, `aud`, `client_id`, `azp`, `scope`,
`sid`, `iss`, `iat`, `exp`, `jti`, and custom claims **cannot** override them —
they are spread first and then overwritten. This matches V3 and settles R10:

- the claims builder supplies only `email`, `name`, `given_name`, `family_name`,
  `roles` and the static `jwt.claims`;
- `sid` is auto-emitted, so the API-key path's "random `sid`" (FR-KEY-3) has to
  be supplied through the *session* the api-key plugin creates, not as a claim.

`customAccessTokenClaims(info)` receives `{ user, referenceId, scopes,
resources, metadata }`. It does **not** receive the session id or the client
row, which is why the builder takes what it needs from `user` + `resources`.

## 3. R4 — client-secret hashing (**resolved, no reverse engineering needed**)

`OAuthOptions.storeClientSecret` accepts, besides `"hashed"` and `"encrypted"`,
an explicit pair:

```ts
storeClientSecret?: { hash: (secret: string) => Awaitable<string>
                    ; verify?: (secret: string, storedHash: string) => Awaitable<boolean> }
```

**Decision:** supply our own `hash`/`verify`. Reconciliation then hashes with the
*same function object* the token endpoint verifies with, so the R4 risk
disappears entirely rather than being mitigated. The FR-OIDC-2 parity test
(reconciled secret authenticates at the live token endpoint) stays as the
invariant that proves it.

## 4. R5 — session JWT (`definePayload`) (**resolved, better than expected**)

`JwtOptions.jwt` exposes not only `definePayload`/`getSubject` but a full
`sign(payload, header, signingConfig)` override, and `signJWT()` routes **every**
token through it — the OAuth access token, the ID token and the session JWT from
`GET /api/auth/token`.

**Decision:** `jwt.sign` is the single signing seam. It receives the finished
payload, so one `buildAccessTokenClaims()` normalises all three paths in one
place, which is precisely what FR-OIDC-7 asks for ("one claims builder for all
paths"). See `docs/spikes/s1-default-audience.md` for the second reason this
matters.

## 5. Other options worth knowing (all used by the implementation)

| Option | Why it matters |
|---|---|
| `grantTypes` | Restricts the token endpoint to the two v1 grants (D26). |
| `allowDynamicClientRegistration: false` | FR-OIDC-2: `/oauth2/register` off. |
| `clientPrivileges` / `resourcePrivileges` | Return `false` to deny every client/resource CRUD call — FR-OIDC-2's "denied for every caller". |
| `resources` + `resourceSeedMode` | The provider seeds `oauth_resource` itself; reconcile only has to own the per-client links. |
| `enforcePerClientResources` | **Defaults to `true`** (see S2). |
| `cachedTrustedClients` | FR-OIDC-2. |
| `advertisedMetadata.{scopes,claims}_supported` | FR-OIDC-15. |
| `rateLimit.{token,authorize,introspect,revoke,register,userinfo}` | SEC-2, per endpoint. |
| `storeTokens: "hashed"` | Tokens at rest. |
| `loginPage` / `consentPage` | **Required** options; they anchor the FR-OIDC-9 gate chain. |
| `pairwiseSecret`, `dpop`, `requestUriResolver` | Present in 1.7.1, deliberately unused in v1 (§1.3). |
