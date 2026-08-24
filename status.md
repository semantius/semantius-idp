# semantius-idp — where the plan stands

**As of:** 2026-08-24 · **Branch:** `feat/idp-v1` · **Base:** `main` · **Head:** `0268b73`
**Plan:** `~/.claude/plans/generate-a-plan-to-lovely-teacup.md` · **Spec:** [spec-v1.md](spec-v1.md)

Working tree clean. Every gate green: lint, typecheck, unit, integration,
schema-drift, config-schema staleness, dependency pinning.

---

## Done (M0 spikes, M1–M5)

**M1.0 — spec amended** for D24–D26: social profile-sync collision now blocks
sign-in, no social/sign-up warning, and M2M removed throughout (FR-OIDC-1/3/7,
CFG-4/5, SEC-6, TST-4, DOC-3, §12, §15 ticked).

**M0 spikes** — three findings changed the design, all recorded in
[docs/spikes/](docs/spikes/):

- **The 1.7.x plugins moved.** `oauth-provider` and `api-key` are now separate
  packages, and `@better-auth/cli` is stuck at 1.4.21 bundling its *own*
  better-auth. Using it would have generated core tables from the wrong version
  — exactly the drift DM-1's gate exists to catch. The schema is generated from
  the installed `getAuthTables()` instead.
- **`search_path` is not a usable mechanism** — Neon's pooler silently drops it.
  Schema placement relies on qualified table names, which work regardless of
  pooling.
- **Session advisory locks do not hold through the pooler** but do through the
  direct endpoint. This forced a new config key, `database.directUrl` (recorded
  as D27), used by every locked step. Without it two containers starting
  together would each believe they held the migration lock.
- R1 (default audience) and R4 (secret hashing) both turned out to have
  supported seams — no `pnpm patch` needed. R2 confirmed:
  `enforcePerClientResources` defaults on.

**M1–M5** — toolchain pinned with a CI gate against floating ranges; the full
CFG-1..6 config system; database, migrations and the Better Auth instance; the
OPS-2 startup sequence; audit trail, e-mail and i18n; and the public auth UI
with the approval endpoints. **157 unit + 54 integration tests**, the latter
against the real Neon database.

Two things I'd flag: **`database.schema` was briefly hard-coded** and you caught
it — it's now a runtime value end to end, with the migrator retargeting the
schema identifier in the committed SQL. And **`buildRuntime` had to become
async**, because the OAuth provider queries `oauth_resource` from its own
`init()`; on a fresh database the process died before it could migrate.

## Not done (M6–M14)

Social + 2FA, account self-service + API keys, **OIDC core (M8 — the largest)**,
authorize UX, admin UI, security hardening, Docker/compose/CLI, e2e, and docs.
Spike S3 (sub-path) is also outstanding, though `base-path.ts` and the config
already carry it and the e-mail templates are tested under a sub-path issuer.

One deviation worth your call: `drizzle.config.ts` sits in `apps/web/` rather
than the repo root, because drizzle-kit resolves every path relative to itself
and both the schema and migrations live there.

---

## What responds today

| | |
|---|---|
| `/` → `/login` | ✅ 307 |
| `/login` | ✅ 200 |
| `/healthz` `/readyz` | ✅ 200 |
| `/api/auth/jwks` | ✅ 200 (real ES256 key) |
| `/.well-known/openid-configuration` | ❌ 404 — **M8** |
| `/oauth2/authorize` `/oauth2/token` | ❌ 404 — **M8** |
| `/account/*` | ❌ 404 — **M7** |
| `/admin/*` | ❌ 404 — **M10** |

Plus `/signup`, `/forgot-password`, `/reset-password`, `/verify-email`,
`/pending-approval`, `/banned`, `/change-password`, `/logout` — though `/signup`
and `/forgot-password` deliberately 404 under the default config, since sign-up
is off and no Resend key is set.

So: what works end to end today is password sign-in, sign-up with approval,
verification and reset, the startup sequence and the bootstrap admin.
**What does not work is OIDC** — no discovery, no authorize, no token endpoint.
That's M8, the largest remaining milestone, and nothing in it has been started.

---

## Milestone table

| # | Milestone | Status |
|---|---|---|
| M1.0 | Amend spec for D24–D26 | ✅ done |
| M0 | Spikes S1, S2, S4, S5 | ✅ done · S3 (sub-path) **outstanding** |
| M1 | Toolchain baseline | ✅ done |
| M2 | Configuration system | ✅ done |
| M3 | DB, Better Auth skeleton, migrations | ✅ done |
| M4 | Startup, bootstrap admin, audit, e-mail, i18n | ✅ done |
| M5 | Password auth, sign-up & approval | ✅ done |
| M6 | Social + 2FA | ⬜ not started |
| M7 | Account self-service + API keys | ⬜ not started |
| M8 | **OIDC core** (largest remaining) | ⬜ not started |
| M9 | Authorize UX: continuation, consent, end-session | ⬜ not started |
| M10 | Admin UI + API | ⬜ not started |
| M11 | Security hardening | ⬜ partial — see below |
| M12 | Container, compose, Caddy, CLI, ops | ⬜ not started |
| M13 | E2E, sample RP, a11y | ⬜ not started |
| M14 | Docs & release — **including the README (DOC-1)** | ⬜ not started |

