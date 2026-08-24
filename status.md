# semantius-idp — where the plan stands

**As of:** 2026-08-24 · **Branch:** `feat/idp-v1` · **Base:** `main` · **Head:** `a89ba87`
**Plan:** `~/.claude/plans/we-had-c-users-martinamm-claude-plans-ge-buzzing-thimble.md`
**Spec:** [spec-v1.md](spec-v1.md)

Working tree clean. **Phase 0 is complete.** Every gate green: lint, typecheck,
unit (232), integration (301 across both projects), coverage thresholds,
schema-drift, config-schema staleness, dependency pinning, and the new
client-bundle gate.

---

## Review results

*Empty — nothing outstanding. The next round's findings go here, and are
treated as pre-work before any further milestone starts.*

---

## Phase 0 — done, and what it turned up

The three review findings are fixed. Four more problems surfaced while fixing
them, all of which were shipping.

**Your three:** R-1 the reveal control · R-2 the schema-generator premise ·
R-3 the post-login destination. Nothing outstanding from any of them.

**Found on the way, in the order they appeared:**

| | |
|---|---|
| **R-4** | The whole server was in the browser bundle, and hydration was dead on every page |
| **R-5** | The forced password change never ended — the bootstrap admin was trapped for ever |
| **R-6** | Two gates that were green only because nobody ran them |
| **R-7** | The advisory-lock timeout never worked; a blocked start would hang, not fail |

Every one was found by *running* something rather than reading it: opening the
app in a real browser, signing in end to end against a live server, running the
CLI, running the coverage command. None would have been caught by another pass
over the code.

### R-1 · Password reveal control looks unfinished (FR-ACCT-2, WCAG 2.1 AA)

**Where:** `apps/web/src/components/auth/form-parts.tsx` → `PasswordField`.
Affects `/login`, `/signup`, `/reset-password`, `/change-password`.

**What is wrong:** the reveal is a full-width underlined text link reading
"Show password" / "Hide password" sitting *below* the input — three of them
stacked on the change-password form. It reads as unstyled scaffolding, not a
product.

**What it should be:** an **icon button inside the field**, right-aligned,
vertically centred — the conventional eye / eye-off affordance. One control that
toggles, not two links that swap. A leading field icon (envelope, padlock) is
the reference the owner gave; the reveal control is the part that matters.

**Why it ended up like this:** the toggle is a hidden checkbox driving the input
through a CSS sibling selector, so it works before hydration and without
JavaScript — which was a deliberate choice for the login page. That constraint
is worth keeping, but it does **not** require an ugly control: the same
checkbox can style a `<label>` containing an SVG, positioned absolutely inside
the field wrapper, with the two icon states swapped by `peer-checked:`.

**Acceptance:**
- icon button inside the input, not a link below it
- one toggling control, not two swapped labels
- `aria-label` that changes with state, and a real focus ring — it is a control,
  so it must be reachable and announced
- ~~still works with JavaScript disabled~~ — **withdrawn by the owner,
  2026-08-24: the site does not need to work without JavaScript** (D31)
- `lucide-react` is already a dependency; no new one is needed

**✅ Fixed.** One in-field eye / eye-off control, right-aligned, Tab reaches it
*after* the password field with a visible ring, and the accessible name changes
with state. Verified in a real browser, not only in a test.

The toggle flips the input `type` from a `change` handler. Two mechanism notes
worth keeping, because both contradict what the code used to assume:

- Tailwind v4 compiles `peer-checked:` to `:where(.peer):checked ~ *`, a
  **sibling** combinator, so it cannot reach the icons inside the label. Those
  use `group-has-checked:` (`:where(.group):has(:checked) *`). The same hook
  masks the input, which is what lets the checkbox sit *after* it in the DOM
  and gives the natural tab order.
- `-webkit-text-security: none` on `input[type=password]` is parsed and then
  **clamped back to `disc`** by Chromium 151 and WebKit 26.5; only Firefox 153
  honours it. All three honour it on `input[type=text]`, so the two engines are
  specifically refusing to let a password field be unmasked by style. The
  scriptless reveal this component always claimed therefore only ever worked in
  Firefox — moot now, but it is why the CSS path is a fallback and not the
  mechanism.

