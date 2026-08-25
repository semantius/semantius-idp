# Contributing

## Getting set up

```bash
pnpm install
cp -r config.example config
cp .env.example .env          # fill in DATABASE_URL and IDP_SECRET at least
pnpm --filter web run db:generate-schema
pnpm --filter web run db:generate
pnpm dev
```

You need **Bun** (the runtime — pinned in `.bun-version`), **pnpm** (the
package manager; Node is only used by tooling) and a **Postgres**. Everything
lives in one schema, so an existing database is fine.

## The gates

These are what CI runs, and they are worth running before pushing rather than
after:

```bash
pnpm lint
pnpm typecheck
pnpm test                                   # unit
pnpm --filter web run test:integration      # needs a real Postgres
pnpm --filter web run test:e2e              # needs Docker; drives the built image
bun run scripts/check-pinned-deps.ts
pnpm --filter web run config:schemas -- --check
pnpm --filter web run docs:config -- --check
pnpm --filter web run db:generate-schema -- --check
pnpm --filter web run build && bun run scripts/check-client-bundle.ts
bun run scripts/smoke-test.ts --build       # the container smoke test
```

All of them are required for merge.

### Dependencies are pinned exactly

No `^`, no `~`, no ranges, no `latest`. `check-pinned-deps.ts` refuses them
across the workspace. An upgrade is a deliberate, reviewed change with a
changelog entry — not something that happens because someone re-ran
`pnpm install` on a Tuesday.

### The database schema is generated

The Drizzle schema comes from the **installed** Better Auth's own table
definitions, so it cannot describe a shape the running code does not expect:

```bash
pnpm --filter web run db:generate-schema   # regenerate from Better Auth
pnpm --filter web run db:generate          # SQL migrations from the schema
```

Commit both. CI fails on any drift between the committed schema and a fresh
generator run.

Migrations are **forward-only**. Write one that can be applied to a database
somebody is using.

### The configuration reference is generated

`docs/configuration.md` comes from the zod schemas. Change a default or add a
key and:

```bash
pnpm --filter web run docs:config
pnpm --filter web run config:schemas
```

Give every new key a `.describe()` — it is what appears in the reference and in
editor completion, and a key nobody can explain is a key nobody should add.

### The server must not reach the browser

A route `loader` runs on the client as well as the server, so one careless
import puts Better Auth, Drizzle and the `postgres` driver in the browser
bundle. `check-client-bundle.ts` catches it. Reads go through a server function
in `src/server/functions/`; mutations go through a route's own
`server.handlers`, where the freshness gate and the audit trail live.

## Testing

Four layers, each answering a question the others cannot:

| Layer | Where | Answers |
| --- | --- | --- |
| unit | `src/tests/unit/` | Does this function decide correctly? |
| integration | `src/tests/integration/` | Against a real Postgres, does the flow work? |
| e2e | `e2e/` | In a browser, against the built image, in both deployment shapes — does a person get through? |
| smoke | `scripts/smoke-test.ts` | Does the artefact we publish start, serve, and stop? |

Integration tests each get their own uniquely named schema, which is cheap
because every table is schema-scoped. They read `IDP_TEST_DATABASE_URL`, else
`DIRECT_DATABASE_URL`, else `DATABASE_URL`.

End-to-end tests bring up their own compose stacks with generated configuration
folders, so a run can never touch your own stack or the persistent `idp`
schema.

**Coverage thresholds** are 85 % for the configuration, claims, OIDC and
approval modules and 70 % overall, measured across unit *and* integration
together — the database layer and the auth hooks are exercised by integration
tests by design.

### What a good test looks like here

It asserts the behaviour a requirement names, and its comment says which
defect it exists for. The suite is full of assertions that look arbitrary until
you read the sentence above them — that sentence is the point. A test whose
failure message does not tell you what broke is half a test.

## Style

- **Comments explain why, not what.** The code says what it does. The comment
  says why it is that way, what was tried instead, and what breaks if it
  changes. Most of the comments in this repository exist because something went
  wrong once.
- **Prettier decides formatting** (`pnpm format`); do not argue with it.
- **Requirement ids in comments** — `FR-OIDC-9`, `SEC-4`, `D46` — tie code to
  [spec-v1.md](spec-v1.md). Use them when a line exists because the spec says
  so.
- **British spelling** in prose. American in identifiers where an API uses it.

## Changing behaviour the spec describes

[spec-v1.md](spec-v1.md) is signed off. A change to a numbered requirement is a
**spec amendment**: add a row to the decision log in §12 with a `D` number, say
what was considered and rejected, and update the requirement text. The
amendment rides the same commit as the change.

This is not ceremony. Nearly every "why is it like this?" in a codebase this
size is answered by a decision nobody wrote down.

## Commits and pull requests

- One coherent change per commit, with a message that says what changed and
  **why**. The body is the place for the reasoning, and it is worth writing.
- Rebase rather than merge.
- A pull request should describe what it changes, what it deliberately does
  not, and how it was verified.

## Releases

Semantic versioning. Tagging `vX.Y.Z` builds and publishes the image for amd64
and arm64 with the full OCI tag set; a merge to `main` builds and smokes the
image but publishes nothing. Update [CHANGELOG.md](CHANGELOG.md) in the release
commit.
