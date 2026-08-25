# semantius-idp

A lightweight, self-hosted identity provider: user management, authentication,
and standard JWT access tokens that resource servers validate through JWKS —
Neon and PostgREST-style deployments included.

One container plus Postgres. Configured by files and environment variables,
not by clicking around a database.

```
        ┌───────────┐        code + PKCE        ┌──────────────┐
        │  browser  │ ────────────────────────▶ │              │
        └───────────┘ ◀──────────────────────── │ semantius-idp│──▶ Postgres
              │            id + access token    │              │
              │                                 └──────────────┘
              │  Authorization: Bearer …                 │ JWKS
              ▼                                          ▼
        ┌───────────┐                            ┌──────────────┐
        │ your API  │ ─── validates the JWT ───▶ │  /.well-known│
        │  or Neon  │      against the key set   │  /jwks.json  │
        └───────────┘                            └──────────────┘
```

## What it is

- **An OAuth 2.1 / OpenID Connect provider.** Authorization code with PKCE and
  refresh tokens; discovery, JWKS, userinfo, introspection, revocation and
  RP-initiated logout. Access tokens are **always signed JWTs** (ES256 by
  default), so a resource server validates them offline against the published
  key set — no call back to the IdP on every request.
- **A place for your users to live.** Password sign-in, optional self-service
  sign-up with an approval queue, e-mail verification and reset, TOTP
  two-factor, per-user API keys, and an administration area for the people who
  run it.
- **Configured by files.** `config.json`, `oauth_clients.json` and `roles.json`
  are the source of truth; the database is the reconciled operative store.
  Restarting applies changes, and the same folder produces the same deployment.

### What it is not

- **Not multi-tenant.** One deployment, one user population. No organisations,
  no teams.
- **Not a machine-to-machine token service.** There is no `client_credentials`
  grant in v1; a per-user API key is the answer for scripted access
  ([docs/clients.md](docs/clients.md)).
- **Not a federation hub.** Social sign-in exists (Google, GitHub, Entra) but
  there is no account linking: an identity is a provider subject, and one
  address belongs to one account.
- **Not a horizontally scaled service.** A single instance is what is tested
  and supported. Accidental replicas are safe — every mutating start-up step
  takes an advisory lock — but they are not a topology anyone has measured.

## Why you might want it

Most self-hosted identity providers are either a Java application with a
database schema you inherit, or a hosted product with a per-seat price. This
one is a single container that reads three files, keeps everything in one
Postgres schema (`idp` by default, nothing in `public`), and issues tokens that
Neon, PostgREST and any `jose`-based verifier accept without a plugin.

The trade is deliberate: fewer features, and the ones present are the ones a
small deployment actually uses.

## Quick start

This is the path CI keeps honest: the shipped `config.example` is validated on
every pull request, and [`scripts/smoke-test.ts`](scripts/smoke-test.ts) brings
the same compose stack up against the image that will be published, signs in
through the forced password change, and verifies a token against the JWKS.

```bash
cp -r config.example config          # the annotated defaults
cp .env.example .env                 # then fill in the values it asks for
mkdir -p secrets && printf %s "$POSTGRES_PASSWORD" > secrets/postgres_password

docker compose up -d --wait
curl -fsS localhost:3000/readyz
```

`.env` needs these:

```bash
POSTGRES_PASSWORD=…                  # also copied into secrets/postgres_password
IDP_SECRET=…                         # ≥ 32 random bytes: openssl rand -base64 48
IDP_ADMIN_EMAIL=you@example.com      # ← this is your login
IDP_ADMIN_PASSWORD=…                 # ← and this; you change it at first sign-in

# The two example clients in config/oauth_clients.json refer to these. Give
# them any 32-character value, or delete that file — it is optional, and
# without it you simply have no OAuth clients yet.
EXAMPLE_WEB_CLIENT_SECRET=…
EXAMPLE_FIRSTPARTY_CLIENT_SECRET=…
```

Then open <http://localhost:3000/> and sign in with those last two. You land on
`/change-password` and cannot skip it — the bootstrap account is created with
`mustChangePassword` set, so the password in `.env` survives exactly one
sign-in. Unset both variables afterwards: they are read only when the database
holds no administrator.

