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

Everything the deployment needs lives in [`docker/`](docker/): the Dockerfile,
the compose files, the Caddyfiles, and a `.cmd`/`.sh` pair per lifecycle verb.

```bash
cd docker
./idp-create.sh         # idp-create.cmd on Windows
```

On a clean checkout that creates `.env` and `config/` from the shipped examples,
builds the image, brings the stack up and waits for it to report healthy. Then
open <http://localhost:3000/>.

**The first thing you will see is a setup page**, because a fresh database has
no accounts at all. Fill in your name, address and password and you are the
first administrator, signed in. There is no bootstrap password and nothing to
unset afterwards.

Before a real run, put your own values in `.env` at the repository root:

```bash
IDP_SECRET=…            # ≥ 32 random bytes: openssl rand -base64 48
DATABASE_URL=…          # only to point somewhere other than the bundled Postgres
```

`IDP_SECRET` is the one value with no sensible default: it encrypts the signing
keys and signs every session. `DATABASE_URL` already points at the Postgres
compose starts — a whole connection string, which is the contract (**D48**):
nothing is assembled from a password and there is no secrets file to keep in
step. Point it at your own Postgres or at Neon and the bundled one becomes
irrelevant.

The rest of the verbs read the same way:

```bash
./idp-status.sh     # created / running (healthy) / exited
./idp-logs.sh       # follow the IdP's log
./idp-stop.sh       # stop the containers, keep them
./idp-start.sh      # resume the ones create made
./idp-cli.sh …      # the operator CLI inside the container
./idp-destroy.sh    # remove containers, network and volumes — all data
```

`pnpm docker:build`, `docker:up`, `docker:down` and `docker:smoke` do the same
things from the repository root, for anyone who would rather not change
directory. CI keeps the path honest: the shipped `config.example` is validated
on every pull request, and [`scripts/smoke-test.ts`](scripts/smoke-test.ts)
brings this exact stack up against the image that will be published, completes
the setup wizard, and verifies a token against the JWKS.

> **Changing the port or the hostname?** Set `IDP_BASE_URL` to match, and edit
> the example first-party client in `config/oauth_clients.json` — its redirect
> URI is `http://localhost:3000/…`, and a `firstParty` client must be on the
> issuer's own origin. Start-up refuses and says exactly that rather than
> issuing tokens to somewhere unexpected.

