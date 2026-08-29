# S1 / S2 — Default audience and the resource model (risks R1, R2)

**Status:** mechanism established from the 1.7.1 sources; live verification runs
with the M8 protocol suite. · **Date:** 2026-08-23

## R1 — what actually decides whether an access token is a JWT

`@better-auth/oauth-provider@1.7.1`, token issuance:

```js
const grantIssuance = await resolveResourceGrantIssuance(...)
const audienceClaim  = grantIssuance.audienceClaim
const isJwtAccessToken = audienceClaim && !opts.disableJwtPlugin
```

and in `resolveResourcePolicy`:

```js
const requestedResources = normalizeResourceParam(params.resource)
if (!requestedResources) return { audienceClaim: undefined, /* … */ }
```

**So: no `resource` parameter ⇒ no `aud` ⇒ an opaque access token, not a JWT.**
This is exactly the failure mode FR-OIDC-5/6 exists to prevent, and it confirms
R1 is real: something must supply the default resource.

### Decision — inject `resource` in `hooks.before`

The IdP registers a `hooks.before` matcher on `/oauth2/authorize` and
`/oauth2/token`. When the request carries no `resource`, it adds the client's
own `audience` if it declares one, otherwise `jwt.audience`. Both entry points
are needed:

- **authorize** — the value is stored in the authorization-code verification
  record and travels to the code grant, and from there into the refresh token's
  `resources`, so the refresh grant inherits it automatically;
- **token** — covers a refresh grant whose refresh token predates the hook and a
  client that posts to the token endpoint directly.

No patch of Better Auth is required for R1, so the pre-authorized `pnpm patch`
(spec §13) stays unused.

## The `openid` side effect — `aud` is an array, not a string

`resolveResourcePolicy` ends with:

```js
const audienceIdentifiers = includesOpenid
  ? [...uniqueRequestedResources, userInfoResource(ctx.context.baseURL)]
  : uniqueRequestedResources
const audClaim = [...new Set(audienceIdentifiers)]
return { audienceClaim: audClaim.length === 1 ? audClaim[0] : audClaim, /* … */ }
```

`userInfoResource = (baseURL) => \`${baseURL}/oauth2/userinfo\``. Every OIDC flow
requests `openid`, so **the provider always adds its own userinfo endpoint as a
second audience** and `aud` comes out as a two-element array.

That is legal (RFC 7519 §4.1.3 allows an array, and both `jose` and Neon check
membership), but it contradicts FR-OIDC-6's acceptance criterion "token without
`resource` → `aud = jwt.audience`" read literally, and it hands every resource
server a second audience value it never asked about.

### Decision — superseded 2026-08-24 by **D32**

> ## ⚠ Correction — the `jwt.sign` seam does not exist for a self-hosted JWKS
>
> This section's plan cannot be carried out on 1.7.1. The `jwt` plugin refuses
> to construct at all when `jwt.sign` is set without `jwks.remoteUrl`:
>
> ```js
> // better-auth/dist/plugins/jwt/index.mjs:24
> if (options?.jwt?.sign && !options.jwks?.remoteUrl)
>   throw new BetterAuthError("options.jwks.remoteUrl must be set when using options.jwt.sign")
> ```
>
> `remoteUrl` moves the key set off this deployment, which is the opposite of
> what OPS-12 and FR-OIDC-16 describe. S5 §4's reading — that `sign` is a free
> post-processing hook — was taken from `signJWT()` without checking the
> plugin's constructor.
>
> **What ships instead (D32):** `aud` stays the two-element array the provider
> builds, containing `jwt.audience` and the implicit userinfo identifier. Every
> RFC 7519 §4.1.3 verifier checks `aud` by membership, so Neon, PostgREST and
> `jose` are unaffected; the M8b test asserts membership and a successful
> `jwtVerify({ audience: jwt.audience })` rather than string equality. The
> injection half of R1 — no `resource` means an *opaque* token — is unaffected
> and is what the hook below actually fixes.

### The original plan — normalize `aud` in the `jwt.sign` seam

S5 established that `JwtOptions.jwt.sign` receives the complete payload for every
signed token. The claims builder therefore:

1. drops `{baseURL}/oauth2/userinfo` from `aud` when other audiences are present;
2. collapses a single-element `aud` array back to a string;
3. leaves `aud` untouched when the client explicitly requested several resources.

`aud` then matches FR-OIDC-6 byte-for-byte, without patching Better Auth, and
userinfo keeps working because its own validation path treats that identifier as
implicit (`isAudienceClaimAllowed(..., implicitAudiences)`).

**Verification owed (M8):** an integration test asserting `aud` is the string
`jwt.audience` for a code+PKCE token with `scope=openid …`, and that
`/oauth2/userinfo` still accepts that token.

## R2 — per-client resource links

```js
function resolveEnforcePerClientResources(opts) {
  if (opts.enforcePerClientResources !== undefined) return { value: opts.enforcePerClientResources, source: "explicit" }
  return { value: true, source: "default" }   // ← default is ON
}
```

Confirmed: `enforcePerClientResources` defaults to **true**, and
`assertClientLinkedToResources` throws `invalid_target` for any requested
resource the client is not linked to via `oauthClientResource`.

**Decision:** keep the default on — it is the behavior FR-OIDC-6's third
acceptance criterion asks for — and make reconciliation own the links:

- resource rows themselves are seeded by the plugin from `OAuthOptions.resources`
  (`resourceSeedMode: "merge"`), fed from the effective registry
  (`oauth.resources` ∪ `jwt.audience` ∪ every per-client `audience`);
- reconcile inserts/removes `oauth_client_resource` rows so each client is linked
  to the default audience plus its own `audience` values, and to any resource it
  is declared a `resourceServer` for.

The `enforcePerClientResources: false` fallback from the spec is **not** needed.

## Consequences recorded elsewhere

- FR-OIDC-6 AC is met through the `jwt.sign` normalization, not by the provider
  alone — noted here so the M8 test suite asserts it rather than assuming it.
- The same `jwt.sign` seam carries the FR-OIDC-7 claims for all three token
  paths, which is why the claims builder is a pure function taking a payload.
