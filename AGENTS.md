# AGENTS.md

The contract for any agent working in this repository. `CLAUDE.md` is a symlink
to this file, because tools disagree about the name and the knowledge should not
be duplicated to satisfy them.

**Everything an agent must remember lives here, in the repository.** Not in a
per-user memory store outside it — that is invisible to review, invisible to
every other agent and to every human, and it is lost with the machine. If you
learn something durable about this project, add it to this file in the same
change that taught it to you.

---

## Start here

Four files, in this order. Read them before proposing anything.

| File | What it is |
| --- | --- |
| [status.md](status.md) | The handoff. Done, not-done, and why — the ground truth between sessions. |
| [spec-v1.md](spec-v1.md) | Signed off, amended through **D52**. Numbered requirements, and §12.1's decision log with the reasoning. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | The gates, the style, and how to amend the spec. |
| [docs/release.md](docs/release.md) | What is left before v1.0.0, and it is the owner's, not yours. |

**Trust status.md's content; verify its header.** The `As of` / `Head` /
`Spec amended through` line has gone stale more than once. Check it against
`git log -1` and the last `D` number in spec §12.1.

---

## How to work here

### Act on defensible defaults; record them. Do not ask.

When a question has a defensible answer, take it and write the decision down —
a `D` number in spec §12.1, an entry in [CHANGELOG.md](CHANGELOG.md), a section
in status.md. Do not stop and ask.

Classify before asking:

- **destructive, irreversible, or a spec change with no defensible default** →
  ask;
- **has a defensible default** → pick it, record it, proceed;
- **already answered** by the spec, status.md or the decision log → cite it and
  move on.

Commit `927322a` is literally titled *"record D31, and act on the two questions
instead of asking them"*. That is the standing preference.

### A spec amendment rides the commit that makes it true

A change to a numbered requirement means: a row in spec §12.1 with a new `D`
number saying what was considered and rejected, the requirement text updated,
and a CHANGELOG entry — all in the same commit as the code. Amendments that
lag have happened here and cost a whole session to reconstruct (see status.md,
"The spec debt, paid").

### Comments explain why, not what

The code says what it does. The comment says why it is that way, what was tried
instead, and what breaks if it changes. Most comments in this repository exist
because something went wrong once; keep writing them that way.

---

## Never do this

### Never touch persistent credentials or the persistent `idp` schema

Live verification runs on **throwaway schemas**. `database.schema` is a runtime
value, so this is cheap:

```bash
IDP_SCHEMA_NAME=idp_check_something …   # then drop the schema afterwards
```

Against the persistent `idp` schema, verify only up to a screen that would
change state, and never submit it. On 2026-08-24 a forced password change was
submitted from an embedded browser with the new value recorded nowhere; the
documented login stopped working and the account deadlocked. That is the whole
reason `P0'.2` exists.

If a credential change is ever unavoidable, record the new value where the owner
will find it — `.env`, status.md — **in the same action**, not afterwards.

### Never hand-patch a generated file

Fix the generator or the rule; the file is an output. These are all generated,
and all gated in CI:

| Generated | By | Gate |
| --- | --- | --- |
| `apps/web/src/server/db/schema/auth-schema.ts`, `apps/web/drizzle/**` | `db:generate-schema`, `db:generate` | drift gate, byte-for-byte |
| `config.example/*.schema.json` | `config:schemas` | `--check` |
| `docs/configuration.md` | `docs:config` | `--check` |
| `apps/web/src/routeTree.gen.ts` | the TanStack router plugin | rebuilt on build |
| `packages/ui/src/components/*.tsx` | the shadcn registry | see below |

Patching one of these is undone by the next generator run, and the person who
re-runs it will not know why it broke.

---

## The gates

All of these must be green. CI runs them; run them before you claim anything.

```bash
pnpm lint
pnpm typecheck
pnpm test                                   # unit
pnpm --filter web run test:integration      # needs a real Postgres
pnpm --filter web run test:coverage         # thresholds, both projects
pnpm --filter web run test:e2e              # needs Docker; drives the built image
bun run scripts/check-pinned-deps.ts
pnpm --filter web run config:schemas -- --check
pnpm --filter web run docs:config -- --check
pnpm --filter web run db:generate-schema -- --check
pnpm --filter web run build && bun run scripts/check-client-bundle.ts
pnpm docker:smoke                           # TST-8, builds the image
```

Dependencies are **pinned exactly** — no `^`, no `~`, no `latest`. Tools that
add a floating range (the shadcn CLI adds `shadcn: ^4.19.0`) fail
`check-pinned-deps.ts`, which is the point.

---

## Things that will bite you