A `<noscript>` rule still withdraws the control when scripting is off. It costs
nothing and stops the toggle renaming itself "Hide password" over a masked
field, which would lie to a screen reader. It is no longer load-bearing.

### R-2 · The custom schema generator rests on a false premise (DM-1)

**Where:** `apps/web/scripts/generate-auth-schema.ts`, and every place that
repeats its justification — the deviations table below, the S5 spike note, the
file's own header comment, and the M14 CONTRIBUTING text that has not been
written yet.

**What is wrong:** the generator exists because I concluded the Better Auth CLI
was version-stranded. It is not. The CLI was **renamed**:

| | |
|---|---|
| `@better-auth/cli` | **deprecated** — *"Package no longer supported"*, last at 1.4.21 |
| **`auth`** | the current CLI, **1.7.1**, bins `auth` and `better-auth`, depending on `better-auth@1.7.1` and `@better-auth/core@1.7.1` |

Those are exactly our pinned versions, so the version-skew argument — the whole
stated reason for not using DM-1's specified tool — does not hold.

**How it was missed:** I read `@better-auth/cli`'s dist-tags, saw `latest:
1.4.21` against `better-auth@1.7.1`, and stopped. I never checked whether the
package had been renamed, and never ran `npm view @better-auth/cli deprecated`,
which says so outright. A stale `latest` is exactly the shape of a renamed
package, and I read it as an abandoned one.

**What must be re-evaluated — not assumed:**

1. Does `npx auth generate` produce a Drizzle schema equivalent to the committed
   one? Diff it against `auth-schema.ts` before deciding anything.
2. **The open question that may still justify a custom generator:**
   `database.schema` is a *runtime* value (CFG-4, D27), so the schema module has
   to be a `createAuthSchema(schemaName)` **factory**. The CLI emits constants
   with the name baked in. If it cannot be made to emit a factory, the custom
   generator survives — but for *that* reason, stated honestly, not the version
   one.
3. If the CLI can serve, delete the generator, switch `db:generate-schema` to
   it, and keep the `--check` drift gate pointed at whatever produces the file.

**Until this is settled, treat the deviations table's "version-stranded" row as
known-false.** The generated schema itself is not in doubt — it is validated
against a real database and by the drift gate — only the reasoning for how it is
produced.

**✅ Settled — recorded as D29. The generator stays, for a different reason.**

I ran the CLI rather than reasoning about it. `auth@1.7.1` installs, runs, and
against a shim of our own option set emits the same **seventeen** tables.
Compared as Drizzle *table objects* — `getTableConfig()` over every column,
index and foreign key, not a text diff — the two are now **identical across all
17 tables**.

It survives on your point 2, and only that. Where a schema is configured the
CLI emits, from its own source:

```js
code += `
export const ${schemaVarName} = pgSchema(${JSON.stringify(schemaName)});

`
```

A module-level `const` with the name baked in as a string literal. `database.schema`
is a runtime value (D27), so the module has to be a `createAuthSchema(schemaName)`
factory plus `CANONICAL_SCHEMA_NAME`. The CLI has no code path that emits a
function — so it cannot serve, and the pre-decided rule says keep the generator
and state the honest reason. Corrected in the generator header, the S5 spike
note, spec §4 + DM-1, and the deviations table below.

**Running it found two real bugs in ours** — "identical" is only true after
fixing them, and this is the part worth your attention:

| | ours (before) | `auth generate` |
|---|---|---|
| `required` | `if (field.required)` | `attr.required !== false` |
| date defaults | `.toString().includes("new Date()")` | the same test |

Better Auth documents `required?: boolean` as **`@default true`**. Reading it as
truthy made every field that declares nothing **nullable** — including
`oauth_access_token.token`, which is also `unique`, and Postgres allows any
number of rows to share a NULL under a unique index. `expires_at` on both token
tables went the same way: a token with no expiry was representable. Caught
before M8 wrote a single row; migration `0001_cheerful_korg.sql`.

The second is a curiosity: 1.7.1's default thunk stringifies as `() => new Date`
— **no parentheses** — so a test looking for `new Date()` never matches and
every `.defaultNow()` was silently dropped. **The CLI has the identical bug**;
ours now evaluates the thunk instead of reading its source. A third gap closed
alongside: `field.onUpdate` was ignored, so `session.updated_at` and
`account.updated_at` were not touched on a Drizzle-side update.

Also unified: the schema-name environment variable was `IDP_SCHEMA_NAME` in
`drizzle.config.ts` and `IDP_DB_SCHEMA` in the generated file, and the two could
disagree. Now `IDP_SCHEMA_NAME` everywhere. The generator's hard-coded `"idp"`
is now the `CANONICAL_SCHEMA_NAME` constant it always meant.

### R-3 · Post-login destination is unconfigurable, and its default 404s today

**Where:** `apps/web/src/routes/login.tsx`, `server/config/schema/config-schema.ts`
(the `auth` block), `server/ui-context.ts`. Spec: a new CFG-4 key and a sentence
in FR-AUTH-1; needs a decision number (**D28**).

**Two problems, one fix.**

*It is broken now.* Sign-in redirects to
`safeReturnTo(form.returnTo, APP_ROUTES.account)` — and `/account` does not
exist until M7. **A successful sign-in today lands on a 404.** Only the
bootstrap admin escapes it, because `mustChangePassword` diverts to
`/change-password`, which is why this was not caught: the one account used to
test the flow is the one account that never reaches the default.

*It is unconfigurable.* `/account` is the wrong destination whenever the IdP is
bundled beside the product — at `https://apps.example.com/idp` with the app on
`/`, or with the app on a different host entirely. After signing in, users
should land in the product, not on their profile page.

