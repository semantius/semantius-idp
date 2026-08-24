# semantius-idp

A lightweight, self-hosted identity provider: user management, authentication
and standard JWT access tokens that resource servers validate via JWKS —
Neon and Supabase-style PostgREST included.

One container plus Postgres. Configured by files and environment variables, not
by clicking around a database.

> **Status: in development.** Password sign-in, sign-up with approval,
> verification and reset work end to end. **OIDC does not exist yet** — there is
> no discovery document, no `/oauth2/authorize` and no token endpoint. See
> [status.md](status.md) for what responds today and what is left.
>
> This README is the minimum needed to boot the thing and sign in. The full
> documentation — features, architecture, generated configuration reference,
> social-provider setup, runbooks, troubleshooting — is DOC-1, in milestone M14.

## Requirements

- **Bun** (pinned in [.bun-version](.bun-version)) — the runtime
- **pnpm** — the package manager; Node is only used by tooling
- **Postgres ≥ 16** — everything lives in its own schema (`idp` by default), so
  an existing database is fine

## First run

### 1. Configuration folder

Three files, all read once at startup. Copy the commented examples:

```bash
cp -r config.example config
```

`config/config.json` is required. `oauth_clients.json` and `roles.json` are
optional — without them you get no OAuth clients and the built-in
`admin` + `user` role catalog.

Point the process at the folder with `IDP_CONFIG_DIR` (the container defaults
to `/config`).

### 2. Environment

Secrets never live in the config files — they arrive through `${env:NAME}` and
`${file:/run/secrets/…}` placeholders. Copy [.env.example](.env.example) to
`.env` and fill in:

```bash
DATABASE_URL=postgres://…            # required
DIRECT_DATABASE_URL=postgres://…     # required only if DATABASE_URL is pooled
IDP_SECRET=…                         # required, ≥ 32 random bytes
IDP_CONFIG_DIR=./config

IDP_ADMIN_EMAIL=you@example.com      # the first administrator
IDP_ADMIN_PASSWORD=…                 # temporary; you change it at first sign-in
```

Generate the secret with:

```bash
openssl rand -base64 48
```

> **`DIRECT_DATABASE_URL`** is required when `DATABASE_URL` points at a
> transaction-mode connection pooler — Neon's `-pooler` endpoint, PgBouncer.
> Session advisory locks do not hold through one (verified), and startup,
> migrations and the operator CLI all rely on them. For Neon it is the same URL
> with `-pooler` removed. Startup warns if it looks pooled and this is unset.

### 3. Start it

```bash
pnpm install
pnpm --filter web run db:generate-schema   # Drizzle schema from Better Auth
pnpm --filter web run db:generate          # SQL migrations
pnpm dev
```

The startup sequence runs on the first request: migrate → generate the signing
key → validate roles → create the bootstrap administrator. Watch for it in the
log, and check readiness with:

```bash
curl localhost:3000/readyz
# {"status":"ready","checks":{"config":true,"database":true,"migrations":true,"signingKey":true}}
```

## Signing in for the first time

The **bootstrap administrator** is created from `admin.bootstrap` in
`config.json`, whose values come from `IDP_ADMIN_EMAIL` and
`IDP_ADMIN_PASSWORD`:

```jsonc
"admin": {
  "bootstrap": {
    "email": "${env:IDP_ADMIN_EMAIL:-}",
    "password": "${env:IDP_ADMIN_PASSWORD:-}",
    "name": "Bootstrap Admin"
  }
}
```

Then:

1. Open **`http://localhost:3000/`** — it redirects to `/login`.
2. Sign in with `IDP_ADMIN_EMAIL` and `IDP_ADMIN_PASSWORD`.
3. You are sent straight to **`/change-password`**, which you cannot skip: the
   bootstrap account is created with `mustChangePassword` set. Choose your own
   password.
4. **Unset `IDP_ADMIN_EMAIL` and `IDP_ADMIN_PASSWORD`.** They are only read when
   the database holds no administrator, so leaving them set achieves nothing and
   keeps a password in your environment.

Things worth knowing about that account:

- It is created **only if no user already holds an admin role**, under an
  advisory lock — so restarting the container never creates a second one.
- It is active and e-mail-verified immediately; it does not go through the
  approval queue.
- If the address already exists as a non-admin, startup **fails** rather than
  silently promoting them.
- Leaving the variables empty skips the step with a loud warning. Nobody can
  sign in until an administrator exists, so this is the one warning worth
  reading. (`idp create-admin` is the alternative and arrives with the operator
  CLI in M12.)
- The password is never written to a log.

## Configuration in brief

The full reference is generated from the schemas in M14; until then,
`config.example/config.json` is commented throughout and
`config.example/*.schema.json` give editor completion through the `$schema` key.

The keys that decide what you can do on day one:

| Key | Default | What it changes |
|---|---|---|
| `server.baseUrl` | — **required** | The issuer. Every absolute URL derives from it — never from the `Host` header. May carry a path (`https://apps.example.com/idp`). |
| `signUp.enabled` | `false` | Off means `/signup` returns **404** and social sign-in works only for identities that already exist. |
| `signUp.requireApproval` | `true` | New self-registrations land as `pending` and cannot sign in until an administrator approves them. |
| `email.resend.apiKey` | — | Without it the IdP runs in **degraded mode**: no verification, no password reset, no notifications, and `/forgot-password` returns 404. Administrators set passwords directly instead. |
| `database.schema` | `idp` | Every table, including the migration bookkeeping, lives here. Nothing is created in `public`. |
| `admin.adminRoles` | `["admin"]` | Which roles from `roles.json` reach the admin area and the admin API. |

If a page you expect is missing, it is almost always one of these: sign-up is
off, or e-mail is not configured. That is deliberate — a control that cannot
work is not shown.

## Health

| Endpoint | Meaning |
|---|---|
| `GET /healthz` | The process is up. Touches nothing else, so a database blip is not a restart signal. |
| `GET /readyz` | Config loaded, database reachable, migrations current, signing key present. `503` until startup finishes. |

## Development

```bash
pnpm dev            # dev server
pnpm test           # unit tests
pnpm typecheck
pnpm lint
pnpm --filter web exec vitest run --project integration   # needs a real Postgres
```

Integration tests run against a real Postgres — each file in its own uniquely
named schema, which is cheap because every table is schema-scoped. They use
`IDP_TEST_DATABASE_URL`, else `DIRECT_DATABASE_URL`, else `DATABASE_URL`.

After changing the auth configuration or upgrading Better Auth, regenerate and
commit both the schema and the migrations:

```bash
pnpm --filter web run db:generate-schema
pnpm --filter web run db:generate
```

CI fails if the committed schema no longer matches the installed Better Auth.

## Licence

[MIT](LICENSE).