**The e2e suite drives the *built image*, not the source.** Change anything that
ends up in the image — CSS, components, server code — and rebuild before
`test:e2e`, or you are testing the previous build. `pnpm docker:smoke` rebuilds
and tags `semantius-idp:local`, which is what the suite defaults to.

**The server must not reach the browser.** A route `loader` is isomorphic — it
runs in the browser on every client-side navigation — so one careless import
puts Better Auth, Drizzle and the `postgres` driver in the client bundle.
`check-client-bundle.ts` catches it. Reads go through a server function in
`apps/web/src/server/functions/`; mutations go through a route's own
`server.handlers`, where the freshness gate and the audit trail live.

**An advisory lock needs at least two connections when the locked body queries
the same handle.** `withAdvisoryLock` reserves one connection for the whole
critical section; a query inside it on the same handle then waits for a
connection the lock is holding. `createDb(config, { direct: true, max: 2 })` —
`max: 1` deadlocks against itself and reads as a timeout.

**Docker lives in [`docker/`](docker/) and is run from there.** Compose resolves
relative paths against the compose file's directory and its interpolation `.env`
against the invocation directory, so every command is
`docker compose --env-file ../.env …` from `docker/`. The `idp-*.sh` / `.cmd`
pairs do that for you. Build context is the repository root; the ignore file is
`docker/Dockerfile.dockerignore` (BuildKit's per-Dockerfile ignore).

**There is no bootstrap account.** A database with no users serves the first-run
setup page (`/setup`, **D52**), and whoever completes it is the first
administrator. There is no `reset-admin` command. To get the wizard back on a
schema that already has users, drop the schema.

---

## The UI kit: shadcn in this monorepo

Components live in `packages/ui/src/components` and are **copied from the shadcn
registry**. Base UI, not Radix — check the `base` field from
`npx shadcn@latest info`. The registry's own rules are vendored at
[.agents/skills/shadcn/](.agents/skills/shadcn/); `rules/base-vs-radix.md` is
the API-difference reference (`render`, not `asChild`).

### Registry output is used verbatim

Never hand-patch a generated component. If lint complains about one, **turn the
rule off** in `packages/ui/eslint.config.js` — seven `tanstackConfig` opinions
are already off there for this reason, most recently
`import/consistent-type-specifier-style`, which rejects the registry's own
`import { cva, type VariantProps }`. A patch is undone by the next `add`; the
rule is the fix and the file never is.

### Applying a preset

```bash
pnpm dlx shadcn@latest apply --preset <code> -c apps/web -y
```

From the repository root it aborts with `monorepo_root`. Target **`apps/web`**,
not `packages/ui`: its `components.json` points at
`../../packages/ui/src/styles/globals.css`, so the shared components and the
theme are rewritten either way.

Four things the CLI leaves wrong afterwards, every time:

1. It adds `@base-ui/react`, `class-variance-authority`, `clsx`,
   `tailwind-merge`, `tw-animate-css`, `shadcn` and the preset's font to
   `apps/web/package.json`. They belong to `packages/ui`, where the components
   are. `git checkout apps/web/package.json`; add only the new font package to
   `packages/ui`.
2. It writes `apps/web/src/lib/utils.ts` with a duplicate `cn`. Nothing imports
   `@/lib/utils` — the alias is `@workspace/ui/lib/utils`. Delete it.
3. It **adds** the new font's `@import` to `globals.css` and never removes the
   old one, so the previous preset's font is still downloaded by every visitor.
   Drop the stale `@import "@fontsource-variable/<old>"` and its dependency.
4. It never touches `packages/ui/components.json`, which then describes a style
   its own files no longer are — and that file is what the CLI reads for an
   `add` run from `packages/ui`. Copy the preset-derived fields across by hand:
   `style`, `baseColor`, `menuColor`, `menuAccent`, `registries`.

Verify with both, which must report the same `preset.code`:

```bash
npx shadcn@latest info --json -c packages/ui
npx shadcn@latest info --json -c apps/web
```

Then `pnpm install`, `pnpm lint`, `pnpm typecheck`, and — because a restyle is
only really verified in a browser — rebuild the image and run `test:e2e`. The
axe scans in `e2e/a11y.spec.ts` are what catch a contrast regression from a
changed `baseColor`.

---

## Plan lineage

Plans live outside the repository in `~/.claude/plans/`, in this order:
`generate-a-plan-to-lovely-teacup.md` → `we-had-…-buzzing-thimble.md` →
`finish-idp-v1-s3-m6-m14.md` → `review-the-current-implementation-splendid-dragon.md`
(owner review round 1, 2026-08-25).

Sessions end on context and hand off through status.md. New owner review
findings recorded there are **pre-work**: they come before anything still open
in status.md's Pending section.