**Design (decided with the owner):**

- New key **`auth.defaultRedirect`**, default `/account`.
- Accepts a **same-origin relative path or an absolute URL on any origin.** This
  is operator configuration, not user input, so cross-origin is not an open
  redirect. **SEC-3 is unchanged:** the runtime `returnTo` query parameter stays
  same-origin-relative-only, validated by `safeReturnTo` exactly as now.
- **Governs sign-in only.** Sign-up still ends at `/pending-approval` or
  verification, password reset still returns to `/login`, verification keeps its
  own ending. Each flow keeps the ending that makes sense for it.

**Precedence at sign-in, highest first:**

1. a pending OAuth authorization continuation (FR-OIDC-9) — always wins
2. a validated same-origin relative `returnTo`
3. `auth.defaultRedirect`
4. `/account`

**Watch out — the forced-change path.** FR-AUTH-4 interposes
`/change-password` before the destination and currently carries it through the
query as `returnTo`, which `safeReturnTo` rejects for absolute URLs. So when
`auth.defaultRedirect` is absolute it cannot simply be passed through: the
forced-change handler has to re-resolve the destination at the end rather than
round-trip it through a parameter.

**Acceptance:**
- key validates as a relative path or an absolute URL; a bare hostname is rejected
- sign-in honours the precedence above, and an OAuth continuation still wins
- `returnTo` from the query is still refused unless same-origin relative — the
  existing SEC-3 tests must keep passing unchanged
- forced password change reaches an absolute destination correctly
- `config.example` documents it, and the README says to set it when the IdP is
  bundled

**Note on ordering:** this is worth doing *before* M7. It removes the 404 by
configuration rather than making everyone wait for `/account` to exist.

**✅ Fixed.** Recorded as **D28** in the spec (CFG-4 row, FR-AUTH-1 precedence
sentence, a new AC line, §12.1). The resolver is one exported function,
`server/http/post-login.ts`, so the three places that decide a destination —
sign-in, the 2FA challenge in M6, and the far end of a forced password change
— cannot drift apart. The `pendingContinuation` parameter is already there and
always `undefined`, so M9 changes that module and nothing else.

`server/ui-context.ts` is deliberately untouched: the destination is resolved
server-side and never needs to reach the browser.

---

### R-4 · The whole server was being shipped to the browser — found while fixing R-1

**Not a review finding — found by opening the app in a real browser**, which
R-1 made necessary. The console said:

```
ReferenceError: Buffer is not defined
  at ../node_modules/.pnpm/postgres@3.4.9/.../postgres/src/bytes.js:2:13
```

