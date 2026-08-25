# Neon, PostgREST, and anything else that validates a JWT

The tokens this IdP issues are ordinary ES256 JWTs with a `kid` in the header.
Nothing here is Neon-specific: the same three facts — the key set URL, the
algorithm, and which claim carries the user id — are what every offline
verifier needs.

## The short version

| What it asks for | What to give it |
| --- | --- |
| JWKS URL | `{baseUrl}/.well-known/jwks.json` |
| Algorithm | `ES256` (the default), or `RS256` |
| The user id | the `sub` claim |
| Audience, if it checks one | whatever you set as `jwt.audience` |

For a deployment at `https://idp.example.com`, that is
`https://idp.example.com/.well-known/jwks.json`.

## Why that URL and not the other one

Both `/.well-known/jwks.json` and `/api/auth/jwks` return the same key set,
byte for byte. The well-known one is what discovery advertises as `jwks_uri`,
and it is the one to register — because a deployment is allowed to publish
*only* `/.well-known/*` and keep the sign-in pages on an internal network. A
verifier pointed at `/api/auth/jwks` would then be pointed at something it
cannot reach.

## Setting it up in Neon

1. **Publish the IdP over public HTTPS.** Neon fetches the key set from the
   internet; a URL that only resolves inside your network cannot work. If the
   UI is internal, expose the `/.well-known/` prefix and nothing else.
2. **Add the JWKS URL** to the Neon project's authentication settings, with
   the audience if you configure one.
3. **Emit the `role` claim Neon expects.** Postgres decides permissions from a
   role name, and it is a *static* string for every signed-in user:

   ```jsonc
   // config.json
   "jwt": {
     "audience": "https://idp.example.com",
     "claims": { "role": "authenticated" }
   }
   ```

   This is `jwt.claims`, not `roles`. The two are different on purpose — see
   below.
4. **Restart.** Configuration is read once.

A token then looks like this:

```json
{
  "iss": "https://idp.example.com",
  "sub": "Kx7mQ2vR9pL4nW8sT1yZbH3gJ6dF0aCe",
  "aud": ["https://idp.example.com", "https://idp.example.com/api/auth/oauth2/userinfo"],
  "email": "ada@example.com",
  "name": "Ada Lovelace",
  "roles": ["admin", "user"],
  "role": "authenticated",
  "scope": "openid profile email",
  "client_id": "web-app",
  "exp": 1787660768
}
```

`aud` is an array. Every RFC 7519 verifier — Neon, PostgREST, `jose` — checks
audience by membership, so a configured audience of
`https://idp.example.com` matches. The second entry is the userinfo endpoint,
which the provider appends whenever `openid` scope is requested.

## `role` and `roles` are not the same thing

| Claim | Comes from | What it is for |
| --- | --- | --- |
| `role` (string) | `jwt.claims` in `config.json` | A **constant**. Postgres switches to this role for every request. Usually `"authenticated"`. |
| `roles` (array) | the user's own catalog roles | **Per user.** What your application checks to decide what they may do. |

The singular `role` is never derived from a user's roles, and a user's roles
never end up in `role`. Mixing them means either every user gets the same
permissions or Postgres gets a role name that does not exist.

## A minimal RLS policy

With `role: "authenticated"` and `sub` carrying the user id, Neon's
`auth.user_id()` resolves and a per-owner policy is three lines:

```sql
alter table notes enable row level security;

create policy notes_are_mine on notes
  for all
  to authenticated
  using (owner_id = auth.user_id())
  with check (owner_id = auth.user_id());
```

`owner_id` is a `text` column holding the IdP's user id — the same value as
`sub`. It is not a UUID: user ids here are random 32-character strings.

To branch on a user's own roles inside SQL, read the claim rather than the
Postgres role:

```sql
create policy admins_see_everything on notes
  for select
  to authenticated
  using (
    owner_id = auth.user_id()
    or (current_setting('request.jwt.claims', true)::json -> 'roles') ? 'admin'
  );
```

## PostgREST

The same token works. PostgREST reads `role` to switch roles and everything
else is available through `current_setting('request.jwt.claims', true)`:

```sql
create or replace function current_user_id() returns text language sql stable as $$
  select current_setting('request.jwt.claims', true)::json ->> 'sub'
$$;
```

Point PostgREST at the JWKS URL with `jwt-secret` set to the key set, or use
`PGRST_JWT_SECRET_IS_BASE64=false` with a fetched JWKS, depending on your
version.

## Key rotation, and the cache

Signing keys rotate every `jwt.rotationInterval` (90 days by default). A new
key is **published before it signs anything**, and the retired key stays in the
key set for `jwt.gracePeriod` — which defaults to the longest token lifetime
plus an hour, comfortably longer than Neon's JWKS cache of up to one hour.

So a rotation needs nothing from you. What does need care is rotating
`secret`: the signing keys are encrypted with it, and changing it makes them
undecryptable. That is a re-key, not a restart —
[docs/runbooks.md](runbooks.md) has the sequence.

You can rotate on demand from `/admin/system`, or:

```bash
docker compose exec idp idp rotate-keys
```

## The revocation caveat

**A JWT that has already been issued stays valid until it expires**, whatever
happens to the account behind it. That is what "validated offline" means: Neon
never asks the IdP anything, so it cannot be told the user was suspended
thirty seconds ago.

The window is bounded by `oauth.accessTokenTtl` — 15 minutes by default, and
the thing to shorten if that is too long for you. Everywhere the IdP *is*
asked, revocation is immediate: the refresh grant, introspection, userinfo,
API-key verification and its own pages all re-check the account on every use.

Banning a user, rejecting them, deleting them, or changing their password
revokes every session and every refresh token at once. What survives is only
the access tokens already in flight, and only until they expire.

## Checking it works

```bash
# The key set a verifier will fetch.
curl -s https://idp.example.com/.well-known/jwks.json | jq '.keys[0] | {kty, alg, kid, use}'
# { "kty": "EC", "alg": "ES256", "kid": "…", "use": "sig" }

# A token for a signed-in browser session, decoded.
curl -s -H "Cookie: $COOKIE" https://idp.example.com/api/auth/token \
  | jq -r .token | cut -d. -f2 | base64 -d | jq
```

If Neon refuses the token, it is almost always one of three things: the
algorithm is not ES256 or RS256, the key set URL is not reachable from the
public internet, or the audience configured in Neon is not one of the values in
`aud`.
