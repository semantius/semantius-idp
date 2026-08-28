# semantius-idp — where the plan stands

**As of:** 2026-08-28 · **Branch:** `feat/database` · **Head:** `1b9b24c`, last tag **v0.2.0**
**Plan:** `~/.claude/plans/make-the-admin-layout-shiny-unicorn.md` (the sidebar shell)
**Spec:** [spec-v1.md](spec-v1.md) — amended through **D85**

**S3, M6–M14 and owner review rounds 1, 2 and 3 are done, up to the release
gate.** Every gate green: lint, typecheck, unit (599), integration (243 across
twenty-four files), coverage thresholds including the 85 % per-module gates,
schema-drift, config-schema staleness, the configuration-reference and
example-config gates, dependency pinning, the client-bundle gate, the TST-8
container smoke test — run against the moved `docker/` layout and now
completing the first-run wizard — and the TST-6 end-to-end suite: 86 tests in a
real browser against the built image, in both deployment shapes.

The `docker/idp-*` lifecycle scripts were exercised end to end as well —
create → status → cli → stop → start → logs → destroy — against a throwaway
`idp_scripts_check` schema that was dropped afterwards (P0'.2).

**What is left needs the owner.** Tagging `v1.0.0` and publishing the image are
the mandatory sign-off gate, and the two checks that cannot be automated are
written down but not performed: the manual social walk-through against Google,
GitHub and Entra, and one real token validated against a real Neon project.
Both are [docs/release.md](docs/release.md).

**What that suite did on its first complete run is the story below.** It found
fourteen defects, three of which meant a documented feature did not work at
all — the e-mail verification link went to a page that cannot spend a token, no
OIDC login could resume through the sign-in page, and `form-action 'self'`
cancelled the redirect that carries an authorization code, so no OAuth login
could complete in Chrome. None of them was visible to any other gate, because
every other gate in this repository reads HTML, JSON or a database row.

---

## Pending

Everything not yet done, in the order it should be done. Nothing else in this
file is a to-do list.

### 1. The release — **owner sign-off required**

Everything buildable is built. What remains cannot be done from here:

- **The manual social walk-through** against real Google, GitHub and Entra
  consoles, on a staging deployment with public HTTPS (TST-7). The checklist is
  [docs/release.md](docs/release.md); the Entra item that matters most is that
  renaming an account's UPN still reaches the same user, because keying on
  e-mail instead would silently create a second one.
- **One real token against a real Neon project** — including a key rotation,
  to see the grace period behave.
- **Tagging `v1.0.0`.** Two versions are published — **v0.1.0** and, on
  2026-08-27, **v0.2.0** (the D78 / D80 / D81 round) — because the image was
  wanted before the two manual checks above could be performed. `1.0.0` is what
  those checks gate, and it still needs the owner's decision rather than a green
  board. Everything below about the machinery is now history rather than plan:
  `docker/release.sh vX.Y.Z` bumps the three version files, commits, tags and
  pushes, and the tag is the whole trigger. Rehearse a version first with
  **Actions → Release → Run workflow**, which builds both architectures and
  smoke-tests amd64 without pushing anything.

**v0.2.0, as published.** `ghcr.io/semantius/semantius-idp` `0.2.0` · `0.2` ·
`0` · `latest` · `sha-61e733c`, one digest
(`sha256:99804fab…`) carrying `linux/amd64` and `linux/arm64`, plus the two
buildx attestation manifests. Smoke test, Trivy scan and SBOM all green in
[run 33124131255](https://github.com/semantius/semantius-idp/actions/runs/33124131255);
the GitHub release carries the changelog's `[0.2.0]` section and the SPDX SBOM.
The release checklist's "after" items are done except the two that need a
machine other than this one: pulling the image somewhere clean and running the
README quick start against it, and confirming `latest` from outside.

### 2. Open, non-blocking

- Nothing. The one item that stood here — the stranded dev login on the
  persistent `idp` schema — is resolved by **D52**: drop that schema and the
  next boot serves the first-run setup page, which is now the only way an
  administrator is ever created. No credential to recover, and no command that
  changes one.

---

## The nightly audit was red (2026-08-28, **D85**)

`pnpm audit --audit-level moderate` — CI's nightly SEC-9 job — was failing
with **sixteen** advisories: 12 high, 3 moderate, 1 low. **Every one is a
transitive dev dependency and none of them is in the image**, which carries
production dependencies only: `brace-expansion` under `eslint>minimatch` and
again under `@tanstack/eslint-config>eslint-plugin-import-x>minimatch`,
`js-yaml` under `eslint>@eslint/eslintrc`, `shell-quote` and `launch-editor`
under `@tanstack/devtools-vite`, `postcss` and its `nanoid` under `vite`,
`esbuild` under `drizzle-kit>@esbuild-kit/core-utils`.

They are closed with exact `pnpm.overrides` — version-scoped where two majors
of one package are in the tree (`brace-expansion@1` → `1.1.18`,
`brace-expansion@5` → `5.0.9`), parent-scoped where a global bump would be the
bigger change (`@esbuild-kit/core-utils>esbuild` → `0.25.12`, already in the
tree for Vite). Not by raising `--audit-level`, which hides the class next
time, and not by an ignore list, which nobody revisits. The install *removed*
nine packages and the lockfile lost 261 lines: most of these were duplicate
copies of one library.

**One `low` is left on purpose**: `drizzle-kit>tsx>esbuild`
(GHSA-g7r4-m6w7-qqqr, patched in `0.28.1`) is below the gate's threshold, and
`tsx` pins its own `0.27` line — forcing a major on the loader that reads
`drizzle.config.ts` risks the migration generator for a dev-only file-read
finding. Written down here so it is not rediscovered as an oversight.

`check-pinned-deps.ts` reads `pnpm.overrides` now as well as the four
dependency fields, and refuses a range there for the same reason it refuses
one anywhere else.

## The console's second round — four owner notes (2026-08-28, **D84**)

Four notes on `/admin/database` the day after it landed. All four are done.

**1. The mode belonged in the first sentence.** The page introduced itself and
*then*, in a second paragraph, said "Every statement runs inside a READ ONLY
transaction" — the most important fact on the page, in the position a reader
skips. The description now says "a read-only SQL console" on a `read-only`
deployment and the second paragraph is gone. Two full spellings in the
catalog rather than one sentence with an interpolated fragment: a translator
needs to put those words where their own language wants them. The writable
deployment keeps its second line, because that one is an instruction — switch
the editor to Read + write — rather than a restatement.

**2. The schema is a selector now — and it is the tree card's header line.** `GET /idp/database/schema` described
`database.schema` and nothing else; it now lists every schema the console's
connection may read (`has_schema_privilege(…, 'USAGE')`, catalog schemas and
`information_schema` excluded, the deployment's own always offered even if the
catalog walk missed it) and takes `?schema=` to say which to describe. An
unknown name is `400 UNKNOWN_SCHEMA`, never a quiet fall back — the tree would
otherwise describe one schema under another's label. **It widens no
privilege**: `POST /idp/database/query` has always taken arbitrary SQL, so
every one of those schemas was already one `select` away. What it widens is
the tree. The choice deliberately does **not** go in the URL: the statement in
the editor beside it would not survive the reload.

The placement took a second pass, and the owner's question is the whole
argument: the selector first sat *above* the card under its own label, while
the card's header showed the database name beside a `/ to search` hint — a
strip 20 rem wide and entirely decorative. The database name is on the runner
beside it; the search field the hint names is permanently visible one row
below; and the hint told half a truth, since the key only works from inside
the tree. The header is the control now, the table count keeps its place
opposite it, and the hint is gone — the shortcut is not. The label is the
select's own `aria-label`, because a visible one costs the width the control
needs, and `title` is still passed unseen because the tree's `aria-label` is
built from it.

**3. "What does `/` to search?"** It is the vendored explorer's own keyboard
hint, and it is honest but narrow: pressing `/` while focus is *inside the
tree* jumps to the search box. It does nothing from anywhere else on the page,
which is why it reads as a puzzle. Left as it is for now — the hint is the
registry's, the behaviour is standard for a tree widget, and widening it to
the whole panel means intercepting `/` from inside the search input itself.
Worth revisiting if it confuses anybody else.

**4. Every table row has a run button.** Right of the column and row counts, a
play icon that writes `select * from "schema"."table" limit 100` into the
editor and runs it. Two things in it are load-bearing:

- **The statement is schema-qualified.** The search path is the *deployment's*
  schema, so an unqualified name reads the wrong table — or none — the moment
  the selector points somewhere else.
- **The run goes through an effect, not the click handler.** `SQLRunner`'s new
  `ref.run()` reads the editor's current value, and the `setState` that put the
  statement there has not reached it as a prop until the commit. Called
  inline, the button would execute whatever the editor held *before* it was
  clicked — the previous statement, or nothing at all on the first click.
- **The handle lives in state, through a callback ref.** Both panes are lazy
  and the tree arrives first — 25 kB against the editor's 830 — so a click in
  that window found `ref.current` still null and typed a statement that never
  ran. The end-to-end suite found it while the machine was busy with the
  coverage run, which is exactly what a slow connection looks like. State
  re-renders when the runner mounts, the effect runs again, and the request is
  honoured late rather than dropped. That is also why the runner's handle is
  built **once** and reads `run` through a ref of its own:
  `useImperativeHandle` detaches and re-attaches on every render, so a handle
  rebuilt each time would call a callback ref with `null` and a new object
  forever.

**The cost is that both Neon components are forks now.** `SchemaExplorer` has
no prop for a row action and `SQLRunner` cannot be told to run. Each file
carries a header naming its divergences and each divergence is marked
`Fork (D84)` where it sits; `shadcn add` over either overwrites the lot.

**And one of those divergences is an accessibility trap worth remembering.** A
table row was a `<button role="treeitem">`. The action button could not go
beside it — a `tree` may own nothing but `treeitem` and `group`, so a sibling
button is a *critical* axe `aria-required-children` finding, and
`/admin/database` is in the R-1 scan. It could not go inside it either, while
the row was a `<button>`: a button inside a button is invalid HTML that the
parser un-nests, which is a hydration mismatch. The row is a
`div role="treeitem"` now, the action sits inside it — legal, because
`treeitem` is not one of the roles whose children must be presentational —
and the tree's own key handler supplies the Enter and Space the element no
longer has natively. The action stops those two keys short of that handler and
lets the arrows bubble, so navigation still works from the button.

Covered by three new integration tests (the schema list, `?schema=` against a
throwaway schema created and dropped in the test, and the `UNKNOWN_SCHEMA`
refusal) and two new end-to-end tests (the run button's statement *and* its
result grid; the selector moving the tree off `idp`).

## The database console (2026-08-28, **D83**)

The owner asked for Neon UI's `SchemaExplorer` and `SQLRunner` against the
IdP's own Postgres, behind a new configuration value, and — asked which shape
the value should take — chose **one tri-state key** over a boolean plus a
sub-mode: `admin.database: disabled | read-only | read-write`, default
`disabled`. The second half of that answer is the load-bearing one: **with the
flag off the API has to be inactive too, not only the UI.** So the two
endpoints are conditionally *included* in what `buildAdminEndpoints` returns,
and Better Auth answers 404 for a route it was never handed — the same shape
`apiKeys.enabled: false` already produces, and a 403 would have confirmed the
feature exists and is merely switched off.

`ui.neon.com` is a shadcn registry, so this is vendored React in
`packages/ui`. No iframe, no runtime call to anybody (SEC-8 holds).

**Five things are load-bearing.**

- **The write barrier is the wire protocol, not a keyword scan.** The first
  draft ran `tx.unsafe(query)` inside `sql.begin("read only", …)`, and that is
  not safe: postgres.js picks the **simple** protocol when there are no
  parameters, and the simple protocol executes a multi-statement string as a
  script — so `COMMIT; INSERT INTO "user" …` ends the READ ONLY transaction
  and writes in autocommit. `{ simple: false }` forces the extended protocol,
  whose Parse step refuses more than one command with `42601` before executing
  a byte. What is left is one statement, which is the unit the console is for:
  a writable CTE still dies on `25006`. There are integration tests for
  `COMMIT; …`, for `SET TRANSACTION READ WRITE; …`, for a bare `select 1;
  select 2` and for the CTE, each asserting the row count did not move.
  postgres.js reads that option but does not declare it on
  `UnsafeQueryOptions`, so the widened shape is declared beside the call — it
  is the barrier, and a dependency bump that drops it should stop compiling.
- **The console never touches the shared pool.** `select set_config(
  'search_path', …, false)` is legal inside a READ ONLY transaction, and on a
  pooled connection that session state outlives the transaction and reaches
  the next piece of ordinary traffic. It gets its own `max: 1` handles, built
  in `runtime.ts` and closed in `shutdown`: `read` over `database.url`,
  `read-write` over `database.directUrl` (the owner's instruction, per D74).
  Not the `locking` handle; and `max: 1` is safe here precisely because no
  advisory lock is involved.
- **A `read-only` deployment pins the runner to `read-write` and hides the
  mode fieldset**, which reads backwards and is deliberate. Controlled to
  `read`, the component's own keyword guard stops a write before it is sent
  and offers an "Enable writes" button that a controlled prop makes
  permanently inert — a dead control on every attempt. Pinned the other way
  the statement is sent, and the answer is Postgres's `25006` on the right
  line. The pin is a *display* choice and stops at the component: the page
  sends `mode: "read"` regardless, because the endpoint refuses a requested
  `read-write` on a `read-only` deployment. Sending the displayed mode made
  **every** query come back as `WRITE_NOT_ALLOWED`, `select 1` included, and
  the e2e suite is the only gate that drives the real component and could see
  it.
- **`neon-tokens` is not imported.** Both components list it as a registry
  dependency and `shadcn add` writes its `tokens.css` beside them; it
  re-imports `shadcn/tailwind.css` and redefines the whole palette in Neon's
  brand colours — `--primary`, `--destructive` and every `--sidebar-*`
  included, two of which are the hand-measured R-1 divergences. Deleted;
  `packages/ui/src/styles/neon-supplement.css` carries the two custom
  properties and the one utility class the components actually name.
  `--status-scaling` is darkened from `#d97706` to `#92400e`, measured. The
  same file holds the R-1 corrections the axe scan asked for — the components
  draw several strings in `--muted-foreground` at 50-65 % alpha and the error
  code at 70 %, all between 1.97:1 and 3.68:1, and CodeMirror's own `#888`
  placeholder is 3.54:1 — each scoped to the two `data-slot` roots, matched on
  the utility class, and measured in the comment.
- **The client-bundle ceiling moved, 750 kB → 1185 kB.** CodeMirror is
  ~410 kB. The route `React.lazy`s both panes so only a visitor to this page
  downloads them, but the gate sums *all* client JavaScript rather than the
  entry graph, so lazy loading cannot keep the old total. The markers remain
  the real gate; the byte cap is the shape of one old incident.

Two smaller notes worth keeping. The audit metadata key is **`reason`, not
`code`**, because `redactFields` masks anything called `code` (SEC-5 — an
OAuth authorization code is one) and the row read `[redacted]` until it was
renamed. And the console **reads everything at rest** — session tokens,
password hashes, JWKS rows. That is the feature; it is stated in FR-ADMIN-7
and in the configuration key's own description so a reviewer does not mistake
it for an accident, and the default is `disabled`.

---

## The sidebar shell for `/admin` and `/account` (2026-08-28, **D82**)

The owner asked for the layout the sibling **semantius-app** has, on both
areas: a collapsible left sidebar, the signed-in identity and its menu in the
footer, full-width content, a sheet drawer on a phone. What was there was a
centred column capped at `max-w-6xl` / `max-w-4xl`, a row of nav pills and two
ghost buttons.

**The part that is not cosmetic is where the chrome lives.** It used to be
applied per page — seven `AdminShell` call sites and five `AccountShell` ones.
It is now one `SidebarLayout` mounted by `routes/admin.tsx` and
`routes/account.tsx`, because `SidebarProvider` holds the collapse state, the
mobile sheet's state and a `window` keydown listener, and a layout route's
component is the only thing here that survives a navigation inside its own
subtree. Per page, every navigation would have remounted the provider, snapped
the sidebar open and registered another listener.

Five things fell out of that, all recorded in **D82**:

- **`/admin/*` has a `<main>` landmark for the first time.** `SidebarInset`
  renders the only one, for both areas. The account pages had one per page;
  the admin pages had none at all.
- **The impersonation banner is rendered once.** That supersedes **D66**,
  which duplicated it across the two shells deliberately so FR-ADMIN-5's
  "every page" could not be lost by a refactor of either. With one component
  it holds by construction.
- **Sign-out is two steps now** — the menu links to `GET /logout`, the branded
  confirmation page that already existed and carries the POST. A `<form>`
  inside a Base UI menu is the **D80** problem one layer in: the popup
  unmounts as the item is activated, taking the form with it. Nothing in the
  e2e suite clicked the old header button; `signOut` has always driven
  `/logout` directly.
- **The collapse state is a cookie the server reads**, `idp_sidebar_state`,
  scoped to `ui.basePath` so a sub-path deployment and a root one on the same
  host do not fight (OPS-10). Read after hydration instead, the sidebar would
  render open and snap shut on every navigation. It is carried on `AdminGate`
  and `ProfileView`, **not** on `UiContext`, which is process-constant and
  shared by every request. The registry component writes its own
  `sidebar_state` at `path=/`, unread; that write is accepted rather than
  patched out of generated output.
- **The active entry comes from `useMatchRoute`.** `activeProps` cannot reach
  it: the highlight is `SidebarMenuButton`'s own `data-active`, and the
  `<Link>` is inside the button.

Collapsed is an **icon rail with tooltips** — the owner's choice, and a
divergence from semantius-app, which hides its navigation entirely. The other
deliberate divergences are a visible `<h1>` in the header row (three e2e specs
read the area's name off one) and the impersonation banner, which is ours
alone.

**The brand is the name, with no tile beside it** — the owner's call on
seeing it, and also what both areas showed before the sidebar existed. The
header block is hidden on the icon rail rather than shrunk, because without a
tile a collapsed brand would be an empty 8×8 link: unnamed to a screen reader
and an axe finding. The drawer keeps its title, because the mobile sheet sets
no `data-collapsible`.

**One class the reference could not be copied on.** semantius-app's brand and
avatar squares are `bg-sidebar-primary text-sidebar-primary-foreground`, and
they are fine, because what sits on them is a white SVG. Ours hold *text* — an
initial, or the brand's first letter — and that pairing measures **3.07:1** in
the light theme and **2.12:1** in the dark, under R-1's 4.5:1 and an axe
finding on every page of both areas. They use the accent surface instead
(16.04:1 / 14.56:1), which is what `AvatarFallback` would have used anyway,
and the measurements sit in `nav-user.tsx` beside the class — because
re-applying a preset resets the tokens, the same trap `--destructive` is
already annotated for.

**The banner offset needed two goes, and `cn()` is why.** The impersonation
banner sits full-bleed above the sidebar row, so the fixed sidebar has to be
pushed down by its height — `--banner-h`, `2.75rem`, which the banner is
itself pinned to at `md` and up, where the desktop sidebar is the only thing
that exists. The registry's container is `fixed inset-y-0 h-svh`, and
tailwind-merge resolves **one** of those two for us: `h-[calc(100svh-…)]`
replaces `h-svh`, same group; `top-*` does *not* replace `inset-y-0`,
different groups. So the first version had `top: var(--banner-h)` sitting
beside `inset-block: 0` and winning only because Tailwind emits longhands
after shorthands — true, and measured in the built stylesheet, and not
something a layout should rest on. It is a `mt-` now, which cannot conflict
with an inset at all. Verified in a real browser against the built stylesheet
in both themes: banner 44 px, sidebar from 44 to the viewport floor, content
column beside it, document no taller than the viewport. The plan's documented
fallback — the banner inside `SidebarInset` — was not needed.

**The e2e suite earned its place again.** The mobile-sheet test failed the
first time it ran: the drawer is a modal, a client-side navigation does not
unmount it, and so tapping a nav entry on a phone changed the page
*underneath* a drawer that was still covering it and still holding the focus
trap. The URL was right and the heading behind it was `aria-hidden`, which is
precisely what a phone user would have got. `ShellSidebar` now closes it on
the route rather than on each link's `onClick` — an entry added later is
closed by existing, and the back button, which no `onClick` can see, closes it
too. Nothing else in the suite runs below `md`, and no other gate here has a
viewport at all.

`e2e/layout.spec.ts` covers the two properties nothing else would notice: the
collapse surviving a reload on the *first paint*, under both the host-root and
sub-path projects, and the mobile sheet. It locates the trigger by
`[data-sidebar="trigger"]`, never by accessible name — `SidebarRail` is a
second visible button whose registry label matches the catalog's case-
insensitively, and strict mode would fail the test rather than the
application.

The client bundle grew **33 kB**, to 712 kB of the 750 kB ceiling.

---

## Owner review round 5 — four findings (2026-08-27, **D78**)

Reported after using the running application. Three of the four are the same
defect seen from different angles.

### 1. "The account has been deleted" — which account? (**D78**)

That sentence is identical for every account, and it lands on `/admin/users`,
where the row that could answer *which one* is precisely the thing that has
just gone. The address is now a second line on the toast — Base UI's
`description`, not the catalog sentence, because folding it into the wording
would mean a second string for every notice and a translator deciding where a
proper noun goes in each of them, while an e-mail address is the same in every
language.

Most of it needed no plumbing: every action on `/admin/users/:id` comes back to
`/admin/users/:id`, and every `/account/*` page knows its own session, so the
loader already has the address. **Two redirects do not** — a deletion and a
creation both land on the list — and there it travels as a **one-shot handle**,
the same stash the client secret and the set-password link use.
`?subject=jane@example.com` was rejected: `safeUrlForLog` keeps the query string
of every path outside `/oauth2/*` and `/api/auth/*`, so that would write a
deleted account's address into the request log of a codebase that anonymises IP
addresses for exactly that reason (SEC-5).

The dispatcher reads the address **before** the removal. That is a select, not
a write, so the rule at the top of `http/admin-actions.ts` — everything goes
through Better Auth's endpoints, which is what keeps the invariants and the
audit trail in the path — is untouched.

Two notices deliberately go without one. `/account/security`'s change-email
notice is about a *different* address, and "Check the new address for a
confirmation link" with the old address under it reads as a contradiction;
`/account/api-keys` and `/account/consents` are about a key and an application,
not an account.

### 2. Toasts did not always disappear (**D78**)

They do, in a focused window: ten seconds, and it was measured. What was not
visible from the code is that **Base UI pauses every auto-dismiss timer when
the window loses focus** and resumes it only on the way back — so a
confirmation left behind a switched-away window is pinned to the corner of the
screen for as long as the absence lasts. Against a running instance a toast was
still there fifteen seconds after a window blur; with the fix it was gone
eleven seconds after the same blur.

That is exactly the outliving-its-truth **D71** set out to end. D71 removed the
parameter that made a banner immortal and inherited a timer that can be frozen.

There is no provider prop for it and the store is not reachable through
`useToastManager`, so `NoticeToast` keeps its own **wall-clock backstop**: a
`setTimeout` two seconds past the nominal lifetime that closes the toast by id.
It is *not* a replacement for the library's timer — that one still runs and
still wins whenever it is running, so hovering the toast or tabbing into it
still pauses the dismissal, which is the pause WCAG 2.2.1 asks for. The
backstop respects the same state, re-arming while
`[data-slot="toast"][data-expanded]` is on screen, and it is deliberately not
cleared on unmount, because the toast lives in the root's `Toaster` and
outlives the page that raised it. Patching
`packages/ui/src/components/toast.tsx` was rejected on AGENTS.md's standing
rule: it is registry output and the next `shadcn add` overwrites it.

### 3 and 4. "The secret does not show" and "the option to change it is missing" (**D78**)

One defect, reported twice, and nothing about the mechanism was wrong.

The registration form's default type is **`spa`**, chosen in round 2 because a
browser application is what an operator adds here. `spa` and `native` are
public clients: no secret is generated (FR-OIDC-3), and
`/idp/rotate-client-secret` refuses one rather than quietly minting a secret
(**D72**). So the commonest registration on that page produced "The application
has been registered.", no secret dialog, and a row with no *Rotate secret*
control — three facts with nothing anywhere saying they are one fact. From
outside it looks like two bugs, which is how it was reported.

Three surfaces now say it:

- **The type field**, in both dialogs: only a Web application keeps a secret,
  and changing the type is what issues or destroys one. That is also the answer
  to the second report — **an edit that turns a public client into a `web` one
  mints a secret and shows it once**, a path D72 built and the interface never
  mentioned.
- **The confirmation**, which distinguishes the two reasons a create or update
  returns no secret, off the `isPublic` the endpoints already answer with: a
  public client has none, an update that kept its existing one has nothing to
  re-show.
- **The table**, which reads "Public — no client secret" where it read
  "Public"; and `addHelp`, which now promises a secret only for a Web
  application.

A disabled *Rotate secret* button was considered and rejected: a control that
can never be enabled is noise, and the row, the field and the notice already
answer the question it would have raised.

### 5. Withdrawn — there was no timezone defect (2026-08-27, **D79**)

This section claimed that postgres.js parsed `timestamp without time zone` in
the process's zone, so every timestamp arrived an hour early and the freshness
gate refused a session seconds old. **It is wrong.** The driver does parse it
that way, but `drizzle-orm/postgres-js` replaces the parsers for oids
1082/1083/1114/1184 with an identity function on `drizzle(sql)` and maps the
strings itself, correctly. The probes that showed drift were raw `postgres()`
handles with no `drizzle()` call; against the deployment's own database the
server clock and the host clock agree to the second. The `types.timestamp`
override committed in `9a8b423` was inert and has been removed from
`db/client.ts`. The reported symptom was a session **five hours** old, and its
answer is item 6.

### 6. The re-authentication gate is gone (2026-08-27, **D81**)

Reported four times in one round, the last of them: *"how can a session be
expired when I was able to navigate 10 sec ago?"* It was not expired — the
session was valid for another five days. Two different clocks: navigation asks
whether the session is *valid*, saving asked when a password was last *typed*,
and `session.freshAgeMinutes` was fifteen.

The gate is removed rather than retuned, because for this deployment it could
not work at all. With most accounts federating to Google, GitHub or Entra,
there is no password to re-present; the provider button that remains posts no
`callbackURL`, so it drops the `returnTo` and the draft, and the upstream then
SSOs silently — a redirect the user does not interact with, opening the gate
without proving anything. It functioned as designed only for password
accounts. **spec-v0 asked for none of it**; the step-up sentence in FR-AUTH-5
was written here.

What replaced it keeps the property that was carrying the weight:
`http/require-session.ts` requires a session on every mutating handler and
reads the row rather than the cookie cache, so a revocation or a suspension
bites on the next write. Better Auth's `freshAge` is pinned to `0` so it does
not reimpose the same rule from inside. D63's drafts stay for the error paths.

Full reasoning in spec §12.1, **D81**.

### 6. The actions under Status (2026-08-27, **D80**)

Reported in the same round, with the fix named: *"showing actions below Status
is ugly ! can we not have a 3 dot menu with a drop down for the actions ?"*

**D50** put Disable and Remove under the Enabled/Disabled badge, and **D72**
added Edit and Rotate secret beside them — so a table whose other six columns
are one line each had rows four buttons tall, and most of a row's controls sat
under a heading that does not describe them. The four move into a trailing
column with an `sr-only` heading, behind the registry's Base UI
`dropdown-menu`, which cost no dependency (`@base-ui/react` was already there)
and touched no `package.json`.

Three mechanics, each a way to get a menu-plus-dialog wrong:

- **The dialogs are controlled and share one piece of state.** A `menuitem`
  closes its popup as it is activated, so the trigger a `DialogTrigger` needs
  no longer exists by the time the dialog should open. `ActionDialog` grew an
  `open`/`onOpenChange` pair that renders no trigger; one
  `"edit" | "rotate" | "remove" | null` per row makes "never two at once" true
  by construction.
- **A refused edit still reopens itself** (**D62**, **D72**). That was
  `defaultOpen`, which means nothing without a trigger; the claimed draft seeds
  the row's state instead.
- **Enable/Disable stays a real form post.** Its `<form>` stays in the row and
  the menu item is its submitter by `form=` — nesting the form inside the
  portalled popup would have it unmounted by the menu closing underneath its
  own submission.

**Remove is deliberately not red.** It keeps `variant="destructive"` for its
semantics and its place after a separator, but `menuColor:
"default-translucent"` stamps `**:data-[variant=destructive]:text-accent-foreground!`
on the popup: a backdrop-blurred translucent surface cannot promise R-1's
4.5:1 for coloured text over arbitrary page content, and axe cannot measure
contrast through a backdrop filter either. Overriding it would fork registry
output for a control that only opens a confirmation — and that confirmation's
own submit button *is* destructive, above a sentence saying it cannot be
undone.

### What guards it

`e2e/admin.spec.ts` grew two tests, because every one of these is only visible
in a browser: a deletion that must name the account and must then vanish
**with the window blurred**, and a public-client registration that must explain
itself, must show no secret dialog, must offer no rotate control, and must hand
one over when its type is changed to Web. The blur is a real window event and
the dismissal is a real timer; no other gate in this repository can see either.

The four client actions are driven through the menu now — `openRowMenu` and
`openMenuDialog` in `e2e/actions.ts` — and the file-managed row is asserted to
have **no menu** rather than to be missing four buttons, which is the better
assertion in any case. The axe pass scans `/admin/clients` **with a row menu
open**, on a client registered and removed for the purpose: every page it
already covers is scanned before any spec creates a database-managed row, so
the menu had no row to appear in.

---

## The release workflow that had never run (2026-08-27, **D73**)

Asked for a GitHub action that builds the image for x64 and arm64 and tags it
`v0.1.0`. The steps that do that already existed. **They had never executed
once.**

`ci.yml`'s `docker` job carried the whole of OPS-1's publish path — QEMU, the
`type=semver` tag patterns, the GHCR login, `platforms:
linux/amd64,linux/arm64`, `push: true` — behind
`startsWith(github.ref, 'refs/tags/v')` on five steps. That workflow triggers
on `push: branches: [main]`, `pull_request` and a nightly `schedule`. **A tag
push matches none of them**, so the conditions were evaluated by nothing and
the job they belonged to was never reached by a tag. Meanwhile
[docs/release.md](docs/release.md) told the owner, in the imperative, that "the
tag builds amd64 and arm64, pushes `1.0.0`, `1.0`, `1`, `latest` and
`sha-<commit>`". Nothing had ever been pushed anywhere.

It is worth naming the failure mode, because it is not a typo: a correct
conditional inside a workflow whose trigger cannot produce the ref it tests
looks exactly like a working feature and reports exactly like a green board.
Every review of that file — and there were several — read five steps that were
right.

### What replaced it

[`.github/workflows/release.yml`](.github/workflows/release.yml), on
`push: tags: v*`, in two jobs:

- **`guard`** derives the version and refuses in about thirty seconds if the
  tag is not `vX.Y.Z[-pre]`, or if the root `package.json` disagrees with it.
  That second check is not bureaucracy: the image stamps `IDP_VERSION` from the
  tag, and `/healthz`, `idp version` and `/admin/system` all report it, so a
  tree saying 0.0.1 while the artefact says 0.1.0 is a running version nobody
  can trace back to a commit.
- **`image`** builds amd64 and loads it locally, runs the TST-8 container smoke
  test, the Trivy scan and the SBOM **against that image**, then logs in and
  pushes amd64 + arm64 from the same layer cache — so what reaches the registry
  is the layers that were smoke-tested, not a second build that happens to
  match. Finally it opens a GitHub release whose body is this changelog's
  section for the version, with the SBOM attached.

The source gates deliberately do **not** re-run on the tag. They ran on the
commit when it landed on `main`, `docs/release.md` requires them green there,
and re-running a forty-minute two-shape browser suite against an identical tree
would only put the publish behind it.

A **`workflow_dispatch` rehearses**: both architectures to `type=cacheonly`,
amd64 smoke-tested, nothing pushed. It exists so "will this build for arm64?"
can be answered before there is a tag to answer it badly, and there is no
switch to get wrong — a dispatch cannot publish, a tag always does.

arm64 costs almost nothing here, which is worth knowing before anyone reaches
for a native runner: `docker/Dockerfile` pins `deps` and `build` to
`--platform=$BUILDPLATFORM` because their output is JavaScript, so QEMU only
executes the runtime stage's COPYs and one `chmod`. The comment in `ci.yml`
claiming arm64 "roughly triples the build" predates that.

`ci.yml` keeps building and smoking an amd64 image on every pull request and
merge, and writes the layer cache both the e2e job and the release read. Its
dead publish steps are gone.

### And the arm64 image did not build

Running the two-platform build — the first time anybody had, because the only
thing that would have was the publish step that could not be reached — failed:

```
#31 1.685 qemu-x86_64: Could not open '/lib64/ld-linux-x86-64.so.2'
ERROR: process "/bin/sh -c cd apps/web && bun build src/cli/index.ts …"
       did not complete successfully: exit code: 255
```

That message reads like a missing library. It is an **amd64 binary being
executed inside an arm64 root filesystem**.

`docker/Dockerfile`'s `build` stage is pinned to `--platform=$BUILDPLATFORM`
and *executes* the Bun binary it copies out of the `bun` stage — the whole
"Bun, borrowed rather than installed" trick. The `bun` stage was **not**
pinned. So BuildKit instantiates `bun` once per *target* platform while
`build` exists once in total, and hands that single stage whichever `bun` the
other pass happened to resolve. Reduced to eight lines and checked directly:
with `--platform linux/arm64` the `$BUILDPLATFORM`-pinned stage came up
`aarch64` while the binary copied into it was an amd64 ELF.

`FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION}-slim AS bun` makes the
borrowed binary match the rootfs that runs it on any build host. `runtime`
stays unpinned — it is the artefact, and the one stage that must be
per-architecture.

**This was invisible to every gate here**, and would have been invisible to the
release workflow too if that workflow had smoke-tested only amd64 and pushed
both. A single-platform build cannot expose it. There is no gate that builds
both; the release workflow's dispatch rehearsal is now the closest thing, and
[AGENTS.md](AGENTS.md) says to run the two-platform build by hand after
touching the Dockerfile.

### Verified

Both platforms build: `docker buildx build --platform
linux/amd64,linux/arm64 -f docker/Dockerfile --output type=cacheonly .` exits
0 with `linux/amd64 runtime 8/8` and `linux/arm64 runtime 8/8` both complete.
Before the fix, the identical command failed at `bun build`.

**And the image that passed the smoke test was the arm64 one.** This machine's
Docker backend is `aarch64`, so `pnpm docker:smoke` built and ran
`linux/arm64` — `uname -m` inside it is `aarch64` and its Bun is 1.3.12 — and
it passed all nineteen TST-8 checks: ready in 0.33 s, image 117.9 MiB, idle
RSS 185.4 MiB, SIGTERM exit 0, JWT verified against the published JWKS. That
matters more here than it would elsewhere: this image's runtime **is** Bun, so
the arm64 artefact runs a different binary from the one CI exercises, and
until now nothing had ever run it. CI's `docker` job covers amd64. Between the
two, both published architectures have now actually been started.

`docker/release.sh` was run **for real**, in a throwaway clone wired to a local
bare remote, never `origin`. It bumped 0.0.1 → 0.2.0 across all three files,
committed, tagged and pushed; the tag came out GPG-signed and `git tag -v`
verified it. Then, from that state: a pre-release (`v0.3.0-rc.1`) bumped to the
**core** 0.3.0 — which is what the workflow compares — and printed the
restricted tag set; and it correctly refused a re-run of an existing tag, a
version older than the latest tag, a malformed version, an unknown option and
this repository's own dirty tree. The sandbox was deleted afterwards.

The release body assembles correctly: 586 lines, and the `## Docker image`
header block carries no leading whitespace, which is the thing that would have
turned the entire release page into one code block.

The workflows parse, and both are Prettier-clean once line endings are
normalised (this checkout is CRLF under `core.autocrlf=true`; every file in it
warns, including untouched ones). `guard`'s shell was exercised outside CI over
seven inputs — `v0.1.0`, `v0.1.0-rc1`, a version/tag mismatch, `v-old`,
`vendor-x`, and both dispatch spellings — and accepts and refuses the right
ones. The changelog extraction pulls 559 lines (37 KB, well inside GitHub's
125 000-character release body) for `0.1.0` and falls back to
`--generate-notes` for a version with no section. `pnpm lint`, `pnpm typecheck`
and the 594 unit tests are green; `check-pinned-deps` passes. The lockfile
records no importer versions, so the bump cannot affect
`--frozen-lockfile`.

**Not verified, and cannot be from here:** the workflow itself has not run.
Pushing to GHCR, creating a release, the SARIF upload and the SBOM step all
need GitHub. The two-platform build *was* verified, locally and directly,
because that is the half that was broken. The rehearsal dispatch is there to be
the first thing that exercises the rest.

One difference worth knowing when reading the first run's log: this machine's
Docker backend is `aarch64`, so `BUILDPLATFORM` is `linux/arm64` here and
`linux/amd64` on `ubuntu-latest`. The bug reproduces either way — it is a
mismatch between two stages, not a property of the host — but which pass fails
swaps over, and so does the `qemu-` prefix in the message.

### Aligned with `semantius-app`, which had already solved this

`C:\dev\semantius-app` publishes a multi-architecture image from
`.github/workflows/docker-publish.yml` and has cut **v0.1.0, v0.1.1 and
v0.1.2** through it. Read against this one, it settled three things:

- **It confirmed the repository slug.** `semantius-idp`'s own remote is
  `github.com/semantius/semantius-idp`, so the Dockerfile's
  `org.opencontainers.image.source` label — which said
  `adenin/semantius-idp` — was simply wrong, and this file's earlier note
  calling it "one of them is wrong" is now answered. Fixed. The label is how a
  pulled image says where it came from.
- **It had the piece this repository was missing: `docker/release.sh`.**
  Adopted here, adapted in two ways. A **pre-release is allowed**: that script
  refuses one because its workflow tags `latest` unconditionally, while this
  workflow derives `latest` from whether the version is a pre-release. And a
  **failed `git tag -s` degrades to `-a`** instead of aborting — by that point
  the bump commit has been pushed, so an unusable signing key would otherwise
  leave the branch bumped and the release untagged.
- **Its release body is a better first screen than a bare changelog dump**, so
  the `## Docker image` block with the `docker pull` line is now prepended to
  the notes here too.

Two divergences kept deliberately, both because this workflow is stricter:
its `workflow_dispatch` **pushes** (from a branch, with no semver tag, so it
would move `latest` to a branch build), where this one rehearses; and it
pushes with no gate between build and publish, where this one smoke-tests,
scans and SBOMs the image first.

Their Dockerfiles differ for a real reason, which is why that repository never
hit the bug above: `semantius-app` pins nothing to `$BUILDPLATFORM`, so its
arm64 leg emulates node, pnpm and Vite outright — correct, and slow, as its own
comment says. This image cross-builds the JavaScript on the build platform and
emulates only the runtime stage, which is faster and is exactly what made a
borrowed binary's architecture matter.

### The database was one required URL and should have been two (2026-08-27, **D74**)

Raised by the owner against a sentence in the release notes — "it needs a
Postgres" — which is not what this image needs. It needs **two connection
strings**, and the requirement was on the wrong one.

`database.url` was required; `database.directUrl` was optional beside it. That
is backwards. The **direct** endpoint is the one that must always work:
startup, migrations, the CLI and the cleanup job all take session advisory
locks, and those do not hold through a transaction-mode pooler (**D27**). The
pooled endpoint is an optimisation, and a given Postgres may not offer one at
all. So an operator holding only the direct endpoint had to file it under the
name that describes the pooled one — and one who set only
`DATABASE_URL_ADMIN`, which is the natural thing to do when that is the URL you
have, was **refused outright** for a configuration that works perfectly.

Both keys are optional now, with a `superRefine` requiring at least one and
naming both env fallbacks when neither is present. Each falls back to the
other, resolved once in `derive.ts` as `databaseUrl` / `databaseDirectUrl`, so
a single-endpoint deployment gets the same string for both — correct, because a
plain Postgres endpoint is already direct.

Resolving in `derive.ts` rather than normalising in the loader was the design
call: the published JSON Schema then states what is true — neither key is
required on its own, and `required: ["url"]` is gone from
`config-schema/config.schema.json` — while all six consumers still receive a
guaranteed `string`.

Two things fell out of it:

- **The docs generator would have kept lying.** Its `required` column is one
  boolean per key, derived from `MINIMAL` — the smallest file the schema
  accepts — so it went on marking `database.url` required after it stopped
  being. The generator now renders `one of url / directUrl` for the pair,
  because "either of these two" is not a boolean. Fixing the output instead of
  the generator would have been undone by the next run.
- **`idp config validate` prints the direct endpoint**, but only when it
  differs from the pooled one — a line that repeats itself says nothing.

Verified end to end, not just in unit tests: a config carrying only
`directUrl` validates and resolves it for both roles; a `database` block with
neither is refused with a message naming both keys and both env variables. Five
new unit tests cover directUrl-alone, `DATABASE_URL_ADMIN`-alone, url-alone,
both-distinct and neither. 599 unit tests pass, both generated-file gates are
clean, and `config.example/` still validates.

### What is left for the owner

Only the tag itself. `docker/release.sh v0.1.0` does the rest, and everything
it depends on is verified except the parts that need GitHub.

---

## Owner review round 4 — four findings (2026-08-27, **D69–D72**)

Four things the owner found using the admin area. One commit each, code plus
spec row plus CHANGELOG, per AGENTS.md.

### 1. The first administrator was the only account without the default role (**D69**)

`/setup` stored `adminRoles[0]` and nothing else, while self-registration, the
admin create form and the admin API's own fallback all also assign the role
marked `default: true`. FR-ROLE-1 makes roles downstream labels the IdP
evaluates nothing from, which is precisely why this bit where the IdP could not
see it: an application gating on `user` excluded the person who set the
deployment up. Now the join of both, deduplicated — a catalog whose admin role
*is* the default stores `admin`, not `admin,admin`. **No migration**: an
already-bootstrapped administrator is one checkbox away on `/admin/users/:id`.

### 2. "That e-mail address and password combination is not correct" — in a dialog with no password field (**D70**)

Two bugs feeding each other, from one field report.

`errorCodeFor` ends in `invalid_credentials` because it was written for the
public pages, where SEC-7 requires a wrong password and an unknown address to
be indistinguishable — and **every admin form was using it**. Better Auth
spells the duplicate-address refusal differently on `/admin/create-user`
(`USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`) than on `/sign-up/email`, only the
latter was mapped, and the catch-all owned the rest. That is D57's bug class
again, which is why the fix is a second mapping — `adminErrorCodeFor` — and not
one more `case`. Behind `/admin/*` the collapse buys nothing (the administrator
is looking at a searchable list of every account) and costs the truth.

The compounding half: the set-password link was minted **after** the account
existed, unguarded, so a failure there produced a 500 — and the natural
response to an error page is to submit the same form again, which is a
duplicate, which is what produced the sentence. That tail is wrapped now, an
`ok` answer with no user id is refused rather than minting a link for `""`, and
both land on the list with a notice naming the two recoveries.

The integration tests **pin Better Auth's own identifiers**, so a dependency
bump that renames one fails a test rather than a dialog.

### 3. Success banners outlived what they were about (**D71**)

A confirmation travelled as `?notice=<code>` and **nothing ever removed the
parameter**, so the URL went on asserting that the save had just happened: a
reload re-announced it, Back re-announced it, and a bookmarked
`/admin/users?notice=deleted` announced last week's deletion as news. The eight
admin and account pages show the sentence as a toast and strip the parameter as
they do — `history.replaceState` with `history.state` passed through, not
`router.navigate`, which would re-run the loaders and re-claim the one-shot
handles that `?created=` and `?draft=` siblings have already spent.

Errors stay inline, beside the form and the draft they came back with. The
public auth pages keep their banners, because there the message *is* the page.

Two things to know about the component. It is the shadcn registry's Base UI
`toast`, used verbatim — **including its placement**, which is bottom-right
above `sm` rather than the top-right the finding asked for: the generated file
encodes the anchor in its stacking offsets and in eight enter/exit transforms,
and re-anchoring it is a fork of a file the next `shadcn add` overwrites. And
it cost ~25 kB of client bundle, which brought the 600 kB
`check-client-bundle.ts` ceiling to within 1.2 kB — that ceiling was set
against a ~330 kB bundle and the comment saying so had gone stale, so it is
raised to 750 kB with the measured figure written down. The markers in that
script are what actually catch a server leak; the byte cap is the backstop for
the megabyte incident it was written from.

### 4. An application added here could only be disabled or removed (**D72**)

So a typo in a name, a redirect URI that had moved, or a scope that should not
have been granted meant removing it and adding it again — which revokes every
token and consent it held and hands its operator a secret they did not ask for.
Two house endpoints beside the three that exist, `/idp/update-client` and
`/idp/rotate-client-secret`; Better Auth's own `/oauth2/update-client` stays
unreachable for D50's reasons.

The update is a **full replace**, and four columns are not the body's to write:
`user_id` (a null owner is the file marker, and the next reconcile's orphan
sweep would disable the row — the application would keep working right up until
the restart), `disabled` (whose schema default would switch a suspended client
back on), `created_at`, and the **client id**, which is the natural key four
tables reference. The secret follows the type: staying confidential passes the
stored hash through untouched, so the secret already deployed goes on working;
public → confidential mints one and shows it once; the other way discards it.
Only that flip revokes anything — a rename revokes nothing, matching what
reconciliation does for an edited file entry.

Rotation is deliberately smaller: one column, no lock, no origin refresh, and
**no revocation** — hygiene, not incident response. No grace window in v1, and
the dialog says so before it is confirmed.

#### And it found a test that asserted nothing

D50's "authenticates at the live token endpoint with the secret it handed
back" posted a junk authorization code to `/oauth2/token` and asserted the
answer was not `invalid_client`. **It never could be**: the code is validated
*before* the client credential, so `invalid_grant` comes back for any secret at
all — including one that was never right. The test passed for four months and
proved nothing about R4.

Found because D72's rotation case asserts the *old* secret stops working, and
was told it had not. The oracle is `/oauth2/introspect`, which authenticates
the client and then answers about the token: a wrong secret is `401
invalid_client`, a right one is `200 {"active": false}`. Both halves are
asserted now — the good secret opens the door and a made-up one does not — so
the test cannot go quiet again.

### Two things the end-to-end suite found while verifying the four

Neither is in the plan; both had to be fixed to get a green gate.

**The axe gate was already red, and it took the second deployment shape with
it.** `variant="destructive"` is `bg-destructive/10 text-destructive`, which is
`#e7000b` on `#fde5e7` — **3.98:1**, under R-1's 4.5:1 — so every page with a
destructive dialog trigger failed, starting at `/admin/users/:id`. Confirmed
pre-existing by rebuilding the image at `a74d861` and getting the identical
violation, so it is not this round's doing; status.md's "74 e2e tests passing"
was written before it appeared. It matters more than one red test looks:
`playwright.config.ts` runs the sub-path project *after* the host-root one, so
a single failure there means **half the suite never runs at all**.
`--destructive` is darkened in both themes — light 4.62:1, dark 4.59:1, the
dark pairing having been sitting exactly on 4.50 — with the measurements in
`globals.css`. It diverges from the shadcn preset deliberately; re-applying one
resets it.

**A toast is a `role="dialog"`.** Base UI gives it one, `aria-modal="false"`,
so its close and action buttons are reachable. From D71 that means a bare
`getByRole("dialog")` matches two elements whenever a confirmation is showing,
and Playwright's strict mode fails the test rather than the application. The
helpers export `modal(page)` — `[data-slot="dialog-content"]`, which
`DialogContent` stamps and the toast does not.

### The suite was spending fifty-one of its fifty-four minutes waiting

Asked after the round-4 work: why does a fairly simple server take an hour to
test? It does not. The **test database was the deployment's own Neon instance
in `us-east-2`** — measured at **102 ms per round trip** from here — and the
harness builds a fresh schema per context: `drop schema`, then 77 migration
statements, each its own round trip. That is ~8 s of latency per context before
a single assertion, more than a hundred contexts, all serialised by
`fileParallelism: false`. `admin.test.ts` alone was ten minutes for 33 tests.

Against a Postgres container on loopback the identical suite is **183 s** —
840 tests, same coverage numbers, an 18× difference with no test changed.
`apps/web/scripts/test-database.ts` starts one and reuses it;
`IDP_TEST_DATABASE_URL` still wins, which is how CI keeps the service container
it already had. It is also the safer default: a throwaway container cannot
reach the persistent `idp` schema, and a test schema on the deployment's
database is one typo away from it.

Six advisory-lock tests failed on the first local run, for a reason worth
recording: the test built its own `postgres()` handle and chose TLS with
`url.includes("localhost")`, so a database on `127.0.0.1` was given
`ssl: "require"` and dropped the socket. That is **D57**'s and **D68**'s
`127.0.0.1`-versus-`localhost` trap for the third time, and here it reports as
"Client network socket disconnected", which looks like a network fault.
`testDatabaseSsl()` in the harness now applies the same precedence the
application does.

What was *not* changed: `fileParallelism: false`. The advisory locks are
per-database, so files running concurrently would contend on `bootstrapAdmin`
and `reconcileClients` and the contention tests would stop meaning anything.
With the latency gone it is worth about a minute, and it is not worth that.

---

## "The login page says this address is not recognised" (2026-08-27, **D68**)

Reported from a deployment that does not know its own public URL and sits
behind a reverse proxy. It is **D57**'s refusal again — the CSRF origin check
turning a sign-in away before it reads the password — but permanent rather than
first-run: `server.trustedOrigins` defaulted to `[server.baseUrl]`, so a
deployment that cannot name its public address at configuration time cannot
sign anybody in at all. D57 made that refusal say what it is; it did not make
it avoidable.

The ask was to make the check optional, off by default. It is now **optional
without being off**. With the key unset, the check follows the request: the
browser's `Origin` has to name the address the request arrived on —
`X-Forwarded-Host`, else `Host` — as well as the issuer.

Why that is still a real check, and not a polite way of removing one: a
cross-site page chooses **neither side** of it. `Origin` is set by the browser
from the page doing the posting, and both host headers come from the browser or
from our own proxy — neither is CORS-safelisted, so a cross-site request that
tries to add one is preflighted and this server never answers a preflight. A
caller who *can* set arbitrary headers is not who CSRF protects against: they
have no cookies to ride.

Three deliberate looseness decisions, all in `server/http/request-origin.ts`
with the reasoning beside them:

- **`X-Forwarded-Host` is read whatever `server.trustProxy` says.** That
  setting governs whose *identity* is believed — the audit trail's and the rate
  limiter's client address (`client-ip.ts`) — where a forged value is
  attributed to the wrong person. Here the value is compared and then dropped:
  never stored, never emitted, never used to build a URL. SEC-1 is untouched,
  and the host-header-injection tests still pass unchanged.
- **The scheme is ignored** (`https://host` and `http://host` are both
  produced). A TLS-terminating proxy that forwards over plain http and omits
  `X-Forwarded-Proto` is exactly the deployment this exists for; pinning the
  scheme would fail it for the sake of an attacker who already controls http on
  the deployment's own hostname.
- **A wildcard is refused on the way in.** `URL` happily parses `*` as a
  hostname, and Better Auth matches its allow-list as *patterns* — so an
  `X-Forwarded-Host: *` would have switched the check off for the request that
  sent it. The unit test that says so failed on the first run, which is why it
  is there. From configuration `*` is still accepted: that is the documented
  way to turn the check off, for whoever needs it.

Setting `server.trustedOrigins` pins the check to what it lists, as before.
`[]` reads as "nothing configured", not as "trust the issuer alone" — a
generated or templated config leaves an empty array behind, and reading it as
the stricter thing would surprise in the direction of a locked-out deployment.

### The check was off in every test run this repository has ever made

Found while writing the regression tests, and the more important half of the
day. Better Auth sets `skipOriginCheck` to **true** when `NODE_ENV=test`
(`context/create-context.mjs`), and through its backward-compatibility arm that
takes the Fetch-Metadata CSRF check with it. Both new refusal cases — a
cross-site `Origin`, and a forwarded `*` — **passed a sign-in** until
`advanced.disableOriginCheck: false` was set explicitly in
`server/auth/instance.ts`.

So SEC-3, which the integration suite is written as if it asserts, was not
being exercised anywhere. It is now, and the rest of the suite still passes
with it on — which is itself worth knowing, because it means every test that
posts with a session cookie was already sending a legitimate `Origin`.

---

## Owner review round 3 — sixteen findings (2026-08-26)

The owner walked the running application and filed sixteen findings: config
ergonomics (F1, F2, F4), form UX — modals, client-side validation, input lost
on rejection (F3, F5, F7, F8, F15), small UI defects (F6, F10, F12), a
confusing invite/reset page (F9), an audit-coverage gap (F11), a mid-session
reauth that discards a filled form (F14), and two questions (F13, F16). The
plan is `~/.claude/plans/1-it-s-great-that-linked-bear.md`; per AGENTS.md these
come before anything in Pending.

**The two questions, answered.**

- **F13 — `/.well-known/change-password` is legitimate**, and no code changed.
  It is a registered well-known URI (RFC 8615; the behaviour is the W3C
  "Change Password URL" specification), served by Okta, Google, GitHub and
  Apple, and used by Safari, Chrome, 1Password and iCloud Keychain to offer
  one-click "change this password". It is already a redirect to
  `/change-password` and is listed on `/admin/system` (**D55**).
- **F16 — the permission-denied page stays a page**, not a 404. Masking with a
  404 protects resources whose *existence* is confidential; `/admin` is a
  fixed, documented path (docs/admin-api.md), so a 404 buys nothing and costs
  a signed-in colleague a dead end. The real defect was the status code: FR-ROLE-3
  says 403 and the page rendered with 200.

### What landed

- **The config surface (F1, F2), `D60`.** `config.example/*.schema.json` moved
  to a root `config-schema/`, and the three examples are now `.jsonc`.
- **`site.adminTitle` (F4), `D61`.** Optional; defaults to `site.name`. Two
  things to know: **CFG-5 has no hot reload**, so seeing it takes a restart of
  the running app; and the shipped `config.example/config.jsonc` now says
  `"name": "Semantius"` with `"adminTitle": "User Manager"` — the owner's
  instruction taken literally — which costs the example its deliberately
  neutral "Example IdP" branding. One tracked edit reverses that if it was not
  wanted; the untracked `config/` copy carries the same change.
- **Client-side validation, the seam (F3), `D62`.** `usePasswordConfirm` +
  `ConfirmedPasswordFields` in `components/auth/confirmed-password.tsx`, on all
  three password-and-confirmation forms. The server checks are untouched.
- **The client-registration form (F15), and drafts (`D62`).** The rules moved
  to `lib/client-rules.ts`, shared with the zod schema — *not* by importing
  `server/config/schema/clients-schema.ts` into the browser, which would have
  passed `check-client-bundle.ts` (six marker strings and a size ceiling; zod
  carries none of them) while eroding the seam those markers stand for. The
  carrier for a rejected form is `server/http/draft.ts` over the existing
  one-shot stash, and `ActionDialog` gained `defaultOpen` so the dialog
  reopens. Passwords are never stashed, enforced in the helper rather than by
  each caller.
- **The freshness bounce (F14), `D63`.** Why it happened, for the record:
  FR-AUTH-5 measures freshness from `session.createdAt` and activity must not
  refresh it — `updatedAt` moves on every request and would make every session
  permanently fresh — so fifteen minutes on a twelve-field form is easy to
  spend. The defect was the *order*: the gate ran before the body was read.
  It reads first now and stashes the draft on the stale branch only, with a
  1800 s TTL because the detour may include a second factor. `reauth_draft` is
  its own notice code so the sentence is only shown where it is true.
- **create-user is a dialog, default role ticked (F7 + F8), `D64`.**
  `/admin/users/new` is deleted, with no redirect — only the users page linked
  to it. The POST handler moved to the list route, reads the body before the
  freshness gate, and keeps a draft on refusal. e2e: `admin.spec.ts` drives the
  dialog; the a11y route list lost the page.
- **Change password is a dialog (F5).** The standalone page stays — FR-AUTH-4's
  forced flow and `/.well-known/change-password` both need it — so the fields
  moved to `components/auth/change-password-fields.tsx` and the rules to
  `server/auth/change-password.ts`, leaving each caller with only its own
  destination. e2e: `account.spec.ts` drives the dialog and asserts the notice
  rather than a navigation.
- **Small UI defects (F6, F10, F12).** `SecretDialog` lost its `wrap` prop and
  always wraps — all three call sites wanted it, and the copy button takes the
  value rather than a selection. The clients table column is "Consent required"
  with one affordance for both answers, and the dialog asks "Require consent",
  unticked; `skipConsentFromForm` is the single inversion and has a test on it.
  `/admin/system`'s discovery links open in a new tab — the first
  `target="_blank"` in the tree, and the convention for the admin area.
- **The invite/reset page (F9), `D65`.** The loader's "a lookup would burn the
  token" was wrong for a *read*: `findVerificationValue` is non-consuming and
  is what Better Auth's own GET validator uses. The page names the account and
  decides valid / expired / invalid before rendering a form. "Already used" is
  not a distinguishable state — the row is deleted — so the copy covers both
  and the dead `token_used` mapping is gone. `welcome=1` is the invitation
  variant, set by `createResetLink` at the admin call site.
- **Audit vocabulary and coverage (F11), `D66`.** "user.created is missing" was
  half true: it was recorded as `signup.created` with `by: "admin"`. Looking
  turned up three endpoints that wrote nothing when called directly, one event
  written twice, and one declared and never written at all. `guard.ts` owns
  `/admin/*` auditing from here on; that ownership is in D66 because the
  three-way drift is what produced all of it.
- **403 on the admin refusal (F16).** Spec-compliance with FR-ROLE-3, so no
  amendment. `setResponseStatus(403)` in `routes/admin.tsx`'s loader behind
  `import.meta.env.SSR` and a dynamic import — Vite eliminates the branch from
  the client build — and **not** inside `fetchAdminGate`, which would stamp
  403 on the RPC response during a client-side navigation.

### What the browser found in this round's own work

Two of the sixteen fixes were themselves broken, and only the TST-6 suite could
have said so. Both are worth remembering, because the shape of each recurs.

**`setResponseStatus` does not reach a rendered page.** The 403 for FR-ROLE-3
typechecked, ran, and changed nothing. Start's helper works for a server route
and for a server function; an SSR document is built by `renderRouterToStream`
with `status: router.stores.statusCode.get()`, and the router puts only 404 (a
`notFound()`), 500 (an errored match) or 200 in that store. There is no
supported way for a loader to ask for a third value, so the status is left on
the request context this application already owns — `setDocumentStatus`,
first-writer-wins — and `server-entry.ts` applies it, but only when the render
came back with the default. Every other gate in this repository would have
called the first attempt green: it is the one that reads a real document
response that did not.

**A field's `id` was its `name`.** Unique in a form, and emphatically not in a
document. Moving the password change into a dialog gave `/account/security`
three fields called `password` — the new one and the two the second-factor
forms ask for — so `<label for="password">` resolved to whichever came first
and named the wrong control. Playwright reported it as "the field is not in the
dialog"; a screen reader would have reported the same thing, and the a11y scans
did not catch it because each label *does* point at a real control, just not
its own. `TextField` and `PasswordField` derive the id with `useId()` now.

A third was caught by reading Better Auth's source rather than by a test:
`/admin/stop-impersonating` declares no session middleware, so the audit row
the new "Stop impersonating" control exists to produce would never have been
written. See D66 and `admin/guard.ts`.

### The follow-up that should not have been one (**D67**)

D66's handoff recorded a parity gap instead of closing it: called directly,
`/admin/revoke-user-sessions` did not revoke OAuth tokens, so the sentence in
`docs/admin-api.md` — "signs them out everywhere" — was false for every caller
that was not the button. The reasoning for deferring it was that D66's scope
was what gets *recorded* rather than what an endpoint *does*. That was the
wrong trade: the promise was false in the meantime, and the change is fifteen
lines.

Why it was ever split: Better Auth's admin plugin deletes `session` rows and
has no idea this deployment issues tokens, so the OAuth half has to belong to
somebody — and it had been written into the **route handler behind the
button**. A `curl`, a script or an admin API key does not go through a route
handler. It lives in `buildAdminAfterHook` now, which is a Better Auth `after`
hook and runs for every caller, exactly as D66 did for the audit row.

The regression test posts to the endpoint with no route handler in the call at
all. Reverted against the old code it fails with two live refresh tokens, which
is the bug; with the fix it reports none.

---

## Two bugs the owner found in ten minutes of using it (2026-08-26, **D57–D58**)

Both were reported together, and they had been dressing each other up: the first
made a correct password look wrong, and the second made the recovery from it
look broken too. Both are fixed and both are reproduced below, because neither
was visible to any gate in this repository.

### "I created a user, but at login the password was not accepted" (**D57**)

It was not the password. Better Auth's CSRF middleware refuses a post whose
`Origin` is not in `trustedOrigins` — which defaults to `server.baseUrl` alone —
**before** it looks at a credential, and `errorCodeFor` had no case for
`INVALID_ORIGIN`. It fell through the default arm into `invalid_credentials`,
and the page said the e-mail and password combination was not correct about a
request in which no password was ever checked.

Reproduced on a throwaway schema (`idp_repro_login`, dropped afterwards), same
config, same code:

| request | before | after |
| --- | --- | --- |
| correct password, matching origin | `/account` | `/account` |
| wrong password, matching origin | `error=invalid_credentials` | `error=invalid_credentials` |
| **correct password, `Origin: 127.0.0.1`** | **`error=invalid_credentials`** | `error=untrusted_origin` |

The server log said `Invalid origin: http://127.0.0.1:3211` on the line above
while the page said the password was wrong, so the log and the screen actively
contradicted each other. The default `baseUrl` is `http://localhost:3000`, so
`127.0.0.1:3000` is all it takes — and the same refusal takes out the first-run
wizard's automatic sign-in, which is why it strands the *first* account a
deployment ever creates: it silently becomes `/login?notice=account_created`,
and then that login fails too.

`untrusted_origin` now carries its own catalog string naming what is actually
wrong. SEC-7 is untouched: the caller chose the origin and already knows it, and
it is a fact about the configuration rather than about any account.

### "I ran `pnpm drizzle:reset` and the setup page does not come back" (**D58**)

It does not, and `lock_timeout` is why nobody expected that. **D56** set it so a
running dev server would produce a sentence instead of a hang — but an idle
connection holds no table lock, so the drop simply succeeds. The server then
keeps running against a schema that is no longer there, and the first-run gate
memoises `false` for the life of the process (**D52**, on the reasoning that a
deployment cannot go back to having no users while it is running, which is the
exact invariant this script breaks). So `/` and `/login` go on serving the
sign-in page, and every request underneath throws — which is what the owner's
`INTERNAL_SERVER_ERROR` on `select … from "idp"."session"` was.

Reproduced exactly, with the server left running through the drop:

```
Tables        18
Connections   2 other — restart whatever is using this database afterwards
Dropped schema "idp_repro_login".
→ /  307 → /login          (stale process)
→ /  307 → /setup          (after a restart)
```

The script now counts other backends on the database next to the table count and
closes by saying **restart**, not start. Counted rather than refused on: this
script's own pool can open a second backend and a pooler holds idle ones after
the process behind them is gone, so a refusal would fail on a false positive.
The memo is left alone deliberately — a process whose schema was dropped is
broken in every direction, and restarting is the answer to all of it rather than
to the wizard alone.

### "…and an error which did not show in the UI ?!?" (**D59**)

Reported as an aside to the two above, and it is the reason the second one was
so hard to read from the outside. `readSession` ended in `.catch(() => null)`,
so **a session that could not be read and a session that is not there were the
same answer**: an anonymous visitor, redirected to the sign-in page. With the
schema gone, Better Auth logged `Failed query: select … from "idp"."session"`
and the screen showed an ordinary login form — the log and the UI describing
different worlds, and the operator left to conclude they had been signed out.

The discriminator is Better Auth's own rather than a guess: `dispatch` converts
a refusal into an `APIError` and rethrows everything else untouched, so a driver
or query failure arrives as a plain `Error`. Those, and any `APIError` that is
itself a 5xx, now propagate to the error boundary; a 4xx — expired, revoked,
banned — still answers `null`, because that caller does belong on the login
page. `src/tests/unit/read-session.test.ts` pins all three.

The cost is accepted deliberately: a transient database failure that used to
look like a sign-out now looks like a failure. That is the honest trade, and the
old behaviour hid every outage on the one code path whose whole job is to say
who the caller is.

Two smaller things rode along: the wizard's button says **"Create first admin
account"** rather than "Create the first account", and the seven server
functions still calling `createServerFn().inputValidator()` now call
`.validator()`, so `pnpm dev` no longer opens with seven deprecation warnings.

---

## `pnpm drizzle:reset` — the reset that was only ever a sentence in a runbook

Asked for after round 2, and the smallest thing here that removes a whole class
of incident. Migrations are forward-only (DM-1) and there is no seed step, so
"give me a clean database" has always meant `drop schema … cascade` — written
out by hand in the integration harness, the S4 spike, the upgrade-rollback
runbook, and in AGENTS.md's instruction to drop the schema to get `/setup`
back, each time against whatever connection string the shell was holding.

[`apps/web/scripts/reset-database.ts`](apps/web/scripts/reset-database.ts) is
that statement, aimed by the configuration the app itself loads: it drops
`database.schema` on `database.directUrl`, refuses `public`, and touches
nothing else in the database (DM-4, Q16). `pnpm drizzle:reset` from the root,
`--yes` for a script, `--schema <name>` for a throwaway, `--migrate` to leave
it rebuilt rather than absent. The next `pnpm dev` or `pnpm docker:up` migrates
it back empty and serves the first-run setup page, so the account that comes
out of it is the one **D52** intended.

Three deliberate choices, recorded as **D56**:

- **Not an `idp` CLI command** (OPS-6 is unchanged). The CLI ships inside the
  container; a one-word command there that destroys the deployment is a hazard
  with no upside, and the person who wants a clean database is in a checkout.
- **The target is printed, then the question is `[y/N]`.** Configuration
  folder, masked connection string, schema, table count — then "Drop schema
  "idp" and everything in it?", defaulting to no. The block is what tells you
  which database you are pointed at; the prompt stays a yes-or-no question. A
  non-TTY without `--yes` refuses rather than assuming.
- **`lock_timeout` is set before the drop.** A running dev server holds the
  locks `DROP SCHEMA … CASCADE` needs, and the failure mode without it is a
  command that hangs silently — the same defect as R-7, in a new place.

Verified against a throwaway `idp_reset_check` schema, dropped afterwards
(P0'.2): the non-TTY refusal, `--yes --migrate` on an absent schema (both
migrations applied, 18 tables), the drop of the populated schema, and the
`public` and unknown-argument guards. The persistent `idp` schema was not
touched. `pnpm lint` and `pnpm typecheck` are green.

---

## Review results

### Round 2 — owner review, 2026-08-25 (**D53–D55**)

The owner walked the running application — first-run setup, sign-in, the admin
area — and filed thirteen findings. One secret leak, several functional
defects, three questions, and "polish every page to shadcn standards". They
were taken as pre-work, ahead of anything left in Pending, per AGENTS.md.

The three questions, answered:

- **6, the underlined header links.** Deliberate code, and inconsistent:
  "Your account" was an underlined `<a>` and "Sign out" a bare underlined
  `<button>`, in the same row as six pill-tab navigation links — three kinds of
  affordance side by side. Both are now ghost buttons at the nav's size, in
  both shells.
- **11, the "Signing key" on the System page.** The page never showed key
  material and could not: `/idp/system` selects `id`, `createdAt` and
  `expiresAt` from `jwks`, and nothing anywhere reads `privateKey`. What it
  showed was the `kid`, which is what FR-ADMIN-2 asks for. Only the label was
  wrong, and it is now "Active key ID".
- **12, the one visible password.** Not a false alarm — a real leak, and the
  first thing fixed. See below.

What changed, in the order it was done:

1. **`database.directUrl` was printed unmasked.** Masking is positional by
   design — a new secret key has to be added to a list, which is the review
   prompt the file's own comment describes — and the key added by **D27**/
   **D48** never was. Worse, the password-only masker for connection strings
   was reached by a literal `pointer === "/database/url"`, so the omission was
   invisible twice over. Both pointers now go through a two-member set, and
   the masker also learnt about a password carried as a query parameter
   (`?password=`, `?sslpassword=`), which libpq accepts and which no amount of
   userinfo masking touches. **Blast radius, corrected:** only
   `/admin/system`. `maskConfig` has exactly one caller; `idp config validate`
   prints its own fixed seven-line summary whose one connection string is
   `database.url`, already masked. `mask.ts`'s own header claimed both, and had
   been wrong about it since before this round — that is fixed too.
2. **The password minimum is 10** (**D53**), and the two places that ignored
   `auth.password.minLength` now read it.
3. **The first-run wizard requires both names and asks for the password twice**
   (**D54**). Its validation moved into `server/admin/setup-form.ts`, so the
   rules can be asserted without a runtime.
4. **Five registry components added** — `spinner`, `field`, `native-select`,
   `textarea`, `empty` — verbatim, with `@typescript-eslint/no-unnecessary-condition`
   turned off in `packages/ui` for `field.tsx` rather than patching it. The
   same `add` run re-fetched `label` and `separator`, which `field` imports,
   and moved a `"use client"` directive from the first to the second. Registry
   output, not a hand-edit — recorded so the next `add` does not read as a
   regression.
5. **Every form says it is working.** `PendingForm`/`SubmitButton` across all
   forty-one forms. Two mechanics are load-bearing and are commented as such: the
   double-submit guard is a **ref**, because a `setState` is not visible until
   the next render; and the visual state is deferred by one animation frame,
   because the browser builds the form entry list *after* the submit handler
   returns — a synchronously-disabled submitter would have dropped
   `/consent`'s own `decision=allow`.
6. **Timestamps render in the browser's locale and timezone**, which is what
   FR-I18N-1 always said. One `<LocalTime>` replaces seven ad-hoc UTC slices in
   the admin area — three different precisions — and, across three call sites
   in the account area, two configured-locale `Intl` helpers — the latter under a comment asserting the
   opposite of the spec. The first paint stays deterministic UTC, labelled,
   because formatting on both sides of hydration is how a page tears.
7. **Admin-registered OAuth clients no longer all demanded consent.** The
   create handler sent `skipConsent: false` from a checkbox that did not exist,
   and a *defined* `false` beats the schema default of `true`. `enableEndSession`
   had the same shape — but there the always-false bug was accidentally
   load-bearing, because the client schema refuses `enableEndSession` with no
   post-logout URI, so that checkbox defaults **off** while `skipConsent`
   defaults on.
8. **The impersonation control is hidden when impersonation is off**, reversing
   the note that used to sit on `ui.allowImpersonation`.
9. **The System page lists the discovery URLs** (**D55**). Under a sub-path
   that is four URLs, not two: each metadata document has an issuer-relative
   form *and* an origin-root one, and `Caddyfile.subpath` rewrites both of the
   latter — RFC 8414 §3.1 defines the OAuth spelling and enough clients ask
   for the OpenID one that the reference proxy serves it too. Listing only the
   RFC 8414 root form, which is where this landed first, would have sent an
   operator running a different proxy away with half the rules they need.
10. **The design sweep.** The `SecretDialog` copy button had been pushed
    outside the popup by an unbreakable `whitespace-pre` `<code>`: the row was
    a grid item, and a grid item's default `min-width: auto` refuses to shrink
    below its content. The Actions sidebar stretched to the main column's
    height and the grid distributed the surplus *between* the buttons — hence
    the "odd spacing"; it is `self-start` inside a Card now, grouped by what
    each entry does. Fourteen hand-rolled card surfaces are gone — some to
    `AdminCard`, which also subsumes a local `Section` helper, the rest to the
    kit's `Card` directly; `AuthShell`, `AccountSection` and `Stat` moved onto
    `Card` too; six hand-rolled selects became `NativeSelect`; eighteen
    `grid gap-1.5` groups became the kit's `Field`. The admin shell's own
    `Field` — a `<dt>/<dd>` pair — was renamed `DetailRow`, because two things
    called `Field` in one file is how a definition row ends up wrapping an
    `<input>`. The roles page gained FR-ADMIN-2's last-reconcile timestamp and
    warnings, which had been specified and never rendered. The sweep also
    surfaced a defect of its own: the registry dialog popup is
    `fixed top-1/2 -translate-y-1/2` with no max-height and no overflow, so
    the client-create dialog became unusable the moment it grew the fields it
    had been missing — its submit button hung below the viewport with nothing
    to scroll. Capped and made scrollable in `apps/web`'s `ActionDialog`,
    never in `packages/ui`.

### Round 2, the review of the review

A subagent reviewed the finished change set against AGENTS.md, the plan and
the spec. It found one gap that mattered and a run of overstated prose; both
are fixed above and the numbers in this section are now measured rather than
carried over from the plan.

- **The discovery list was half of what the shipped proxy serves.** It emitted
  RFC 8414's origin-root form and not the OpenID Discovery one — but
  `Caddyfile.subpath` rewrites *both*, and D55 exists precisely so an operator
  on a different proxy can see which rules they need. Listing one of two would
  have sent them away with half. Fixed, with the unit test that had asserted
  the *absence* of a second entry inverted to require it, and the sub-path e2e
  project now checks both.
- **The leak's blast radius was overstated.** See finding 1 above: it was
  `/admin/system` only.
- **The rAF rationale described a mechanism this code does not use.** The
  comment said a synchronously-disabled submitter would drop its name/value
  from the entry list — true of a native `disabled`, and `focusableWhenDisabled`
  means Base UI never emits one. The frame is kept and the comment now says
  why: the obvious future simplification is to drop `focusableWhenDisabled`,
  and that is the day `/consent` would start posting no decision at all.
- **`/admin/roles` was about to show the wrong warnings.** It rendered
  `runtime.warnings` — configuration-load problems, already on two other pages
  — while the one warning that is genuinely roles-versus-database drift went
  only to the log. `runStartup` now returns it and the page shows that
  instead.
- **`/setup` did not trim the e-mail** while the amended FR-ADMIN-1 said it
  did, and `EMAIL_SHAPE` rejects whitespace — so a pasted address with a
  trailing space was refused as malformed, on the one form that cannot be
  reached twice.
- **`maskConnectionString` only ever masked userinfo.** libpq's URI form also
  accepts `password` and `sslpassword` as query parameters. Now masked by
  name, for the same reason the pointer list is positional.
- **`/admin/index.tsx` had been missed by the sweep** — the admin landing page,
  still carrying the heading-outside pattern `AdminCard` exists to replace.

Two things the plan assumed and the code did not bear out, both recorded here
because the next reader will assume the same:

- **`impersonateDisabled` is not a dead string.** The endpoint still refuses a
  POST that arrives while impersonation is off, and that refusal maps to it.
  It stayed, with a comment saying so.
- **The setup-form rules could not become integration tests.** The validation
  lives in a route `server.handlers` POST, which the integration harness — a
  Better Auth instance, not an HTTP server — cannot reach. Extracting it to
  `setup-form.ts` and asserting it as a unit is the same coverage at a lower
  cost, and it is why that file exists.

### Round 1 — owner review, 2026-08-25 (**D48–D52**)

Fourteen owner findings and an accompanying security / spec-completeness pass,
all landed. Five of them changed a signed-off requirement, so each carries a
decision number; the rest were mechanical or corrective. What follows is the
part worth keeping: what changed, and why the obvious alternative was not it.

#### The env bootstrap is gone (**D52**) — the largest of them

`IDP_ADMIN_EMAIL` / `IDP_ADMIN_PASSWORD` created the first administrator, a
forced change consumed that password at the first sign-in, and the operator was
told to unset both variables afterwards. Nobody does. That instruction is the
recorded root cause of this deployment's one credentials incident, and
`idp reset-admin` existed only because the account it created could strand
itself the moment its password was forgotten.

**Both are removed.** While the `user` table is empty, `/` and `/login` lead to
`/setup`, which collects e-mail, first name, last name and a password and makes
that person the first administrator — signed in, no forced change, because the
person who chose the password is the person using it.

Three things about the gate are deliberate:

- **It is "no users", not "no admin".** A deployment that lost its last
  administrator must not be able to mint one from an unauthenticated page, so
  the page closes for good the moment any account exists. A "no admin" gate
  would have been a privilege-escalation path dressed as a convenience.
- **The empty-table check is re-run inside the `bootstrapAdmin` advisory lock**,
  on the direct connection. Two browsers submitting at once is the ordinary
  race; the loser is told the deployment is already set up and creates nothing.
  `setup.test.ts` runs exactly that race.
- **The answer is memoised in one direction.** `false` is never re-queried —
  `/` and `/login` are the two busiest pages a signed-out visitor loads — while
  `true` is re-read every time, because it is about to become false. The
  integration harness resets it per file, since one process runs every file
  against a different schema.

The cost is real and accepted: lockout recovery now needs database access. In
order — a second administrator, the password-reset e-mail, or the one SQL
statement in [docs/runbooks.md](docs/runbooks.md#promoting-a-user-when-nobody-can-sign-in).
In exchange, no deployment has a password sitting in a file somebody meant to
delete.

#### Whole connection strings (**D48**)

Compose used to build the application's `DATABASE_URL` out of
`POSTGRES_PASSWORD`, and Postgres read the same password from
`secrets/postgres_password`, so one value lived in three places and all three
were mandatory — even for a deployment pointing at Neon, which uses none of
them. Now `.env` holds whole connection strings and `env_file` passes them
through untouched. `DIRECT_DATABASE_URL` became `DATABASE_URL_ADMIN` (a clean
break, no alias; the config key `database.directUrl` is unchanged), and the
docker `secrets:` block is gone.

D43's protection survives the move, which was the one thing to check: a value
read from `env_file` cannot be overridden by whatever happens to be exported in
the shell that ran `docker compose`, so a host `DATABASE_URL` still cannot walk
into the container. The pin list in `environment:` shrinks to the two variables
that decide *which configuration* and *which schema*.

#### `docker/`, and scripts that say what they do (**D51**)

Nine deployment files at the repository root made the root listing a deployment
folder with a source tree in it. They are in `docker/` now — Dockerfile,
`Dockerfile.dockerignore` (BuildKit's per-Dockerfile ignore, which CI already
honours because it builds with buildx), both compose files, both Caddyfiles —
with a `.cmd`/`.sh` pair per verb copied from the `pgrest` conventions:
`idp-create`, `idp-start`, `idp-stop`, `idp-status`, `idp-logs`, `idp-cli`,
`idp-destroy`.

`idp-create` bootstraps `.env` **and** `config/` from the shipped examples, so
a clean checkout is one command. That last part forced a small decision:
`config.example/oauth_clients.json` declares two clients whose secrets come from
required placeholders, so a freshly copied config folder refused to load. The
throwaway values now ship in `.env.example` — both clients redirect to
`app.example.com`, so they are unusable by construction, and CI has always
invented the same values for its own validation of that folder.

#### The display name is derived (**D49**)

`user.name` was a free-text field on three forms. Two people typing "Jane
Smith" and "Smith, Jane" produce a user list that cannot be sorted and a `name`
claim that means two different things. It is now composed from the captured
first and last name in `site.nameFormat` order, everywhere one is written —
sign-up, first-run setup, admin create, admin edit, the account page (read-only
there), and the social profile mapping.

The social half has one restraint worth naming: a provider that ships only
`name` — GitHub — keeps the name it sent. Deriving from a split we invented
would be guessing at somebody's surname.

#### Clients can be registered from the admin area (**D50**)

The page was read-only for a good reason: a change there is one the next
restart would silently undo. That reason applies to **file** clients, and the
mechanism that keeps them apart already existed — reconcile's orphan sweep is
scoped to `user_id IS NULL`, so a row with an owner has never been an orphan.
Admin-registered clients simply carry the creating administrator's id.

Two things were checked rather than assumed before building it:

- **No restart is needed.** The provider's `getClient` falls back to a database
  lookup for ids outside `cachedTrustedClients` (verified in the installed
  `@better-auth/oauth-provider` dist), so a new client works on the next
  request. `cachedTrustedClients` and `clientPrivileges: () => false` are
  untouched, and Better Auth's own client CRUD stays dead.
- **One real gap.** `clientOrigins()` fed both CORS and the CSP `form-action`
  list from the configuration file alone, so a database client's login would
  have failed in Chrome — the authorization completes, the redirect back is
  cancelled, and nothing in the log names an origin. That is the D46 failure
  again, from a new direction. The set is now file ∪ **enabled** database
  clients, cached in the process and refreshed at start-up and by every
  mutation.

#### Secrets stopped travelling in URLs

The generated API key rode back as `?created=<secret>` and the set-password
invite link as `?link=<url>`. Both are now stashed server-side and claimed by
the landing loader, which consumes them — the repository's own `one-shot.ts`
header had been arguing for exactly this since the 2FA enrolment used it.
Claiming once is what makes "shown once" true rather than aspirational: a
reload shows the page without the value.

#### Two FR compliance gaps, found by the completeness pass

- **FR-ADMIN-2's "edit (name, e-mail, verified flag)" had no implementation.**
  The only `/admin/update-user` call in the tree set `mustChangePassword`. There
  is now an `edit-profile` action, in a dialog, with the name derived per D49.
- **FR-SIGNUP-5's first and last name were missing from admin create**, which
  still asked for a single free-text `name`.

#### Everything else

Administration and account areas link to each other (the admin area had no way
back out but the address bar); the user-detail actions became named controls
that open dialogs, so "delete this account" asks rather than fires; roles are
checkboxes from the catalog instead of a comma-separated field an administrator
had to spell from memory; the clients page became a table; and the audit page
resolves actors and targets to display names in one batched query per page,
shows the `targetType` it had always fetched and never rendered, and keeps the
full ids in tooltips. One writer that recorded an API-key revocation against
the *user* rather than the key was corrected, so the same event has one shape.

The security pass found nothing else: admin gating (route gate plus an
authoritative per-server-function re-check), `safeReturnTo`, the reconcile
scoping, the advisory-lock discipline and the CSP posture were all verified
sound and left alone.

---

## The spec debt, paid

The convention is that a spec amendment rides the commit that makes it true.
For M12 and M13 it did not, so `spec-v1.md` stood at **D38** while the tree had
moved past it in seven places. All seven are written now, and none of them
changed a line of code: every amendment describes behaviour that already ships
and is already tested.

**D30 was reserved and never filled in.** It is the capture transport. With the
env-only `IDP_EMAIL_TRANSPORT=capture` set, each message is written to
`IDP_EMAIL_CAPTURE_DIR` (default `/tmp/idp-mail`, the image's only writable
path) as one JSON file instead of being sent, and the Playwright run mounts
that directory and reads the verification and reset links out of it. Both
variables joined CFG-3's env-only list; TST-1 now says how the e2e layer gets
its mail, and that there is no HTTP surface for it. The amendment carries the
reason it is not a `config.json` key: a file key is a durable, copy-pasteable
way to turn a production deployment into one that silently swallows every
password-reset e-mail.

**OPS-6 and FR-ADMIN-1 named a command that never shipped.** `idp create-admin`
is `idp reset-admin`, and correcting the name was the smaller half. **D42**
records what the command refuses to do, which is the part an operator needs:
it never promotes an account that holds no admin role — otherwise a local
command with database access would be a one-line privilege escalation — and it
creates only `admin.bootstrap.email`, never an address typed on the command
line, so a typo cannot quietly provision a second administrator.

**DM-2 and DM-5 were two tables short.** `oauth_client_assertion` and
`pending_authorization` are both in the generated schema and both in the
cleanup job's sweep, and were in neither inventory. DM-2 now lists the
seventeen tables DM-1 has always claimed, `pending_authorization` among them
with D33's note that nothing writes to it and it is purged regardless.

**D39–D44** are the six decisions M12 and M13 made in passing and never wrote
down: the build-only Vite `base` (**D39**), an explicit `sslmode` beating the
not-localhost heuristic while `prefer` and `allow` are ignored (**D40**), `azp`
on a key-issued JWT coming from the api-key gate's `Symbol.for` marker rather
than the session's token type (**D41**), `reset-admin`'s two refusals
(**D42**), the four `docker-compose.yml` pins that decide *which* database and
*which* configuration (**D43**), and `site.logo` accepting both `logo.svg` and
`branding/logo.svg` (**D44**).

---

## M14 — the documentation, and the two things it found

DOC-1 through DOC-4, and the release checklist. Nine files, one of them
generated:

- **[docs/configuration.md](docs/configuration.md)** — every key of
  `config.json`, generated from the zod schemas by
  `apps/web/scripts/generate-config-reference.ts`, with `--check` in CI so a
  default cannot change without the documentation following it. Writing the
  generator meant giving **twenty-eight keys a `.describe()` they never had**,
  which improves the editor JSON Schemas by the same stroke.
- **[README.md](README.md)** — DOC-1 in full: what it is and is not, the quick
  start, configuration, roles, clients, the well-known endpoints, proxying,
  e-mail, social, Neon, security notes, operations, troubleshooting,
  development, versioning.
- **[docs/neon.md](docs/neon.md)** (DOC-2), **[docs/clients.md](docs/clients.md)**
  (DOC-3, with the explicit no-M2M note), **[docs/admin-api.md](docs/admin-api.md)**
  (FR-ADMIN-6), **[docs/runbooks.md](docs/runbooks.md)** (DOC-4),
  **[docs/release.md](docs/release.md)** (TST-7's manual checklist and the real
  Neon validation), **[SECURITY.md](SECURITY.md)**,
  **[CONTRIBUTING.md](CONTRIBUTING.md)**, **[CHANGELOG.md](CHANGELOG.md)**.

### Writing it down found two more things

Neither is dramatic, and both are the ordinary result of checking a claim
before making it.

- **The reference deployment pointed at an image that is never published.**
  `docker-compose.yml` and `.env.example` defaulted to
  `ghcr.io/adenin/semantius-idp`; CI pushes to `ghcr.io/${{ github.repository }}`,
  which is `ghcr.io/semantius/semantius-idp`. A `docker compose up` with no
  `IDP_IMAGE` would have tried to pull something that does not exist.
- **TST-1's example-config gate did not exist.** The gate list has always
  included "example-config validation" and CI has never run it. It does now:
  `idp config validate` against `config.example/`, which is the folder the
  quick start tells an operator to copy. It passes.

### The quick start, checked rather than asserted

DOC-1 asks for a quick start CI keeps honest. What CI actually covers is now
stated precisely rather than sweepingly: the example folder is validated on
every pull request, and `scripts/smoke-test.ts` brings the same compose stack
up against the image that would be published, signs in through the forced
password change, and verifies a token against the JWKS.

Running the documented commands by hand also turned up something worth a note
in the README rather than a fix: copy `config.example` and change the port, and
start-up refuses, because the example's first-party client has a redirect URI
on `localhost:3000` and a `firstParty` client must be on the issuer's own
origin. The refusal is correct and says exactly that; the README now warns
before the reader meets it.

---

## M13 — the browser found fourteen things

The milestone is what TST-6 asks for: flow specs for every interstitial and
every page of the account and admin areas, an axe pass over all of them, a
sample relying party the suite drives, and a CI job that runs the lot against
the built image in both deployment shapes.

What it is *for* is the paragraph below. Fourteen defects, none of which any
other gate could see, because every other gate in this repository reads HTML,
JSON or a database row — and each of these needed a browser to follow a
redirect, apply a policy, or render a page.

**Three of them made a documented feature simply not work.**

- **The e-mail verification link did nothing.** It pointed at
  `/verify-email?token=…` — the page that *reports* the outcome, which has no
  way to spend a token. Every self-registered account stayed unverified, and
  with `auth.requireEmailVerification` on that means it could never sign in.
  The link now goes to the endpoint that consumes the token, with a
  `callbackURL` back to the branded page; the page reads Better Auth's refusal
  codes so an expired link still says so.
- **No OIDC login could resume through an interstitial (FR-OIDC-9).** The
  provider signs the authorization request and lists the signed parameter names
  in a **repeated** `ba_param` key. The page carried the request back using
  `location.searchStr`, and Start does not keep the bytes it received — its
  serialiser writes a repeated key as one JSON array, so the string never
  matched its own signature. `/oauth2/continue` answered 400, the resume was
  abandoned, and the user landed on `auth.defaultRedirect` looking like a
  client that had asked for nothing. `readOauthQuery` now rebuilds the query
  from the parsed search, which restores the values the verifier actually
  reads.
- **`form-action 'self'` made every OAuth login impossible in Chrome.** A
  completed authorization is a 303 *from a form* to the client's redirect URI,
  and Chromium applies `form-action` to the redirect a submission follows, not
  only to where it is posted. The navigation was cancelled with `ERR_ABORTED`:
  the browser sat on a filled-in sign-in form while the server had already
  issued the authorization code, and the only trace was a console refusal.
  Firefox does not check redirects, which is how it survived every manual
  walk-through. The directive now allows the registered redirect origins —
  FR-OIDC-17's list, nothing wider — recorded as **D46**.

**Four were the page telling the user something untrue.**

- **Saving your profile appeared to do nothing.** `/account` read the
  cookie-cached copy of the user, so the redirect after a save re-rendered the
  name that had just been replaced. The cached cookie Better Auth re-mints on
  `/update-user` was also being dropped instead of replayed.
- **"Sign out everywhere else" did not sign anyone out** for up to five
  minutes — the same cookie cache, against a requirement (FR-OIDC-12,
  "revocation is immediate at all IdP endpoints") that the sessions page states
  in its own description. `fetchProfile` is authoritative now, which is what
  `functions/admin.ts` had already decided for the same reason.
- **A suspended account was told its password was wrong.** Better Auth's admin
  plugin has a ban check of its own that runs ahead of this deployment's gate
  and answers `BANNED_USER`; unmapped, it collapsed into
  `invalid_credentials`. Both codes reach `/banned` now, and the page is given
  the reason and expiry from the ban record — wording it has always had and was
  never given (FR-ADMIN-4).
- **Pagination did nothing.** `/admin/users` and `/admin/audit` had no
  `loaderDeps`, so a client-side link to `page=2` moved the URL and left page
  one on the screen. The GET forms worked, because a form submits as a real
  navigation, which is why nothing had noticed.

**Three were RP-initiated logout, which nothing had ever driven.** FR-OIDC-11
had no behavioural test at all before this milestone, and all three of its parts
were broken at once (**D47**): the route skipped the provider entirely when no
`id_token_hint` was present, so the signed confirmation cookie it depends on was
never minted; `/sign-out` then posted the original request back to
`/oauth2/end-session`, which asked the same question again rather than
completing anything; and when the provider does decide to ask, its own
unbranded `<h1>Confirm logout</h1>` reached the browser instead of this
deployment page. The GET is forwarded now, an HTML answer becomes a redirect to
`/sign-out` **carrying the provider's `Set-Cookie`**, and that page posts
`action: "confirm"` to the endpoint which actually finishes the logout.

**Four were quieter, and two of those were about the record.**

- **Turning two-factor authentication on or off sent no e-mail.** The template
  has existed since M6 and nothing ever called it (FR-MAIL-1) — and this is the
  message whose whole purpose is to reach someone when it was not them who
  turned it off.
- **Changing a password from `/account/security` sent nothing either.**
  `onPasswordReset` covers the reset path and only the reset path.
- **Every confirmed e-mail address was audited as a failure.** `ctx.redirect()`
  builds an `APIError` and the endpoint *throws* it, so the after-hook read
  "threw" as "failed" — and the verification endpoint redirects only on the
  success path. An audit trail that reports every success as a failure is worse
  than none (SEC-6).
- **The active entry in the account navigation was styled as an inactive one.**
  `activeProps.className` is appended rather than merged, so
  `text-muted-foreground` and `text-foreground` sat at equal specificity and
  whichever Tailwind emitted later won. It was the muted one — which is also
  why axe reported the contrast failure that found it.

**And one was spec debt rather than a defect.** Discovery advertises
`{baseUrl}/.well-known/jwks.json` as `jwks_uri`, while FR-OIDC-15 still called
`/api/auth/jwks` canonical. The code is right — FR-OIDC-16 lets a deployment
publish only `/.well-known/*` for Neon to reach, and a `jwks_uri` under
`/api/auth` would advertise a key set that deployment cannot serve. Recorded as
**D45**; DOC-2 now names the advertised URL.

### What the suite is

`apps/web/e2e/`, run by Playwright against the built image in two projects —
host root and `/idp` behind Caddy — with one compose stack each, a generated
config folder and its own Postgres, so a run can never touch the operator's
stack or the persistent `idp` schema.

- **`actions.ts`** — sign in, register, open a link out of the captured mail,
  complete a forced change. Written against the rendered page rather than the
  endpoints underneath: a helper that signed in with `fetch` would keep working
  the day the form stopped submitting.
- **Flow specs** — `auth`, `signup` (which restarts the container to drive
  sign-up on/off and approval on/off, and puts the configuration back),
  `password-reset`, `two-factor` (real RFC 6238 codes from the integration
  suite's own implementation), `account`, `admin`, `oidc`, plus the `rendering`
  gate M13 already had.
- **`a11y.spec.ts`** — `@axe-core/playwright`, pinned exactly, zero serious or
  critical violations on every public, account and admin page. This is R-1's
  automated half; the manual half stays in the release checklist.
- **`sample-rp.ts`** — `Bun.serve` and `openid-client`, discovery through
  code + PKCE to a displayed token, plus RP-initiated logout. DOC-3 points a
  reader at this file, so the suite drives **that file**, run the way the
  documentation says to run it, rather than an `openid-client` instance built
  inside a test.
- **CI** — a merge-required `e2e` job that builds the image and runs both
  projects, uploading traces only when something fails.

---

## The sign-in page had no CSS, and nothing could tell

**Reported by the owner as "the login page is unbranded".** It was, and not
only the login page: under `vite dev`, *every* page had been arriving with no
stylesheet, no client entry and no hot reload. What made it look like a
branding bug rather than a total one is that the server-rendered markup was
perfect — the site name, the layout, every Tailwind class name, all present.
Only the paint was missing.

**Cause.** `vite.config.ts` set `base: "./"`, which spike S3 chose so that one
build relocates to any mount path. Vite 7 and earlier coerced a relative base
back to `/` for the dev server; Vite 8.0.16 does not, and prefixes every
transform URL with `/./` instead. A real path survives that — `/./src/router.tsx`
still resolves against the root, which is why the app itself kept working — but
Vite's own URLs are recognised by their `/@` prefix and do not:

```
vite:resolve  /./@fs/C:/…/packages/ui/src/styles/globals.css  ->  null
```

`/@fs/…`, `/@id/…` and `/@vite/client` all resolved to null, fell through to
the application router, and came back as its 404 page — behind a stylesheet
link that looked perfectly well-formed. **Fixed** by making the relative base a
*build* concern only: `base: command === "build" ? "./" : "/"`. The built output
is unaffected — `dist/server` still emits `"./assets/globals-<hash>.css"`, which
is exactly what `assetUrl()` rewrites onto the mount path — so S3's sub-path
property is untouched, and that was checked by building rather than by
reasoning.

**Why no gate caught it, which is the more important half.** Every gate here
reads HTML or JSON. `test:e2e` has been declared-but-inert since M1, there is
no `playwright.config.ts`, and not one test had ever asked a dev server for an
asset. The markup assertions all passed because the markup was right.
`src/tests/integration/dev-server.test.ts` is the missing gate: it starts a real
Vite dev server and fetches `/@vite/client` and the stylesheet, asserting the
second is `text/css` containing compiled Tailwind. Putting the old config back
makes all three of its cases fail, which was checked rather than assumed.

That closes the specific hole. **The general one is still open:** nothing in
this repository renders a page in a browser and looks at it. That is M13's job
(TST-6 plus axe), and this is the second time a purely visual defect has
shipped past a green board — R-1 was the first.

---

## M12 — the container milestone, and the seven things it found

**M12 is complete.** The image builds, `docker compose up` brings up a working
IdP, both Caddyfiles validate, all seven OPS-6 commands run inside the
container, and TST-8's smoke test drives the whole thing end to end.

### What landed

- **OPS-4 draining** (`server/http/lifecycle.ts`, `src/serve.ts`). Shutdown is
  split into the two things it actually is: *stop being chosen* — `/readyz`
  answers 503 the moment SIGTERM lands — and *stop holding*, where the pool
  closes only once the in-flight requests have finished. Releasing at signal
  time is the mistake the split exists to prevent: it turns a rolling deploy
  into a burst of 500s. A second signal exits at once; `/healthz` keeps
  answering 200, because a container draining on purpose is not one to restart.
  `shutdownRuntime()` closes a runtime **only if one was built** — the obvious
  `getRuntime().then((r) => r.shutdown())` would run the whole OPS-2 sequence,
  migrations included, on the way out of the door.
- **All seven OPS-6 commands.** `config validate` (no database — an operator
  whose config is wrong may not be able to reach one), `migrate`,
  `reconcile-clients`, `reset-admin`, `rotate-keys`, `cleanup`, `version`.
  Verified inside the image: `docker run <image> idp config validate` prints
  the issuer, the masked connection string, the counts and the warnings.
- **The retention job** (`server/cleanup.ts`, OPS-8/DM-5). Nine tables, each
  purged on the question *is this row still capable of doing anything* rather
  than on age. Two deserve naming: token rows wait **30 days after death**
  because a revoked token still in the table is the answer to "was this revoked
  or did it never exist", which is the first question anyone asks after a leak;
  and `jwks` is purged at expiry **plus the grace period**, never at expiry,
  because a retired key still verifies tokens signed before it stepped down.
  The interval job schedules the next run when the last one *finishes*, so a
  slow sweep cannot stack.
- **`routes/branding.$.ts`** (CFG-1) — the operator's logo and favicon out of
  the read-only config mount, written as a series of refusals rather than
  transformations, because it is the one place a URL becomes a path on disk.
- **The image, compose, both Caddyfiles, the smoke test and the CI job.**
  118.9 MiB against OPS-13's 300 MB ceiling.

### The seven things running it found

The first four came out of the smoke test, in the order it runs, and none of
them is visible to any unit or integration test. That is the argument for TST-8
in one sentence: every one would otherwise have been found by the first person
to follow the README.

1. **`env_file: .env` sent the operator's own database into the container.**
   The worst of the set. `DIRECT_DATABASE_URL` is a bootstrap fallback for
   `database.directUrl` — the connection *every advisory-locked step* uses:
   migrations, the signing key, the client reconcile, the bootstrap admin. A
   developer's `.env` has it pointing at their real database, and compose
   passed it straight through, so the container **served from the compose
   Postgres while migrating somebody else's**. It happened here, on the first
   run that got far enough: the direct handle reached a production Neon
   endpoint. It was refused — the derived SSL mode did not match what Neon
   requires — and the persistent `idp` schema was checked afterwards and is
   untouched: one user, migrations dated the previous day, no audit row from
   the run. `DIRECT_DATABASE_URL` and `IDP_SCHEMA_NAME` are now pinned in
   `environment:`, which wins over `env_file`.
2. **`IDP_CONFIG_DIR` leaked the same way**, and is the same fix. `.env` says
   `./config` — a *host* path — so the container looked for its configuration
   at a directory that does not exist inside it and restart-looped with
   "Required file not found at C:/…/config/config.json".
3. **`serve.ts` was copied into the image as TypeScript source.** It imports
   across `src/`, and the final stage has no `src/`, so every start died with
   `Cannot find module './server/config/loader'` — while the container was
   reported only as "unhealthy". Both entrypoints are bundled now.
4. **The reference deployment could not have worked at all.** `database.ssl`
   defaulted to `require` for any host that is not literally localhost —
   correct for a hosted database, wrong for compose, where the host is
   `postgres` on a private network. Every operator following the quick start
   would have hit `Client network socket disconnected before secure TLS
   connection was established`, which names nothing they could act on, against
   a URL that had said `sslmode=disable` all along. An explicit `sslmode` is
   now honoured ahead of the heuristic. `prefer` and `allow` deliberately are
   not: they mean "try, then downgrade", and reading either as "disable" would
   silently drop TLS on a hosted database because a URL was copied from
   somewhere.
5. **`/readyz` knew why it was failing and said nothing.** Its `catch` was
   bare, so a stack whose start-up was failing reported `config: false` for as
   long as you cared to watch, with no line anywhere naming the cause — which
   is how finding (1) took as long as it did. It now logs the reason once per
   distinct message: the response stays non-revealing (it is unauthenticated),
   the log does not.
6. **The `jwks` purge bound a `Date` into a raw SQL template** and postgres.js
   refused it — the identical mistake that cost M10 a 500 on the whole
   dashboard. Subtracting the grace period from `now` instead of adding it to
   the column is the same inequality with no raw SQL at all.
7. **`site.logo` had two spellings and one of them 404s.** The schema describes
   a path *under* `branding/`; the shipped example has always shown
   `branding/logo.svg`. Both name the same file, so both now resolve to
   `/branding/logo.svg` rather than one of them producing
   `/branding/branding/logo.svg`.

### What is deliberately not here

`docker-compose.dev.yml` (the plan calls it optional) and the arm64 leg of the
build on pull requests — arm64 is emulated in CI and roughly triples the build
for an artefact nobody merges, so tags build both and PRs build amd64.

**The SIGTERM path is now genuinely exercised** — the smoke test stops the
container and asserts the exit code is 0 rather than 137. On Windows it still
cannot be: `uv_kill` maps SIGTERM to `TerminateProcess`, so a developer machine
can never run it, which is why `tests/unit/lifecycle.test.ts` covers the
ordering with fakes as well.

Smoke test, against the built image: ready in **0.38 s** (budget 5 s), idle RSS
**202.7 MiB** (budget 256), image **118.9 MiB** (budget 300), clean exit on
SIGTERM. All sixteen checks green.

### `idp reset-admin`, and the two things it refuses

It resets the named administrator's credential password back to
`admin.bootstrap.password`, re-arms `mustChangePassword`, makes the account
reachable again (active, unbanned, verified) and deletes every session — all
under the `bootstrapAdmin` advisory lock, so it cannot race a booting
container. The password is never printed, logged or written to the audit trail.

Two refusals, both deliberate and both tested:

1. **It does not promote.** An address that exists and holds no admin role is
   refused. A local command that promoted whatever it was pointed at would be a
   one-line privilege escalation for anyone who can read the config folder.
2. **It does not create an address you typed.** With no argument it will create
   `admin.bootstrap.email` — that is the bootstrap contract, and running it
   against a fresh database is an intended path. But
   `idp reset-admin adnim@example.com` fails rather than quietly provisioning a
   second administrator. Found by running it: the first version created one.

Proof is `src/tests/integration/reset-admin.test.ts`, which lives through the
whole incident — create, sign in, change the password to something only the
operator knows, lose it, reset, sign in again with the `.env` value.

### The `azp` discriminator, deferred from M10 and now fixed

`sessionTokenPayload` decided "did this come from an API key?" with
`typeof session.session.token !== "string"`. In 1.7.1 the api-key plugin puts
the **key string** there, so the test was always false: every key-issued JWT
claimed `azp: "idp"`, and `apiKeys.tokenClientId` was configuration that did
nothing. It stayed invisible for two reasons, not one — `tokens.test.ts`
asserted the behaviour the bug produced, *and* the test config left
`tokenClientId` at its `"idp"` default, so that assertion would have passed
whichever way the discriminator went.

The answer now comes from `isApiKeySession`, reading a marker
`options/api-key-gate.ts` stamps on the session it watched the plugin build —
the one place in the process that knows. The marker is a `Symbol.for` key for
two reasons that both matter: `JSON.stringify` ignores it, so `/get-session`
answers exactly what it answered before; and no request body, database row or
parsed JSON can ever produce a symbol, so a caller cannot claim to be an API
key by sending a field. `azp` is authorization-relevant, so that second
property is pinned by its own unit test.

`tokens.test.ts` now sets `tokenClientId: "api-key-client"` and asserts both
halves — the key exchange carries it, and the same endpoint reached with a
session cookie carries `"idp"`.

---

## M13, the first half — the browser gate exists now

**The hole this closes is the one this session opened with.** Nothing in the
repository had ever rendered a page and looked at it, which is how a sign-in
page with no stylesheet survived four milestones of a green board.

`apps/web/playwright.config.ts` drives the **built image** — not `vite dev` —
in two projects, because a sub-path deployment is a different application as
far as every URL is concerned:

- **host-root** — the image on `:3410`;
- **subpath** — the same image behind Caddy at `/idp` on `:3411`, using
  `Caddyfile.subpath` through `docker-compose.e2e.yml`.

Both stacks are brought up by `e2e/stack.ts` with generated config folders and
their own Postgres volumes, so a run cannot touch the operator's stack or the
persistent `idp` schema (P0'.2).

`e2e/rendering.spec.ts` is the gate itself. It asserts **computed style and
layout**, never screenshots: how many CSS rules the browser actually parsed
(a `<link>` that 404s still appears in `document.styleSheets` with zero rules,
so counting sheets proves nothing), that the shell is a flex column, that the
heading is not the browser's default 32 px, that the input has a radius, that
every asset URL sits under this deployment's own base URL, and — by tabbing to
the reveal control and pressing Space — that the page hydrated at all. A pixel
baseline would fail on font rendering, get updated without being read, and stop
meaning anything by the third time.

**The sub-path deployment has now been driven end to end for the first time**
and works: `/idp/login` serves with `/idp/assets/…` URLs, and the origin-root
RFC 8414 route answers at `/.well-known/oauth-authorization-server/idp`.

### D30, and two things the harness itself got wrong

**D30 — the capture transport writes files.** `IDP_EMAIL_TRANSPORT=capture`
(environment-only, CFG-3's env-only class) swaps Resend for a transport that
writes each message to `/mail` as JSON, which the e2e overlay bind-mounts out
of the container so a spec can read a verification or reset link. Files rather
than an HTTP endpoint, because an endpoint that returns captured mail is an
endpoint that returns password-reset links and it would exist in the shipped
image. It is honoured **only when e-mail would otherwise work**: capturing in
degraded mode would make FR-MAIL-2's "nothing is sent" untestable.

Two harness defects, both found by running it:

1. **The sub-path project was testing the wrong URL.** `page.goto("/login")`
   resolves the way `new URL` does — an absolute path replaces the base's whole
   path — so against `http://127.0.0.1:3411/idp` it requested the *origin root*,
   which under a sub-path deployment belongs to somebody else's application.
   The failure read "no Password field", which is a confusing way to learn the
   test was wrong rather than the deployment. An `app.goto()` fixture now
   applies the mount path, and a leading slash cannot get it wrong again.
2. **Clicking the reveal checkbox is not how anyone uses it.** The checkbox is
   `sr-only`; the eye icon painted over it intercepts the click, exactly as it
   would for a person. Driving it from the keyboard asserts the two things R-1
   asked for at once — reachable in the natural tab order, and the accessible
   name changes with the state.

### What was left of M13

The flow specs, axe, the sample relying party and the CI job — all of which
landed, and all of which are described in the section above.

---

## S3–M8: what those sessions did, and what they broke open

Four milestones landed in plan order: **S3** (one build, two mount points),
**M6** (2FA + social enforcement), **M7** (the account area, API keys, the
freshness gate) and **M8a/b/c** (client reconciliation, tokens and claims, the
issuer-root protocol surface). Each is described in its own commit message.

**Eleven defects were found by running things rather than reading them**, which
is the same lesson Phase 0 recorded:

|          |                                                                                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S3-1** | Better Auth was unreachable under a sub-path — 1.7.1 appends `basePath` to `baseURL` only when `baseURL` has no path, so the issuer mounted everything at `/idp/*` and nobody could sign in |
| **S3-2** | Nothing emitted `<link rel="icon">`, so browsers probed `/favicon.ico` at the _origin_ root — someone else's application under a sub-path                                                   |
| **M6-1** | The audit trail called a 2FA challenge a completed sign-in                                                                                                                                  |
| **M6-2** | `?forced=1` was never true: the router parses query values with `JSON.parse`, so the forced-password-change page had been rendering the ordinary screen                                     |
| **M6-3** | Declaring `validateUserInfo` made Better Auth refuse every user creation without an endpoint context — the bootstrap admin died at start-up                                                 |
| **M6-4** | `syncProfile` mapped to nothing, so the documented default of refreshing a social profile never happened                                                                                    |
| **M7-1** | An API key kept working after its owner was banned or un-approved                                                                                                                           |
| **M7-2** | The freshness gate read the cookie cache, so a twenty-minute-old session could mint an API key                                                                                              |
| **M7-3** | `/account/security` put 200 KB of Drizzle and the whole schema in the browser bundle                                                                                                        |
| **M8-1** | Every session JWT was born expired — `jwt.expirationTime` took a number as an absolute `exp`, so `GET /api/auth/token` returned tokens that expired in 1970                                 |
| **M8-2** | `/.well-known/security.txt` served "Welcome to Bun!", and a GET to `/oauth2/token` served the sign-in page with a 200                                                                       |

Two spike conclusions turned out to be wrong and are recorded as decisions:

- **D32** — S1/S5 planned to normalise `aud` in the `jwt.sign` seam. That seam
  does not exist for a self-hosted key set: the `jwt` plugin refuses to
  construct with `jwt.sign` unless `jwks.remoteUrl` moves the keys off the
  deployment. `aud` keeps the implicit userinfo audience the provider appends
  for `openid`, and FR-OIDC-6 is read as membership rather than string
  equality — which is how every RFC 7519 §4.1.3 verifier reads it anyway.
- **R11 was never spiked**, and reading 1.7.1 confirmed the hazard: a rotated
  key signs immediately, before any verifier has seen it. `rotate-keys.ts`
  publishes first and signs an hour later.

One thing the provider gets wrong is normalised rather than accepted:
`/oauth2/revoke` answers 400 for an unknown token where RFC 7009 §2.2 requires
200, which would let the endpoint be used as an oracle for which tokens exist.

---

## M9 and M10, and the seven defects they turned up

**M9 — the interrupted authorization.** `/oauth2/authorize` now runs a gate
chain before it forwards: sign in, approval, suspension, forced password
change, in that order, each returning to the authorization it interrupted.

The design changed once it met the library. The plan assumed a
`pending_authorization` table keyed to a cookie; 1.7.1 already carries the whole
request in the interstitial page's query string, signed with the server secret
and stamped with an expiry, and takes it back at `/oauth2/continue`. So there
is no store, no handle and nothing to sweep — and `pending_authorization` stays
in the schema, unused. Removing it would be a migration for no gain; M12's
cleanup job purges it either way. **That is a deviation from the plan, recorded
rather than hidden.**

What _is_ ours is driving the resume. The provider also resumes automatically
whenever a request carrying the signed query sets a session cookie — one gate
too few, because a user with a temporary password gets a session on sign-in and
would receive an authorization code before the forced change. Verified live.

**M10 — the admin surface.** Better Auth's admin plugin does the writes; what
this milestone adds is the deployment's own rules in front of them
(`server/admin/invariants.ts`, enforced by a `before` hook so the admin API and
the admin UI are refused the same things), the five endpoints the plugin has no
equivalent for, and eleven pages. Every button posts to its own route, through
Better Auth, so nothing bypasses the guard or the audit trail.

The whole surface was walked in a browser against a throwaway schema
(`idp_live_m10`, dropped afterwards; the ephemeral bootstrap password never
touched the persistent `idp` schema).

### The defects, all found by running things

1. **`base: "./"` and every knob it broke** — recorded in the S3 note.
2. **The admin API refused API keys (FR-ADMIN-6).**
   `getAuthoritativeSessionFromCtx` re-reads the session past the cookie cache
   by setting `context.session = null` and reading the cookie again. An API-key
   caller has no cookie: the api-key plugin built their session in a `before`
   hook, and the authoritative read threw it away. Every admin endpoint
   answered 401 to exactly the callers FR-ADMIN-6 exists for. The gate now
   falls back to what the hooks resolved — and puts it back, or every later
   hook sees an anonymous request.
3. **The last-admin refusal gave advice nobody could follow.** The self rules
   were checked first, so the only administrator on a deployment who tried to
   demote themselves was told to "ask another administrator". With two
   administrators the last-admin rule does not apply at all, so that message
   was _only ever_ shown to the one person for whom it was wrong. The
   last-admin rule now goes first.
4. **`/idp/admin-stats` answered 500 to everyone.** A bare column beside
   `count()` with no `group by`; Postgres refuses it. Nothing said so until the
   endpoint was actually called.
5. **The whole dashboard answered 500.** A raw ``sql`${col} >= ${date}` ``
   template binds the `Date` with no type for the driver, and Postgres will not
   compare it with a `timestamp`. Drizzle's `gte` does it correctly — and was
   already used, correctly, three files away.
6. **`sessionCookie()` in the test harness took the first match.** Impersonation
   clears the current session before setting the new one, so the first
   `session_token` header is the `Max-Age=0` deletion. The test sent an empty
   token and was told it was not signed in — an hour spent at the wrong end of
   `/admin/impersonate-user`. It now takes the last live one.
7. **An administrative create ignores the `status` it is given.** Not a defect —
   `database-hooks.ts` forces admin-created users active on purpose
   (FR-SIGNUP-2) — but it means a test cannot manufacture a pending user, and
   the approval test now registers one through `/sign-up/email` like a person.

### One thing noticed and deliberately not changed

`buildSessionClaims` decides "did this come from an API key?" with
`typeof session.session.token !== "string"`. In 1.7.1 the api-key plugin sets
`token` to the key **string**, so that test is always false: `azp` is always
`idp` and `apiKeys.tokenClientId` is dead configuration. `tokens.test.ts`
asserts `azp === "idp"` for a key exchange with a comment endorsing it, so the
_behaviour_ is the one that was chosen — but the discriminator and the config
option both claim otherwise. **Left for M11**, where the token surface is
already being revisited; changing token claims mid-M10 would be re-opening a
decision another block made and tested.

---

## M11 — security hardening, and the four things it found

**Headers and the request log.** `server/http/security-headers.ts` puts the
SEC-4 set on every response and `no-store` on the four endpoints that must
never be cached. The CSP concedes `script-src 'unsafe-inline'` because Start
streams framework scripts with no seam for a nonce — recorded as **D36**, with
the rest of the policy written so that concession is contained.

`server/http/request-log.ts` is the SEC-5 line that no milestone had yet
created. It mints a request id at the edge, keeps it in an `AsyncLocalStorage`
for the length of the request, and prints it — so **`audit_log.request_id`,
which has been a column since M4 and empty ever since, is now filled in**. An
event in the trail and a line in the log can finally be put side by side.

Both live in `src/server-entry.ts` rather than `src/serve.ts`, so `vite dev`
gets them too and a developer is not looking at a different application from
the one that ships.

**Rate limits and the client address.** `server/http/client-ip.ts` implements
rightmost-untrusted-hop over `server.trustProxy`, v4 and v6, with 20 unit tests
written from the attacker's side. SEC-2's named endpoints get stricter buckets
through Better Auth's `customRules`; the per-client-id half of the
`/oauth2/token` rule could not be expressed there and is implemented over the
same table instead (**D37**).

**`auth.password.breachCheck` now does something.** Schema'd since M2, wired
now: k-anonymity against Have I Been Pwned, five hex characters on the wire,
padding requested, three-second timeout, and a failure never blocks a password.
Off by default, and DOC-4 has to say that enabling it adds one egress origin.

### What running it turned up

1. **`safeUrlForLog` only redacted at the host root.** It matched
   `/oauth2/` and `/api/auth/` as _prefixes_, so the moment `server.baseUrl`
   grew a path every authorization code would have gone into the log
   (OPS-10). Now matched anywhere in the path — and widened to cover
   `/reset-password`, `/verify-email` and the pages that carry the signed
   `oauth_query`, each of which is a bearer credential in a query string.
2. **The audit trail recorded a spoofable address.** Two call sites read
   `X-Forwarded-For` straight off the request, which is the attacker-controlled
   end of the list. They now pass nothing and the audit writer falls back to
   the address the edge resolved under `server.trustProxy`.
3. **Every caller shared one rate-limit bucket in standalone mode.** With
   `trustProxy: false` the previous code set `ipAddressHeaders: []`, leaving
   Better Auth unable to resolve any address at all — it said so in a warning
   at every boot and nothing had picked it up. Fixed by **D38**.
4. **429s carried a header nothing honours.** Better Auth answers with
   `X-Retry-After`; no browser and no HTTP client does anything with it. The
   edge now copies it onto `Retry-After`.

`security.test.ts` is the TST-5 suite: 22 cases, all written as attacks —
forged `Host`, mass assignment, unregistered redirect URI, PKCE downgrade,
wrong and missing secrets, code replay, uniform answers, cookie attributes, the
approval gate, and a spoofed `X-Forwarded-For` that must not escape the limiter.

Headers verified live on `/login` and `/consent`, the log line and its
redaction verified live, and the request id verified reaching real audit rows —
all against `idp_live_m11`, dropped afterwards.

---

## The dev login (P0'.1) — recoverable now, one command away

> **Superseded by D52 (2026-08-25).** `pnpm reset-admin` no longer exists: the
> command and the bootstrap account it recovered were removed together. The
> stranded dev login is resolved by dropping the persistent `idp` schema — the
> next boot serves the first-run setup page. The section below is kept as the
> record of what the situation was and how it was reasoned about.

**The persistent `idp` schema's bootstrap admin is still stranded**, exactly as
the plan's P0'.1 describes: someone completed the forced password change from
VS Code's embedded browser on 2026-08-24 with a value recorded nowhere, and
`must_change_password` is still true, so the account demands a change that
needs the password nobody has.

Nothing in this session touched it, and nothing needed to. Every live check ran
on a **throwaway schema** created from the same `.env` and dropped afterwards
(`idp_spike_s3`, `idp_live_m6`, `idp_live_m7`, `idp_live_m8a`, `idp_live_m8c`) —
which is what the standing rule asks for and what the runtime-schema machinery
(D27/D29) exists to make cheap. Two supporting changes, both in the gitignored
`config/` folder and therefore uncommitted:

- `config/config.json`'s `database.schema` is now `"${env:IDP_SCHEMA_NAME:-idp}"`,
  so a throwaway schema is one environment variable away;
- `config/oauth_clients.json` now exists with two development clients
  (`dev-web`, `dev-spa`), so the reconcile step has something to do and the M13
  sample RP has a client to use.

**This no longer needs a schema drop, and it no longer needs a decision from
you.** `pnpm reset-admin` is the recovery: it puts the password back to
whatever `.env`'s `IDP_ADMIN_PASSWORD` says, re-arms the forced change, and
ends the stale session. Nothing is destroyed — the user row, its audit history
and its id all survive, which the drop would not have managed.

Against the persistent schema, with no environment override:

```
pnpm reset-admin
```

Then sign in with `IDP_ADMIN_PASSWORD` and choose a new password when the
forced-change page asks. The `drop schema idp cascade` option is retired, and
M14's README lockout section is written around this command instead.

**It has not been run against the persistent `idp` schema.** Every exercise of
it in this session used throwaway schemas (`idp_test_reset_admin_*` from the
integration suite, `idp_cli_check` for the CLI itself, dropped afterwards), per
the standing rule — the one command whose whole purpose is to change a
persistent credential is not one to fire unannounced.

---

## Phase 0 — done, and what it turned up

The three review findings are fixed. Four more problems surfaced while fixing
them, all of which were shipping.

**Your three:** R-1 the reveal control · R-2 the schema-generator premise ·
R-3 the post-login destination. Nothing outstanding from any of them.

**Found on the way, in the order they appeared:**

|         |                                                                                   |
| ------- | --------------------------------------------------------------------------------- |
| **R-4** | The whole server was in the browser bundle, and hydration was dead on every page  |
| **R-5** | The forced password change never ended — the bootstrap admin was trapped for ever |
| **R-6** | Two gates that were green only because nobody ran them                            |
| **R-7** | The advisory-lock timeout never worked; a blocked start would hang, not fail      |

Every one was found by _running_ something rather than reading it: opening the
app in a real browser, signing in end to end against a live server, running the
CLI, running the coverage command. None would have been caught by another pass
over the code.

### R-1 · Password reveal control looks unfinished (FR-ACCT-2, WCAG 2.1 AA)

**Where:** `apps/web/src/components/auth/form-parts.tsx` → `PasswordField`.
Affects `/login`, `/signup`, `/reset-password`, `/change-password`.

**What is wrong:** the reveal is a full-width underlined text link reading
"Show password" / "Hide password" sitting _below_ the input — three of them
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
_after_ the password field with a visible ring, and the accessible name changes
with state. Verified in a real browser, not only in a test.

The toggle flips the input `type` from a `change` handler. Two mechanism notes
worth keeping, because both contradict what the code used to assume:

- Tailwind v4 compiles `peer-checked:` to `:where(.peer):checked ~ *`, a
  **sibling** combinator, so it cannot reach the icons inside the label. Those
  use `group-has-checked:` (`:where(.group):has(:checked) *`). The same hook
  masks the input, which is what lets the checkbox sit _after_ it in the DOM
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

|                    |                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `@better-auth/cli` | **deprecated** — _"Package no longer supported"_, last at 1.4.21                                                          |
| **`auth`**         | the current CLI, **1.7.1**, bins `auth` and `better-auth`, depending on `better-auth@1.7.1` and `@better-auth/core@1.7.1` |

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
   `database.schema` is a _runtime_ value (CFG-4, D27), so the schema module has
   to be a `createAuthSchema(schemaName)` **factory**. The CLI emits constants
   with the name baked in. If it cannot be made to emit a factory, the custom
   generator survives — but for _that_ reason, stated honestly, not the version
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
Compared as Drizzle _table objects_ — `getTableConfig()` over every column,
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

|               | ours (before)                        | `auth generate`           |
| ------------- | ------------------------------------ | ------------------------- |
| `required`    | `if (field.required)`                | `attr.required !== false` |
| date defaults | `.toString().includes("new Date()")` | the same test             |

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

_It is broken now._ Sign-in redirects to
`safeReturnTo(form.returnTo, APP_ROUTES.account)` — and `/account` does not
exist until M7. **A successful sign-in today lands on a 404.** Only the
bootstrap admin escapes it, because `mustChangePassword` diverts to
`/change-password`, which is why this was not caught: the one account used to
test the flow is the one account that never reaches the default.

_It is unconfigurable._ `/account` is the wrong destination whenever the IdP is
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

**Note on ordering:** this is worth doing _before_ M7. It removes the 404 by
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
server's _code_ was, and nothing on any page could hydrate.

**Why it happened.** A TanStack Start route `loader` is isomorphic: it runs on
the server for the first paint and in the browser on every client-side
navigation. So a top-level `import { getRuntime }` in a route file pulls the
entire IdP into the client graph — even though only the loader touches it.
Every route did exactly that, `__root.tsx` included. A `server.handlers` block
_is_ stripped from the client build, which is why the POST handlers were fine
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
crosses a size ceiling. Each marker is also asserted to be _present_ in the
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
only seam that fires after the write succeeds _and_ carries both `providerId`
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
  ⚠ The _second half_ of this finding — that the CLI was unusable — **was
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

## Not done (the release)

The manual social walk-through, one real Neon token, and the tag. Everything
else has landed — see **Pending** at the top.

Accepted deviations, unchanged: `drizzle.config.ts` sits in `apps/web/`
because drizzle-kit resolves paths relative to itself; `.agents/skills/` is
committed tooling.

**`test:e2e` is no longer inert.** `pnpm --filter web test:e2e` drives the
built image in a browser, in both deployment shapes. That was the gap that let
a sign-in page with no stylesheet pass every gate for four milestones.

Deviation **D33**, unchanged: `pending_authorization` is generated into the
schema and never written to — 1.7.1's signed continuation makes the store
unnecessary. See the M9 section above.

`src/serve.ts` is the `Bun.serve` wrapper spike S3 needed — static files out of
`dist/client` with the mount path stripped — and now also carries M12's OPS-4
signal handling. The SEC-5 request log and the SEC-4 headers live one layer
down in `src/server-entry.ts`, so `vite dev` gets them too. In the image both
it and the CLI are **bundled**, not copied as source: the final stage has no
`src/`.

---

## What responds today

|                                                                                                                    |                                                       |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `/`                                                                                                                | ✅ 307 → `/account` when signed in, `/login` when not |
| `/login` `/signup` `/two-factor` `/change-password` …                                                              | ✅ 200                                                |
| `/account` `/account/security` `/account/sessions` `/account/api-keys` `/account/consents`                         | ✅ 200                                                |
| `/healthz` `/readyz`                                                                                               | ✅ 200                                                |
| `/.well-known/openid-configuration`                                                                                | ✅ 200 — issuer-root URLs, no `/api/auth` anywhere    |
| `/.well-known/oauth-authorization-server`                                                                          | ✅ 200                                                |
| `/.well-known/jwks.json` `/api/auth/jwks`                                                                          | ✅ 200, byte-identical, ETag + `max-age=300`          |
| `/.well-known/change-password`                                                                                     | ✅ 302 → `/change-password`                           |
| `/.well-known/security.txt`                                                                                        | ✅ 200 with a file in the config folder, 404 without  |
| `/robots.txt`                                                                                                      | ✅ 200, disallow all                                  |
| `/oauth2/authorize` `/oauth2/token` `/oauth2/userinfo` `/oauth2/introspect` `/oauth2/revoke` `/oauth2/end-session` | ✅ 200 / 405 by method                                |
| `/admin/*`                                                                                                         | ✅ 200 for an administrator, 404 otherwise            |
| `/branding/*`                                                                                                      | ✅ 200 from the config folder, 404 for anything else  |

**A full authorization-code + PKCE flow works end to end**, verified against a
live server on a throwaway schema: authorize → code → token (ES256, `kid`,
`typ: at+jwt`, `iss` byte-equal, user claims, `no-store`) → userinfo. The CORS
matrix answers four different ways depending on the endpoint and origin.

What is still missing from the OIDC surface is _interaction_: the consent
screen, the pending-authorization continuation and the end-session
confirmation page are M9. `/oauth2/end-session` forwards today but has no
confirmation page for the no-hint case.

---

## Milestone table

| #    | Milestone                                         | Status                                                                                |
| ---- | ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| M1.0 | Amend spec for D24–D26                            | ✅ done                                                                               |
| M0   | Spikes S1, S2, S3, S4, S5                         | ✅ done — S3's verdict is in [docs/spikes/s3-sub-path.md](docs/spikes/s3-sub-path.md) |
| P0   | Phase 0 — review fixes + M5.5 backfill + CI       | ✅ done                                                                               |
| M1   | Toolchain baseline                                | ✅ done                                                                               |
| M2   | Configuration system                              | ✅ done                                                                               |
| M3   | DB, Better Auth skeleton, migrations              | ✅ done                                                                               |
| M4   | Startup, bootstrap admin, audit, e-mail, i18n     | ✅ done                                                                               |
| M5   | Password auth, sign-up & approval                 | ✅ done                                                                               |
| M6   | Social + 2FA                                      | ✅ done                                                                               |
| M7   | Account self-service + API keys                   | ✅ done                                                                               |
| M8   | **OIDC core**                                     | ✅ done — a, b and c                                                                  |
| M9   | Authorize UX: continuation, consent, end-session  | ✅ done                                                                               |
| M10  | Admin UI + API                                    | ✅ done                                                                               |
| M11  | Security hardening                                | ✅ done                                                                               |
| M12  | Container, compose, Caddy, CLI, ops               | ✅ done — image, compose, both Caddyfiles, all seven CLI commands, cleanup job, TST-8 smoke |
| M13  | E2E, sample RP, a11y                              | ✅ done — 68 tests in both shapes: flows, axe, the sample RP, and a merge-required CI job |
| M14  | Docs & release — **including the README (DOC-1)** | ✅ written — the release itself waits on owner sign-off |

`README.md` is **DOC-1, in M14**. It currently carries a minimal
getting-started and first-sign-in section; the full DOC-1 README — features,
architecture, generated configuration reference, provider setup, runbooks,
troubleshooting — is still to come.

---

## Commits

This session, newest first:

```
8d4937b docs(m14): the README, the guides, and a generated configuration reference
787f888 docs(status): head, and the M13 commits
dde07bf feat(m13): a browser, and the fourteen things only a browser could see
5385535 docs(status): the spec debt is paid, and Pending starts at M13
fd5aa4b docs(spec): the seven amendments M12 and M13 never wrote
781afdc docs(status): one Pending section, and the spec debt it was hiding
19ed39a docs(status): head, and the M13 commits
004ac26 feat(m13): the browser gate, and the sub-path deployment nobody had driven
b0c9641 docs(ops): make the resolved SSL mode visible, and stop naming a command that never existed
fb0e5a1 feat(m12): the image, and seven things that only running it could find
94a0ae7 docs(status): point the handoff at the commit it describes
22db5a3 fix(dev): the sign-in page had no CSS, and no gate could see it (+ M12 lifecycle)
cffdc65 feat(security): headers, the request log that never existed, and real rate limits (M11)
1c56e9f feat(admin): the admin surface, and the rules Better Auth has no opinion about (M10)
c0d8d8e feat(oidc): interstitials that resume the authorization (M9)
e030111 feat(m8c): the protocol endpoints move to the issuer root
d46433e feat(m8b): tokens that say the same thing whichever endpoint minted them
0e09f43 feat(m8a): the client file becomes the database, and the R4 risk dissolves
c8edfc2 feat(m7): the account area, API keys, and a re-authentication gate
c759412 feat(m6): the second factor, and social identities that stay in their lane
6046bf4 feat(s3): one build that serves the host root and /idp
```

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
second connection through the **pooled** endpoint _succeeds_. Through the
**direct** endpoint it behaves correctly. Every mutating startup step depends on
this — migrations, first-boot key generation, reconciliation, bootstrap admin,
cleanup.

**Resolution:** new config key **`database.directUrl`** (spec amended, D27
recorded, §13 R8 closed). Every locked step opens its connection with
`createDb(config, { direct: true })`; request traffic keeps the pooled URL.
Startup warns when the URL looks pooled and `directUrl` is unset.

### Risks that resolved better than expected

| Risk                         | Outcome                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1** default audience      | Real — no `resource` parameter yields an _opaque_ token, not a JWT. Fixed by a `hooks.before` injection; **the pre-authorized `pnpm patch` is not needed**. The wrinkle it recorded — a second `aud` from the `openid` scope — could _not_ be normalised in the `jwt.sign` seam, because that seam requires a remote key set; settled as **D32**. |
| **R2** per-client resources  | Confirmed: `enforcePerClientResources` defaults to `true`. Kept on; reconcile owns the links.                                                                                                                                                                                                                                                     |
| **R4** client-secret hashing | Resolved outright — `storeClientSecret` accepts our own `hash`/`verify` pair, so reconcile and the token endpoint use the same function object.                                                                                                                                                                                                   |
| **R5** session JWT           | Half right. `definePayload` is the seam for the session JWT and one claims builder does cover all three FR-OIDC-7 paths — but **not** through `jwt.sign`, which the plugin refuses to accept without a remote key set (D32).                                                                                                                      |

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
migrate → signing key → reconcile clients → validate roles → bootstrap admin,
every mutating step under an advisory lock on the direct connection, failures
surfacing as one actionable `StartupError`. FR-ADMIN-1's "two boots create
exactly one admin" holds.

**Public UI (FR-ACCT-2)** — `apps/web/src/routes/`
Server-rendered plain forms, so the login page works before hydration and
without JavaScript. Posts forward the original headers (so the CSRF origin check
applies), answer 303, and carry failures as an error **code** — wording comes
from the catalog, user input never reaches a URL, and wrong-password and
unknown-address collapse to one code (SEC-7).

**OIDC (FR-OIDC-2..17)** — `apps/web/src/server/oidc/`, `apps/web/src/server/claims/`
Client reconciliation in one transaction under an advisory lock, with the
shared `{hash, verify}` pair the token endpoint verifies with (R4) · one claims
builder for all three token shapes · the R1 default-resource injection · scoped
token revocation (user / session / client) · the FR-OIDC-13 absolute refresh
ceiling · the issuer-root protocol proxy with the discovery rewrite, the CORS
matrix and the RFC 7009 normalisation · publish-then-sign key rotation (R11).

**Account area (FR-ACCT-1, FR-KEY-1)** — `apps/web/src/routes/account/`
Profile, security (password, e-mail, 2FA enrolment with a server-rendered QR),
sessions, API keys and connected applications, every sensitive POST behind the
FR-AUTH-5 freshness gate reading authoritative session state.

**Also in place:** structured logger with SEC-5 redaction · SEC-6 audit trail ·
Resend and capture transports with all nine templates · typed en-US catalog with
FR-I18N-1 locale resolution · `/healthz` and `/readyz` · approve/reject
endpoints gated on `admin.adminRoles` · CI with lint, typecheck, unit,
dependency-pinning, schema-drift and config-schema gates, plus a nightly audit.

---

## What is left, in detail

**M9 — Authorize UX.** The pending-authorization store over the existing
`pending_authorization` table, the gate chain (login → status → 2FA → forced
change → consent → resume), the consent screen, the end-session confirmation
page and `routes/error.tsx`. `/oauth2/end-session` forwards today; the no-hint
case needs a page before it can act, because ending a session on an
unauthenticated GET is a CSRF surface.

**M10 — Admin UI + API.** `/admin/*` entirely, the invariants module (last
admin, no self-ban, no self-role-change), impersonation behind
`admin.allowImpersonation`, and the admin API endpoints FR-ADMIN-6 documents.

**M11 — Security hardening.** Already in place: SEC-1 (every URL from
`baseUrl`), SEC-3, SEC-5 redaction, SEC-6, SEC-7, SEC-9, SEC-10, and now the
FR-OIDC-17 CORS matrix. Still to do: the SEC-4 headers/CSP middleware, the
SEC-5 _request log_ (which no milestone has created yet — audit rows still
carry no request id), the SEC-2 rate-limit rules with `trustProxy` IP
resolution, `auth.password.breachCheck`, and the TST-5 adversarial suite.

**M12 — Container and ops.** The remaining CLI commands (`config validate`,
`create-admin`, `rotate-keys`, `cleanup` — `migrate` and `reconcile-clients`
exist), the cleanup job, SIGTERM draining on top of `src/serve.ts`, the
Dockerfile, compose, both Caddyfiles and the smoke test.

**M13 — E2E, sample RP, a11y.** Playwright against the built image at both
mount points, the `openid-client` sample RP, axe. The TST-7 mock OIDC provider
already exists as `src/tests/fixtures/mock-oidc-provider.ts` and is written as
a real listener precisely so the containerised run can reuse it.

**M14 — Docs and release.** The generated configuration reference, the DOC-1
README rewrite (including the first-sign-in trap: the forced change _consumes_
the `.env` password), `docs/neon.md`, `docs/clients.md`,
`docs/admin-api.md`, the runbooks, and the release gate.

---

## Deviations from the plan

| Deviation                                                                       | Why                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema generated by `scripts/generate-auth-schema.ts`, not the Better Auth CLI  | **Verified, D29.** The old "version-stranded CLI" reason was false — the CLI was renamed to `auth` and tracks 1.7.1. The real reason: the CLI emits module-level constants with the schema name baked in as a string literal, and a runtime `database.schema` (D27) needs a `createAuthSchema(schemaName)` factory it has no code path to produce. Both now emit field-identical output across all 17 tables. |
| Own migrator instead of `drizzle-orm`'s                                         | Drizzle's applies the file verbatim and cannot retarget `database.schema`, which is a runtime setting.                                                                                                                                                                                                                                                                                                        |
| `drizzle.config.ts` in `apps/web/`, not the repo root                           | drizzle-kit resolves every path relative to the config file, and both the schema and the migrations live there.                                                                                                                                                                                                                                                                                               |
| New config key `database.directUrl`                                             | Forced by the S4 pooler finding; recorded as D27 and amended into CFG-4.                                                                                                                                                                                                                                                                                                                                      |
| Route loaders read `context.ui`, filled by one `createServerFn` in `beforeLoad` | A Start `loader` is isomorphic, so a top-level `getRuntime` import puts the whole IdP in the browser bundle. See R-4.                                                                                                                                                                                                                                                                                         |
| Coverage is measured across **both** vitest projects, not `unit` alone          | Measuring all of `src/server` against unit tests only is the wrong denominator, and reported ~60 % against its own 70 % gate. See R-6.                                                                                                                                                                                                                                                                        |
| The reveal control is withdrawn when scripting is off                           | Blink and WebKit clamp a password field back to `disc` whatever the style says, so a scriptless toggle would lie to a screen reader. Cheap and no longer load-bearing after D31. See R-1.                                                                                                                                                                                                                     |