**The `postgres` driver was in the client bundle, and it killed hydration on
every page.** The production build shipped 1.06 MB to the browser containing
Better Auth, Drizzle, the migrator and this, verbatim:

```sql
select pg_try_advisory_lock($1::int, $2::int) as locked
```

No secrets leaked — those are runtime values, not compiled in — but the
server's *code* was, and nothing on any page could hydrate.

**Why it happened.** A TanStack Start route `loader` is isomorphic: it runs on
the server for the first paint and in the browser on every client-side
navigation. So a top-level `import { getRuntime }` in a route file pulls the
entire IdP into the client graph — even though only the loader touches it.
Every route did exactly that, `__root.tsx` included. A `server.handlers` block
*is* stripped from the client build, which is why the POST handlers were fine
and why this looked safe.

**Why nobody noticed.** Every public page is a plain server-rendered form that
works without JavaScript — deliberately, per FR-ACCT-2. With nothing depending
on hydration, a completely dead client bundle is invisible. R-1's reveal
control is the first thing on the site that needs script, and it did not work.

**Fixed.** `server/functions/ui.ts` wraps the one piece of server work the
shell needs in `createServerFn`, whose body the Start plugin compiles out of
the client build. `__root.tsx` fetches it in `beforeLoad` and puts it in the
router context; every child route reads `context.ui`, so it is one RPC per
navigation rather than one per matched route. Client bundle 1.06 MB → 334 kB,
and hydration verified working in Chrome.

**Guarded.** New `scripts/check-client-bundle.ts`, wired into CI: it fails if
any of six server-only strings appears in a client chunk, or if the bundle
crosses a size ceiling. Each marker is also asserted to be *present* in the
server build, so a marker that stops matching anything fails loudly instead of
passing for ever. Verified by reintroducing a single leaking loader — the gate
catches it.

### R-5 · The forced password change never ended

**Also not a review finding** — found while proving R-3 end to end against a
live server. `mustChangePassword` was **set** by the bootstrap step and
**cleared nowhere in the codebase**. So:

1. sign in with the temporary password → `/change-password?forced=1`
2. change the password → succeeds, session kept
3. sign in again → `/change-password?forced=1`, for ever

FR-AUTH-4 says the flag interposes a change "before anything else completes".
It did. It just never stopped. **The bootstrap admin could not reach any
destination at all** — which is also why R-3's `/account` 404 was reported as
theoretical rather than seen: the one account available to test with never got
past the interposition to hit it.

**Fixed** in `auth/options/database-hooks.ts` via `account.update.after` — the
only seam that fires after the write succeeds *and* carries both `providerId`
and `userId` (the matching `before` hook receives just `{ password }`, with no
user to act on). Gated on an explicit endpoint list rather than "any credential
password write", because M10's admin temporary-password flow writes a password
**and** raises this same flag; clearing on every write would race it and hand
the user an unforced sign-in. The decision is an exported pure predicate so
that list is asserted without a database.

Verified against a live server: temporary password → forced change → the
configured destination → and the next sign-in goes straight there.

### R-6 · Two more gates that were green only because nobody ran them

Both found while doing the work above, both now real.

**`pnpm lint` was failing at HEAD.** Three shadcn-copied files in
`packages/ui` used inline `type` specifiers, which the TanStack config
rejects. status.md said every gate was green. Fixed in the first commit of
this session.

**The coverage thresholds were decorative — and failing.** TST-1's numbers were
in `vitest.config.ts` but **no CI job ever ran `--coverage`**, so nobody saw
that a run reported ~60 % lines against a 70 % gate. The cause was the
denominator: coverage was measured over the whole of `src/server` from the
**unit** project alone, while the database layer, the auth instance and the
hooks are exercised by the integration project by design.

Measured across both projects the real numbers are 82.9 % lines / 79.4 %
branches, comfortably over TST-1's 70 %. So there is now a `test:coverage`
script that runs both, the integration CI job runs it, and the per-module
85 % gates are extended to the approval modules the plan asked for —
`auth/options/database-hooks.ts` and `auth/plugins/idp-plugin.ts` — with the
tests to clear them. `src/server/oidc/**` was also under its 85 % branch gate
and is now covered.