> **Caddy is never in the image.** It is an optional compose profile in front of
> it, for TLS or for serving the IdP under a sub-path — see
> [behind a reverse proxy](#behind-a-reverse-proxy). Of the test suites only the
> Playwright sub-path project starts one, because that deployment shape is where
> a wrong cookie `Path` or a stripped prefix shows up; everything else runs
> without it.

### Without Docker

```bash
pnpm install
pnpm dev
```

`IDP_CONFIG_DIR` points at the configuration folder (`/config` in the
container). `DATABASE_URL` and `IDP_SECRET` are the two things it cannot start
without — and `DATABASE_URL` has to be reachable from your host, so the shipped
`postgres://idp:idp@postgres:5432/idp` (a compose-network name) becomes
something like `postgres://idp:idp@localhost:5432/idp`.

Migrations apply at boot, and the Drizzle schema and SQL are committed and
drift-gated in CI, so there is nothing to generate before a first run. The two
generation commands exist for when you *change* the schema —
[Development](#development) has them.

> **`DATABASE_URL_ADMIN`** is required when `DATABASE_URL` points at a
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
The file is the source of truth for the clients it names: start-up validates it
and reconciles it into the database, disabling anything that has disappeared.
Those rows are read-only in the admin UI, because a change there is a change the
next restart would silently undo.

Clients can also be **registered from `/admin/clients`** (**D50**). They are
stored with the creating administrator as their owner, which is exactly the
marker reconciliation's sweep skips, so the two kinds coexist and neither
disturbs the other. A client registered that way works immediately, with no
restart. Dynamic client registration — the protocol endpoint — remains off.

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
[docker/Caddyfile.subpath](docker/Caddyfile.subpath) adds that route.

## Behind a reverse proxy

Caddy is **not part of the image**. It is an optional service in the compose
file, started by a profile, and two shapes ship as working Caddyfiles:

- **[docker/Caddyfile](docker/Caddyfile)** — the IdP owns a hostname. Automatic
  HTTPS, nothing else to think about.
- **[docker/Caddyfile.subpath](docker/Caddyfile.subpath)** — the IdP lives at
  `https://apps.example.com/idp` beside another application. Two rules matter
  and both fail quietly when wrong: proxy `{path}/*` **without stripping the
  prefix**, and route the origin-root RFC 8414 document back to the IdP.

Set `server.trustProxy` when there is a proxy in front, or every caller shares
one rate-limit bucket. `server.baseUrl` must also resolve **from inside the
deployment**: RP-initiated logout verifies an `id_token_hint` against the key
set fetched from that URL.

To run the reference proxy alongside:

```bash
cd docker
docker compose --env-file ../.env --profile caddy up -d --wait
```

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
cd docker
./idp-cli.sh config validate      # print the effective config, masked
./idp-cli.sh migrate
./idp-cli.sh reconcile-clients
./idp-cli.sh rotate-keys
./idp-cli.sh cleanup
./idp-cli.sh version
```

### If you get locked out

There is no `reset-admin` command and no bootstrap password to fall back on —
both went with the environment bootstrap they belonged to (**D52**). In
descending order of preference:

1. **Another administrator.** Give a second account an admin role before you
   need one; the last-admin invariant already refuses to leave you with none.
2. **The password-reset e-mail**, if a transport is configured. It reaches the
   address on the account and needs nobody else.
3. **One SQL statement**, as a last resort, documented in
   [docs/runbooks.md](docs/runbooks.md#promoting-a-user-when-nobody-can-sign-in):

   ```sql
   update idp."user" set role = 'admin' where email = 'you@example.com';
   ```

That is the accepted trade of removing the bootstrap account: the recovery
needs database access rather than a command, and in exchange no deployment ever
has a password sitting in an environment file that somebody meant to unset.

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
| Start-up hangs on migrations | Another instance holds the advisory lock, or `DATABASE_URL` is a pooler and `DATABASE_URL_ADMIN` is unset. |
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
pnpm drizzle:reset  # start over: drop the schema and everything in it
```

`pnpm drizzle:reset` is how you get back to a clean database (**D56**).
Migrations are forward-only and there is no seed step, so the reset is the
schema going away: it drops `database.schema` — read from the same
configuration the app loads, on `database.directUrl`, and never `public` or
anything else in the database — and the next `pnpm dev` or `pnpm docker:up`
migrates it back empty and serves the first-run setup page again. It prints the
target — configuration folder, masked connection string, schema, table count —
and asks `[y/N]` about that schema by name before it does anything, defaulting
to no; `--yes` skips the prompt, `--schema <name>` aims it somewhere else, and
`--migrate` leaves the schema rebuilt rather than absent. Stop the dev server or
the container first — a live connection holds the locks the drop needs, and the
script says so after ten seconds rather than hanging.

Integration tests run against a real Postgres, each file in its own uniquely
named schema. They read `IDP_TEST_DATABASE_URL`, else `DATABASE_URL_ADMIN`,
else `DATABASE_URL`.

End-to-end runs take each stack through the first-run setup wizard in a real
browser before any spec starts, with per-run throwaway credentials — there is no
administrator to configure and none to leave behind.

End-to-end tests drive the **built image** in a browser, at the host root and
behind Caddy under a sub-path, including a complete OIDC login through the
sample relying party in [`apps/web/e2e/sample-rp.ts`](apps/web/e2e/sample-rp.ts).

**Only when you change the schema** — a Better Auth upgrade, a new column —
regenerate and commit both the Drizzle schema and the migrations. They are
committed outputs, and CI compares them byte-for-byte, so a first run needs
neither:

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