`README.md` is **DOC-1, in M14**. It currently carries a minimal
getting-started and first-sign-in section; the full DOC-1 README — features,
architecture, generated configuration reference, provider setup, runbooks,
troubleshooting — is still to come.

---

## Commits

```
0268b73 fix: replace the starter page at / with a redirect to /login
17de4f9 docs: add status.md with where the plan stands
ae7851a feat(m5): public auth UI and the approval endpoints
922b9c2 feat(m4): i18n catalog, e-mail transport and the nine templates
e56d021 feat(m4): startup sequence, bootstrap admin, audit trail, health endpoints
d90ddb3 feat(m3): database layer, Better Auth instance, migrations, approval gate
7115db8 feat(m1,m2): toolchain baseline, config system, first spike findings
43f019c docs(spec): add spec-v0/v1 and amend v1 for owner decisions D24-D26
```

---

## The spike findings in detail

Notes are in [docs/spikes/](docs/spikes/); S4 is re-runnable with
`pnpm --filter web exec bun run scripts/spike-s4-schema-placement.ts`.

### The 1.7.x plugins moved, and the CLI is stranded (S5)

`oauth-provider` and `api-key` are **separate packages** in 1.7.x
(`@better-auth/oauth-provider@1.7.1`, `@better-auth/api-key@1.7.1`), and
`@better-auth/cli` is stuck at **1.4.21** with `better-auth@1.4.21` as a *hard*
dependency. Running `@better-auth/cli generate` would derive the core tables
from 1.4 while our plugins are 1.7.

**Resolution:** the Drizzle schema is generated from the *installed*
`getAuthTables()` by `apps/web/scripts/generate-auth-schema.ts`, which owns its
own formatting so the CI drift gate can compare byte-for-byte. DM-1's intent —
one authoritative schema derived from the enabled plugins, CI fails on drift —
is preserved; only the tool changed.

### `search_path` is not a usable mechanism (S4, risk R8)

The original R8 plan was "postgres driver `search_path` + drizzle-kit
`migrations.schema`". Against Neon's pooled endpoint the startup parameter is
**silently dropped** — nothing warns, the connection just comes up with the
default path. Anything relying on it would have quietly written to `public`.

**Resolution:** every table Drizzle emits is schema-qualified, so placement does
not depend on connection state. R8's post-processing fallback is not needed.

### Session advisory locks do not hold through a pooler (S4 → **decision D27**)

With the lock held on one reserved connection, `pg_try_advisory_lock` on a
second connection through the **pooled** endpoint *succeeds*. Through the
**direct** endpoint it behaves correctly. Every mutating startup step depends on
this — migrations, first-boot key generation, reconciliation, bootstrap admin,
cleanup.

**Resolution:** new config key **`database.directUrl`** (spec amended, D27
recorded, §13 R8 closed). Every locked step opens its connection with
`createDb(config, { direct: true })`; request traffic keeps the pooled URL.
Startup warns when the URL looks pooled and `directUrl` is unset.

### Risks that resolved better than expected

| Risk | Outcome |
|---|---|
| **R1** default audience | Real — no `resource` parameter yields an *opaque* token, not a JWT. Fixed by a `hooks.before` injection; **the pre-authorized `pnpm patch` is not needed**. One wrinkle recorded for M8: with `openid` in scope the provider adds its own userinfo endpoint as a second `aud`, to be normalised in the `jwt.sign` seam. |
| **R2** per-client resources | Confirmed: `enforcePerClientResources` defaults to `true`. Kept on; reconcile owns the links. |
| **R4** client-secret hashing | Resolved outright — `storeClientSecret` accepts our own `hash`/`verify` pair, so reconcile and the token endpoint use the same function object. |
| **R5** session JWT | Better than expected — `jwt.sign` is a full payload seam that *every* signed token routes through, so one claims builder covers all three FR-OIDC-7 paths. |

---

## What exists in the tree

**Configuration (CFG-1..6)** — `apps/web/src/server/config/`
JSONC with `$schema` exemption · full D18 placeholder grammar · zod schemas for
all three files covering the whole CFG-4 inventory · every CFG-5 cross-check
including production-literal-secret detection and the Entra tenant lock ·
masking · CFG-3 precedence · JSON Schema export with a staleness gate · a
committed `config.example/` the tests load.