`packages/ui` also carried both `eslint.config.js` and `eslint.config.ts`.
ESLint resolves `.js` first, so the `.ts` file — which had none of the rule
overrides — was dead weight that would have silently changed the rule set if
the `.js` one ever went away. Deleted.

### R-7 · The advisory-lock timeout never worked

Found by running `pnpm --filter web run db:migrate` — the script this session
was fixing anyway — while a killed process still held the lock. It waited ten
minutes without the `AdvisoryLockTimeout` the code carefully wrote.

`withAdvisoryLock` did:

```sql
SET LOCAL lock_timeout = '60000ms'
```

**`SET LOCAL` outside an explicit transaction block is discarded by Postgres**
with a warning, and every statement there runs in autocommit. So the timeout
stayed at 0 and the wait was unbounded. Every advisory-locked step inherits
this: migrate, first-boot key generation, reconcile, bootstrap admin, cleanup.
Two containers restarting together is the ordinary case (OPS-2), and the
second one would hang silently rather than fail with the actionable message
that was already written for exactly this situation.

Now a session-scoped `SET`, with `RESET lock_timeout` before the connection
goes back to the pool so the next borrower does not inherit it. New
`tests/integration/advisory-lock.test.ts` holds the lock on one connection and
asserts the second gives up, names the lock in the error, honours
`skipIfLocked`, releases on both success and throw, and leaves no
`lock_timeout` behind. **Verified by putting the bug back**: the timeout test
hangs until killed, and passes in seven seconds with the fix.

## Done (M0 spikes, M1–M5)

**M1.0 — spec amended** for D24–D26: social profile-sync collision now blocks
sign-in, no social/sign-up warning, and M2M removed throughout (FR-OIDC-1/3/7,
CFG-4/5, SEC-6, TST-4, DOC-3, §12, §15 ticked).

**M0 spikes** — findings recorded in [docs/spikes/](docs/spikes/):

- **The 1.7.x plugins moved.** `oauth-provider` and `api-key` are now separate
  packages (`@better-auth/oauth-provider@1.7.1`, `@better-auth/api-key@1.7.1`),
  so three packages have to move in lockstep on every upgrade. Reading their
  real type surface is also what froze the FR-OIDC-3 mapping (R9) and settled
  R4, R5 and R10.
  ⚠ The *second half* of this finding — that the CLI was unusable — **was
  wrong**; settled as **D29**, see **R-2** under Review results. The CLI runs
  fine at 1.7.1; the generator survives because the CLI cannot emit a
  schema-name factory, and running it found two real bugs in ours.
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

## Not done (S3, M6–M14)

Social + 2FA, account self-service + API keys, **OIDC core (M8 — the largest)**,
authorize UX, admin UI, security hardening, Docker/compose/CLI, e2e, and docs.
Spike S3 (sub-path) is also outstanding, though `base-path.ts` and the config
already carry it and the e-mail templates are tested under a sub-path issuer.

One deviation, already accepted in the plan: `drizzle.config.ts` sits in
`apps/web/` rather than the repo root, because drizzle-kit resolves every path
relative to itself and both the schema and the migrations live there.

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
| `/account/*` | ❌ 404 — **M7** · ⚠ and it is where sign-in currently sends you, see **R-3** |
| `/admin/*` | ❌ 404 — **M10** |

Plus `/signup`, `/forgot-password`, `/reset-password`, `/verify-email`,
`/pending-approval`, `/banned`, `/change-password`, `/logout` — though `/signup`
and `/forgot-password` deliberately 404 under the default config, since sign-up
is off and no Resend key is set.

So: what works end to end today is password sign-in, sign-up with approval,
verification and reset, the startup sequence and the bootstrap admin.

**The `/account` 404 is now curable by configuration** — set
`auth.defaultRedirect` and sign-in lands wherever you point it (D28). Verified
against a live server: temporary password → forced change → the configured
destination, and the next sign-in goes straight there.

Also new since the last update: the public pages actually **hydrate** (R-4),
so anything needing JavaScript works rather than silently not; and every
Better Auth endpoint that matters writes an **audit row** (SEC-6), where before
only three of twenty-nine actions did.
**What does not work is OIDC** — no discovery, no authorize, no token endpoint.
That's M8, the largest remaining milestone, and nothing in it has been started.

