# S4 — Schema placement and pooler behaviour (risk R8)

**Status:** done, all checks green · **Date:** 2026-08-23
**Reproduce:** `pnpm --filter web exec bun run scripts/spike-s4-schema-placement.ts`
**Run against:** the dev Neon project in the repo-root `.env`, PostgreSQL 18.6, through both the pooled and the direct endpoint.

## What the spike had to prove

| Exit criterion (plan §M0) | Verdict |
|---|---|
| Fresh DB → migrate → everything in the configured schema, `public` empty | **PASS** — 18 tables (17 + the migration journal) in the configured schema, `public` unchanged, for both the default name and a different one |
| Regenerating the schema produces no diff | **PASS** — `generate-auth-schema.ts --check` is a CI gate |
| `search_path` behaves through the Neon pooler | **NO** — silently dropped; see below |
| Advisory locks behave through the Neon pooler | **NO** — they do not hold; see below |
| `channel_binding=require` works | **PASS** — the dev URL carries it and `postgres` connects |

## Finding 1 — `search_path` is not a usable mechanism

The original R8 plan was "postgres driver `search_path` + drizzle-kit
`migrations.schema`". Against the pooled endpoint:

```
· search_path from the connection options:
  NOTE dropped by the endpoint ("$user", public)
```

A transaction-mode pooler only forwards a small allow-list of startup
parameters, and `search_path` is not on it. Nothing warns; the connection simply
comes up with the default path. Anything relying on it would have silently
written to `public`.

**Resolution:** don't rely on it. Every table Drizzle emits is
schema-qualified, so placement does not depend on connection state at all. The
`search_path` is still set, as a convenience for psql sessions and hand-written
SQL, and is documented as best-effort.

## Finding 2 — `database.schema` must be, and now is, a runtime value

Drizzle needs the schema name when a table is *defined*, which pushes toward
baking it in at generation time. That would have quietly turned a documented
CFG-4 setting into a build-time constant.

**Resolution, two halves:**

1. The generated schema exports a **factory**:
   `createAuthSchema(schemaName)` builds every table inside
   `pgSchema(schemaName)`. `createDb()` calls it once with
   `database.schema`, and the handle carries the bound tables. A canonical
   instance is also exported so drizzle-kit has something static to diff.
2. The committed SQL names its schema literally, so the **migrator retargets
   it**: `retargetSchema()` rewrites `"idp".` and `SCHEMA "idp"` to the
   configured name, and makes `CREATE SCHEMA` idempotent. Only quoted
   identifiers in a schema position are touched, so a comment or a value
   containing the word cannot be caught by accident.

This is why the IdP does not use `drizzle-orm`'s own migrator: it applies the
file verbatim and has no way to retarget. Ours keeps drizzle's
`__drizzle_migrations` table name, hash scheme and per-migration transaction, so
drizzle-kit still understands a database it has migrated.

Verified in both directions: migrating into `idp_spike_default` and into
`idp_spike_renamed` each produced 18 tables in that schema, with an insert
through Drizzle landing there and a re-run changing nothing.

## Finding 3 — session advisory locks do **not** hold through the pooler

This is the one the spike existed for.

```
· pooled endpoint: a session advisory lock excludes a second holder
  NOTE the lock does NOT hold here
✓ direct endpoint (database.directUrl): a session advisory lock excludes a second holder
  PASS (second attempt refused)
```

With the lock held on one reserved connection, a `pg_try_advisory_lock` on a
second connection through the pooled endpoint **succeeds**. Transaction pooling
means "the session" is not a stable thing, so a session-scoped lock cannot mean
what OPS-2 needs it to mean. Through the direct endpoint the same probe behaves
exactly as expected.

Every mutating startup step depends on this: migrations, first-boot key
generation, client reconciliation, the bootstrap admin, the cleanup job. Two
containers starting together against a pooled URL would each believe they held
the lock.

**Resolution (decision D27, spec amended):** a new `database.directUrl` key.
Every locked step opens its connection with `createDb(config, { direct: true })`,
which prefers `directUrl`. Ordinary request traffic keeps using the pooled URL,
which is what a pooler is good at. Startup warns when `database.url` looks
pooled (`-pooler.` host, `pgbouncer=true`) and `directUrl` is unset — the check
is a heuristic, so it warns rather than failing.

For Neon the direct endpoint is the same URL with the `-pooler` suffix removed.

## Consequences recorded elsewhere

- `CFG-4` gains `database.directUrl`; `database.schema` is documented as
  runtime-resolved.
- `§13 R8` is closed with the mechanism that actually works.
- The integration harness can give each test file its own schema, since the
  schema name is a runtime value — which is what makes per-file isolation cheap
  on a shared hosted database.
