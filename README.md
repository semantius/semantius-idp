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

IDP_ADMIN_EMAIL=you@example.com      # ← this is your login
IDP_ADMIN_PASSWORD=…                 # ← and this; you change it at first sign-in
```

**These two are the only way in.** There is no default account and no built-in
password — whatever you put here is what you sign in with. See
[Signing in for the first time](#signing-in-for-the-first-time).

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

**There is no built-in account and no default password.** The first
administrator is whatever you put in these two variables before the first boot:

```bash
IDP_ADMIN_EMAIL=you@example.com
IDP_ADMIN_PASSWORD=whatever-you-choose-here
```

Those *are* your login. Open **`http://localhost:3000/`** — it redirects to
`/login` — and sign in with exactly those two values.

> **Already have a `.env` and don't know what is in it?**
> ```bash
> grep IDP_ADMIN .env
> ```
> Whatever it prints is the login. If the values are empty, no administrator was
> created and nobody can sign in — see "if you get locked out" below.

Then:

1. Sign in with `IDP_ADMIN_EMAIL` / `IDP_ADMIN_PASSWORD`.
2. You land on **`/change-password`** and cannot skip it: the bootstrap account
   is created with `mustChangePassword` set. Choose your real password here.
   **From this point the `.env` password no longer works.**
3. **Unset both variables.** They are only read when the database holds no
   administrator, so keeping them achieves nothing and leaves a password lying
   about in your environment.

### Where sign-in sends people

By default a completed sign-in lands on `/account`, which does not exist until
M7 — so set `auth.defaultRedirect` in `config/config.json` and it never comes
up. It takes either a path on this origin or an absolute URL on any origin:

```jsonc
"auth": { "defaultRedirect": "https://apps.example.com/" }
```

Set it to the product whenever the IdP is bundled beside one — at
`https://apps.example.com/idp` with the app on `/`, or on a different host
entirely — so people land in the product rather than on their profile page. An
OAuth authorization in progress and a validated `returnTo` both take
precedence over it, and `returnTo` is still refused unless it is a same-origin
relative path.

### If you get locked out

**`idp reset-admin` is the answer**, in development and in production alike:

```bash
pnpm reset-admin                       # from a checkout
docker compose exec idp idp reset-admin   # against a running container
```

It puts the password back to `admin.bootstrap.password` (`IDP_ADMIN_PASSWORD`),
re-arms the forced change so that value survives exactly one sign-in, makes the
account reachable again if it was banned or un-approved, and ends every existing
session. Nothing is destroyed: the user row, its id and its audit history all
survive.

Two things it will not do, both on purpose:

- **It never grants an admin role.** An address that exists and holds none is
  refused — otherwise a command with database access would be a one-line
  privilege escalation for anyone who can read the config folder.
- **It never creates an address you typed.** With no argument it will create
  `admin.bootstrap.email` on a database that has no administrator, which is the
  bootstrap contract. But `idp reset-admin adnim@example.com` fails rather than
  quietly provisioning a second administrator from a typo.

Some background on why the situation arises at all:

- The bootstrap step runs **only when no user holds an admin role**, so changing
  `IDP_ADMIN_PASSWORD` after an administrator exists does **nothing** — the step
  is skipped and the log says `bootstrap admin skipped: an admin already exists`.
- The forced first change **consumes** the `.env` password: after it, the only
  copy of the working password is in the operator's head. That is the whole
  reason this section exists.
- Dropping the schema (`psql "$DIRECT_DATABASE_URL" -c 'drop schema idp
  cascade'`) still works and still destroys every user, session, token and
  signing key in the deployment. It is no longer the documented recovery, and
  there is no longer a reason to reach for it.

### How it is wired

`admin.bootstrap` in `config.json` reads the two variables through placeholders,
which is why the config file itself contains no password:

```jsonc
"admin": {
  "bootstrap": {
    "email": "${env:IDP_ADMIN_EMAIL:-}",
    "password": "${env:IDP_ADMIN_PASSWORD:-}",
    "name": "Bootstrap Admin"
  }
}
```

Things worth knowing about that account:

- It is created **only if no user already holds an admin role**, under an
  advisory lock — so restarting the container never creates a second one.
- It is active and e-mail-verified immediately; it does not go through the
  approval queue.
- If the address already exists as a non-admin, startup **fails** rather than
  silently promoting them.
- Leaving the variables empty skips the step with a loud warning. Nobody can
  sign in until an administrator exists, so this is the one warning worth
  reading — set the two variables and run `idp reset-admin`.
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