A security hole was found and closed while writing the tests: a secret supplied
through a placeholder's inline default (`${env:UNSET:-hunter2}`) is literal text
in the file, so it no longer satisfies the production rule.

**Database (DM-1..5)** — `apps/web/src/server/db/`
17 tables + the drizzle journal, all schema-qualified, nothing in `public` ·
runtime-resolved schema name · own migrator (drizzle's cannot retarget a schema)
keeping drizzle's table name, hash scheme and per-migration transaction ·
namespaced advisory locks on a dedicated reserved connection.

**Auth instance** — `apps/web/src/server/auth/`
All six plugins wired with every option traced to a requirement · account
linking fully disabled (FR-SOC-2) · `additionalFields` per DM-3/FR-AUTH-7 ·
telemetry off (SEC-8) · oauth-provider restricted to the two v1 grants (D26),
client CRUD denied, resources seeded · `databaseHooks` as the single enforcement
point for the approval gate, domain restriction and status assignment · a
before-hook normalising e-mail ahead of validation.

**Startup (OPS-2)** — `apps/web/src/server/startup.ts`
migrate → signing key → reconcile *(M8)* → validate roles → bootstrap admin,
every mutating step under an advisory lock on the direct connection, failures
surfacing as one actionable `StartupError`. FR-ADMIN-1's "two boots create
exactly one admin" holds.

**Public UI (FR-ACCT-2)** — `apps/web/src/routes/`
Server-rendered plain forms, so the login page works before hydration and
without JavaScript. Posts forward the original headers (so the CSRF origin check
applies), answer 303, and carry failures as an error **code** — wording comes
from the catalog, user input never reaches a URL, and wrong-password and
unknown-address collapse to one code (SEC-7).

**Also in place:** structured logger with SEC-5 redaction · SEC-6 audit trail ·
Resend and capture transports with all nine templates · typed en-US catalog with
FR-I18N-1 locale resolution · `/healthz` and `/readyz` · approve/reject
endpoints gated on `admin.adminRoles` · CI with lint, typecheck, unit,
dependency-pinning, schema-drift and config-schema gates, plus a nightly audit.

---

## What is left, in detail

**M6 — Social + 2FA.** The config-driven provider map exists
(`auth/options/social.ts`), including `given_name`/`family_name` mapping and
`disableImplicitSignUp`. Still needed: the e-mail-collision refusal at sign-in
**and** at sync (D24) with the `social.profile_conflict` audit event, the
two-factor challenge route, and the TST-7 mock OIDC provider fixture.

**M7 — Account self-service + API keys.** `/account/*` entirely, api-key plugin
behaviour per `apiKeys.*`, and the 15-minute fresh-session middleware.

**M8 — OIDC core.** Client reconciliation (transactional diff under lock, secret
re-hash, resource links, audit diff) · the R1 `hooks.before` audience injection ·
the `jwt.sign` claims-builder seam including the `aud` normalisation above ·
grants, TTLs, rotation and reuse detection · discovery, JWKS, CORS and the
`/oauth2/*` + `/.well-known/*` routes at the issuer root. The seams exist:
`oidc/base-path.ts`, `PROTOCOL_ROUTES`, the resource registry in `derive.ts`,
and the startup step placeholder.

**M9–M14.** Authorize UX and consent · admin UI and API · security hardening ·
container, compose, Caddy and the operator CLI · e2e, sample RP and a11y · docs
and release.

**Spike S3 — sub-path.** `base-path.ts` and the config model it, and the e-mail
templates are tested under a sub-path issuer, but Vite's `base` and the router
`basepath` have not been exercised end to end.

**M11 partial.** Already in place: SEC-1 (every URL from `baseUrl`), SEC-3
(`returnTo` validation, forwarded origin checks), SEC-5 (redaction), SEC-6
(audit), SEC-7 (uniform responses), SEC-9 (pinning gate), SEC-10. Still to do:
the SEC-4 headers/CSP middleware, the SEC-2 rate-limit rules and `trustProxy` IP
utility, and the full TST-5 adversarial suite.

---

## Deviations from the plan

| Deviation | Why |
|---|---|
| Schema generated by `scripts/generate-auth-schema.ts`, not `@better-auth/cli generate` | The CLI is version-stranded at 1.4.21 (S5). DM-1's intent is preserved. |
| Own migrator instead of `drizzle-orm`'s | Drizzle's applies the file verbatim and cannot retarget `database.schema`, which is a runtime setting. |
| `drizzle.config.ts` in `apps/web/`, not the repo root | drizzle-kit resolves every path relative to the config file, and both the schema and the migrations live there. |
| New config key `database.directUrl` | Forced by the S4 pooler finding; recorded as D27 and amended into CFG-4. |