> **Nothing else creates an account.** There is no default user and no built-in
> password. If you leave those two variables empty, start-up says so loudly and
> nobody can sign in — see [locked out](#if-you-get-locked-out).

> **Changing the port or the hostname?** Set `IDP_BASE_URL` to match, and edit
> the example first-party client in `config/oauth_clients.json` — its redirect
> URI is `http://localhost:3000/…`, and a `firstParty` client must be on the
> issuer's own origin. Start-up refuses and says exactly that rather than
> issuing tokens to somewhere unexpected.

### Without Docker

```bash
pnpm install
pnpm --filter web run db:generate-schema   # Drizzle schema from Better Auth
pnpm --filter web run db:generate          # SQL migrations
pnpm dev
```

`IDP_CONFIG_DIR` points at the configuration folder (`/config` in the
container). `DATABASE_URL` and `IDP_SECRET` are the two things it cannot start
without.

> **`DIRECT_DATABASE_URL`** is required when `DATABASE_URL` points at a
> transaction-mode connection pooler — Neon's `-pooler` endpoint, PgBouncer.
> Session advisory locks do not hold through one, and start-up, migrations and
> the operator CLI all rely on them. For Neon it is the same URL with `-pooler`
> removed. Start-up warns when the URL looks pooled and this is unset.

## Configuration

Three files, read **once** at start-up. There is no hot reload; changing them
means a restart, which is a property of the read-only mount rather than a
promise in the documentation.

| File | Required | What it holds |
| --- | --- | --- |
| `config.json` | yes | Everything in [docs/configuration.md](docs/configuration.md) |
| `oauth_clients.json` | no | The applications that may ask for tokens — [docs/clients.md](docs/clients.md) |
| `roles.json` | no | The role catalog; absent, you get `admin` and `user` |

They are parsed as JSONC — comments and trailing commas are fine — and any
string may carry a placeholder:

```jsonc
{
  "secret": "${env:IDP_SECRET}",
  "database": { "url": "${env:DATABASE_URL}" },
  "email": { "resend": { "apiKey": "${file:/run/secrets/resend}" } }
}
```

`${env:NAME}`, `${env:NAME:-fallback}` and `${file:/abs/path}` are substituted
once, before validation. `$${` escapes a literal `${`. **Secrets never belong
in the files themselves** — an unresolved variable stops start-up and names the
file, the JSON pointer and the variable, never the value.

`config.example/` ships with every key commented and with JSON Schemas beside
it, so an editor completes and validates as you type:

```jsonc
{ "$schema": "./config.schema.json", … }
```

The keys that decide what you can do on day one:

| Key | Default | What it changes |
| --- | --- | --- |
| `server.baseUrl` | — **required** | The issuer. Every absolute URL derives from it, never from the `Host` header. May carry a path (`https://apps.example.com/idp`). |
| `jwt.audience` | — **required** | What lands in `aud`. For Neon, the audience that project expects. |
| `signUp.enabled` | `false` | Off means `/signup` is **404** and social sign-in works only for identities that already exist. |
| `signUp.requireApproval` | `true` | Self-registrations land as `pending` until an administrator approves them. |
| `email.resend.apiKey` | — | Without it the IdP runs in **degraded mode**: no verification, no reset, no notifications, and `/forgot-password` is 404. Administrators set passwords directly instead. |
| `auth.defaultRedirect` | `/account` | Where a completed sign-in lands. Point it at your product when the IdP is bundled beside one. |
| `admin.adminRoles` | `["admin"]` | Which roles from `roles.json` reach `/admin` and the admin API. |

If a page you expect is missing, it is almost always one of these two: sign-up
is off, or e-mail is not configured. That is deliberate — a control that cannot
work is not shown.

**The full reference is [docs/configuration.md](docs/configuration.md)**,
generated from the same schemas the loader validates against, so CI fails if it
drifts.

## Roles

`roles.json` is a catalog, not a permission system. The IdP evaluates nothing
from a role; it puts them in the token and your applications decide.

```jsonc
{
  "roles": [
    { "name": "admin", "description": "Runs this deployment." },
    { "name": "user", "description": "Everyone else.", "default": true }
  ]
}
```

Exactly one entry is `default: true` — that is what a self-registration gets.
A user may hold several, and they arrive as the **`roles` array** claim. The
singular `role` claim is never derived from them: it exists only as a static
value you set in `jwt.claims`, which is what Neon and PostgREST expect.

## Clients

An entry in `oauth_clients.json` is an application allowed to ask for tokens.
The file is the source of truth: start-up validates it and reconciles it into
the database, disabling anything that has disappeared. Client-creation
endpoints are unreachable, and the admin UI shows them read-only.

```jsonc
{
  "clients": [
    {
      "clientId": "web-app",
      "name": "Web App",
      "type": "web",
      "clientSecret": "${env:WEB_APP_CLIENT_SECRET}",
      "redirectUris": ["https://app.example.com/auth/callback"],
      "scopes": ["openid", "profile", "email", "offline_access"]
    }
  ]
}
```

Worked examples for a public SPA, a confidential server application, a
first-party app and a generic `openid-client` setup are in
[docs/clients.md](docs/clients.md), along with the note about why there is no
machine-to-machine grant.

## Well-known endpoints

Everything a client needs is discoverable from `server.baseUrl`:

| Path | What it is |
| --- | --- |
| `/.well-known/openid-configuration` | OpenID Connect discovery |
| `/.well-known/oauth-authorization-server` | RFC 8414 metadata, same document |
| `/.well-known/jwks.json` | The published key set — the advertised `jwks_uri` |
| `/.well-known/change-password` | Redirects to `/change-password` (RFC 8615) |
| `/oauth2/authorize` `/oauth2/token` `/oauth2/userinfo` | The protocol endpoints |
| `/oauth2/introspect` `/oauth2/revoke` `/oauth2/end-session` | The rest of them |
| `/healthz` `/readyz` | Liveness, and readiness including migrations |

Under a sub-path the RFC 8414 document **also** lives at the origin root —
`https://apps.example.com/.well-known/oauth-authorization-server/idp` — because
that is where a strict client looks. The shipped
[Caddyfile.subpath](Caddyfile.subpath) adds that route.

## Behind a reverse proxy

Two shapes ship, both as working Caddyfiles:

- **[Caddyfile](Caddyfile)** — the IdP owns a hostname. Automatic HTTPS,
  nothing else to think about.
- **[Caddyfile.subpath](Caddyfile.subpath)** — the IdP lives at
  `https://apps.example.com/idp` beside another application. Two rules matter
  and both fail quietly when wrong: proxy `{path}/*` **without stripping the
  prefix**, and route the origin-root RFC 8414 document back to the IdP.

Set `server.trustProxy` when there is a proxy in front, or every caller shares
one rate-limit bucket. `server.baseUrl` must also resolve **from inside the
deployment**: RP-initiated logout verifies an `id_token_hint` against the key
set fetched from that URL.

Start `docker compose up --profile caddy` to run the reference proxy alongside.

## E-mail

Resend, or nothing. Set `email.resend.apiKey` and `email.from` and you get
verification, password reset, and notifications for the events an account's
owner should hear about from someone other than whoever caused them —
password changed, second factor turned on or off, API key created, account
approved or rejected.

Without an API key the deployment runs in **degraded mode**: nothing is sent,
`auth.requireEmailVerification` is forced off, the affected controls disappear,
and administrators set passwords directly or hand over a one-time link.

## Social sign-in

Providers are configured per entry under `social`, and the callback URL is
always `{baseUrl}/api/auth/callback/{provider}`:

| Provider | Callback to register | Also needs |
| --- | --- | --- |
| `google` | `{baseUrl}/api/auth/callback/google` | — |
| `github` | `{baseUrl}/api/auth/callback/github` | — |
| `microsoft` | `{baseUrl}/api/auth/callback/microsoft` | **`tenantId`** — a GUID or verified domain. `common`, `organizations` and `consumers` are refused. |

```jsonc
"social": {
  "google": {
    "clientId": "${env:GOOGLE_CLIENT_ID}",
    "clientSecret": "${env:GOOGLE_CLIENT_SECRET}"
  }
}
```

**There is no account linking.** An identity is `(provider, subject)`. If a
social profile arrives with an address that already belongs to a different
account, the sign-in is refused rather than merged — a provider that lets
someone set an unverified address must not be a way to take over an account.

## Neon and PostgREST

The tokens are ordinary ES256 JWTs with a `kid`, which is all Neon's RLS
integration and PostgREST need. Register the JWKS URL, add the static `role`
claim they expect, and `auth.user_id()` resolves from `sub`.
[docs/neon.md](docs/neon.md) is the walk-through, including the revocation
caveat: a JWT already issued stays valid for a stateless verifier until it
expires, bounded by `oauth.accessTokenTtl` (15 minutes by default).

## Security notes

- **Every absolute URL comes from `server.baseUrl`.** A poisoned `Host` header
  changes nothing — not a redirect, not a link in an e-mail.
- **Rate limits are on by default**, stored in the database so they survive a
  restart, with stricter rules for sign-in, reset, 2FA and the token endpoint.
- **Passwords** are hashed with scrypt (Better Auth's default). Client secrets
  are hashed at rest. The signing keys are AES-256-GCM encrypted with `secret`.
- **Revocation is immediate** everywhere the IdP is asked — refresh,
  introspection, userinfo, its own pages — and bounded by the access-token
  lifetime for stateless verifiers.
- **The audit log** records every security-relevant event with actor, target,
  outcome and request id, and is browsable at `/admin/audit`.
- The CSP concedes `script-src 'unsafe-inline'` because the framework streams
  its own scripts with no seam for a nonce. That is recorded rather than
  hidden — `server/http/security-headers.ts` is the one place to change when
  it can be tightened.

Report a vulnerability through [SECURITY.md](SECURITY.md).

## Operations

Runbooks for upgrades, key rotation, `secret` rotation, client reconciliation,
cleanup, reading the audit log and the egress an install needs are in
[docs/runbooks.md](docs/runbooks.md). Managing users over HTTP —
the same API the admin pages use — is [docs/admin-api.md](docs/admin-api.md).
The operator CLI is the same binary:

```bash
docker compose exec idp idp config validate   # print the effective config, masked
docker compose exec idp idp migrate
docker compose exec idp idp reconcile-clients
docker compose exec idp idp reset-admin       # the way back in
docker compose exec idp idp rotate-keys
docker compose exec idp idp cleanup
docker compose exec idp idp version
```

### If you get locked out

`idp reset-admin` is the answer, in development and in production alike:

```bash
pnpm reset-admin                          # from a checkout
docker compose exec idp idp reset-admin   # against a running container
```

It puts the password back to `admin.bootstrap.password` (`IDP_ADMIN_PASSWORD`),
re-arms the forced change so that value survives exactly one sign-in, makes the
account reachable again if it was suspended or un-approved, and ends every
existing session. Nothing is destroyed: the user row, its id and its audit
history all survive.

Two things it will not do, both on purpose:

- **It never grants an admin role.** An address that exists and holds none is
  refused — otherwise a command with database access would be a one-line
  privilege escalation for anyone who can read the configuration folder.
- **It never creates an address you typed.** With no argument it creates
  `admin.bootstrap.email` on a database that has no administrator, which is the
  bootstrap contract. `idp reset-admin adnim@example.com` fails rather than
  quietly provisioning a second administrator from a typo.

The situation arises because the bootstrap step runs **only when no user holds
an admin role** — so changing `IDP_ADMIN_PASSWORD` afterwards does nothing —
and because the forced first change consumes that password.

### Backups

Out of scope, with one thing worth knowing: the `jwks` table holds your signing
keys, encrypted with `secret`. Lose the database or lose `secret` and every
issued token becomes unverifiable, and every client has to re-fetch the key
set.

## Troubleshooting

| Symptom | Usually |
| --- | --- |
| `invalid_redirect_uri`, and no redirect | The URI is not in that client's `redirectUris`. Matching is exact — scheme, host, port, path, no trailing-slash forgiveness. |
| A client rejects the tokens: issuer mismatch | `server.baseUrl` and what the client was configured with differ byte-for-byte. Discovery's `issuer` is the value to copy. |
| Neon rejects the token | The algorithm. Neon validates ES256 and RS256 only, and needs a `kid` — both are the default here, so check you are not overriding `jwt.algorithm`. |
| Signed in, then immediately signed out | Secure cookies over plain HTTP. Either terminate TLS in front, or set `server.allowInsecureHttp` for local work. |
| Start-up: "Environment variable … is not set" | A `${env:…}` placeholder with no value and no default. The message names the file and the JSON pointer. |
| Start-up hangs on migrations | Another instance holds the advisory lock, or `DATABASE_URL` is a pooler and `DIRECT_DATABASE_URL` is unset. |
| Nothing arrives by e-mail | No `email.resend.apiKey`: the deployment is in degraded mode and says so at start-up. |
| `/signup` is 404 | `signUp.enabled` is false. That is the default. |

## Development

```bash
pnpm dev            # dev server
pnpm test           # unit tests
pnpm typecheck
pnpm lint
pnpm --filter web run test:integration   # needs a real Postgres
pnpm --filter web run test:e2e           # needs Docker; drives the built image
```

Integration tests run against a real Postgres, each file in its own uniquely
named schema. They read `IDP_TEST_DATABASE_URL`, else `DIRECT_DATABASE_URL`,
else `DATABASE_URL`.

End-to-end tests drive the **built image** in a browser, at the host root and
behind Caddy under a sub-path, including a complete OIDC login through the
sample relying party in [`apps/web/e2e/sample-rp.ts`](apps/web/e2e/sample-rp.ts).

After changing the auth configuration or upgrading Better Auth, regenerate and
commit both the schema and the migrations:

```bash
pnpm --filter web run db:generate-schema
pnpm --filter web run db:generate
```

CI fails if the committed schema no longer matches the installed Better Auth,
if the configuration reference is stale, or if a dependency is not pinned
exactly. [CONTRIBUTING.md](CONTRIBUTING.md) has the rest.

## Versioning

Semantic versioning, with the image tagged `X.Y.Z`, `X.Y`, `X`, `latest` and an
immutable `sha-<commit>`. What is checked before a release is
[docs/release.md](docs/release.md). Migrations apply automatically on upgrade and are
forward-only — take a backup before upgrading, because there is no downgrade
path. [CHANGELOG.md](CHANGELOG.md) records what changed.

## Licence

[MIT](LICENSE).