---

## Milestone table

| # | Milestone | Status |
|---|---|---|
| M1.0 | Amend spec for D24–D26 | ✅ done |
| M0 | Spikes S1, S2, S4, S5 | ✅ done · S3 (sub-path) **outstanding** |
| P0 | Phase 0 — review fixes + M5.5 backfill + CI | ✅ done |
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

Phase 0, newest first:

```
a89ba87 feat(cli): make `db:migrate` real, and fix the lock timeout it exposed
b3fbabf fix(ui): translate the two notice codes nothing handled, drop a dead branch
8c4923b feat(audit): SEC-6 â€” record what Better Auth does, and make the coverage gate real
612dcbc feat(signup): FR-SIGNUP-2 â€” actually notify the administrators
9256dc7 ci: run the integration suite against a real Postgres
9a1804c fix(db): R-2/D29 â€” settle the generator question, and fix what asking it found
365064b fix(auth): FR-AUTH-4 â€” let the user out of the forced password change
ac85464 fix(build): keep the server out of the browser bundle
6d975ad feat(auth): R-3/D28 â€” auth.defaultRedirect, resolved in one place
fb989fe docs(spec): D28 â€” auth.defaultRedirect, the post-sign-in destination
2f9865c chore(skills): install the agent-browser skill
fbee5ba fix(ui): R-1 â€” password reveal as an in-field icon control
31e08c6 fix(ui): restore the lint gate â€” top-level type-only imports
```

Everything before this session:

```
520d786 docs(status): record R-3 - post-login destination unconfigurable and 404s today
8f35357 docs: correct the CLI finding - the Better Auth CLI was renamed, not abandoned
b319c98 docs(status): add review-results section; clarify the search_path finding
896cab1 docs: say plainly that there is no default login, and what to type instead
099f47b docs: rewrite status.md around the Done/Not-done summary, add README getting started
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

### The 1.7.x plugins moved (S5)

`oauth-provider` and `api-key` are **separate packages** in 1.7.x
(`@better-auth/oauth-provider@1.7.1`, `@better-auth/api-key@1.7.1`). Three
packages now have to move in lockstep on every upgrade. Reading their real type
surface is what froze the FR-OIDC-3 client mapping (R9) and settled R4, R5 and
R10.

> ⚠ **This spike also concluded the CLI was unusable. That was wrong** — the CLI
> was renamed from `@better-auth/cli` (now deprecated) to **`auth`**, which
> tracks 1.7.1. See **R-2** under Review results. The Drizzle schema is
> currently generated by `apps/web/scripts/generate-auth-schema.ts` from the
> installed `getAuthTables()`; whether that should remain is R-2's open
> question.

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
| Schema generated by `scripts/generate-auth-schema.ts`, not the Better Auth CLI | **Verified, D29.** The old "version-stranded CLI" reason was false — the CLI was renamed to `auth` and tracks 1.7.1. The real reason: the CLI emits module-level constants with the schema name baked in as a string literal, and a runtime `database.schema` (D27) needs a `createAuthSchema(schemaName)` factory it has no code path to produce. Both now emit field-identical output across all 17 tables. |
| Own migrator instead of `drizzle-orm`'s | Drizzle's applies the file verbatim and cannot retarget `database.schema`, which is a runtime setting. |
| `drizzle.config.ts` in `apps/web/`, not the repo root | drizzle-kit resolves every path relative to the config file, and both the schema and the migrations live there. |
| New config key `database.directUrl` | Forced by the S4 pooler finding; recorded as D27 and amended into CFG-4. |
| Route loaders read `context.ui`, filled by one `createServerFn` in `beforeLoad` | A Start `loader` is isomorphic, so a top-level `getRuntime` import puts the whole IdP in the browser bundle. See R-4. |
| Coverage is measured across **both** vitest projects, not `unit` alone | Measuring all of `src/server` against unit tests only is the wrong denominator, and reported ~60 % against its own 70 % gate. See R-6. |
| The reveal control is withdrawn when scripting is off | Blink and WebKit clamp a password field back to `disc` whatever the style says, so a scriptless toggle would lie to a screen reader. Cheap and no longer load-bearing after D30. See R-1. |
