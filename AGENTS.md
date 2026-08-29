# AGENTS.md

The contract for any agent working in this repository. `CLAUDE.md` is a symlink
to this file, because tools disagree about the name and the knowledge should not
be duplicated to satisfy them.

> Git stores `CLAUDE.md` as a symlink (mode `120000`). On a Windows checkout
> without Developer Mode it materialises as a one-line text file containing
> `AGENTS.md` — that is expected. Do not "fix" it by copying the content across;
> two copies is the thing the symlink exists to prevent.

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
| [spec-v1.md](spec-v1.md) | Signed off, amended through **D91**. Numbered requirements, and §12.1's decision log with the reasoning. |
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
| `config-schema/*.schema.json` | `config:schemas` | `--check` |
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
pnpm --filter web run test:integration      # starts a local Postgres if it must
pnpm --filter web run test:coverage         # thresholds, both projects
pnpm --filter web run test:e2e              # needs Docker; drives the built image
bun run scripts/check-pinned-deps.ts
bun run scripts/check-bun-version.ts     # Bun is the runtime; five files pin it
pnpm --filter web run config:schemas -- --check
pnpm --filter web run docs:config -- --check
pnpm --filter web run db:generate-schema -- --check
pnpm --filter web run build && bun run scripts/check-client-bundle.ts
pnpm docker:smoke                           # TST-8, builds the image
```

Dependencies are **pinned exactly** — no `^`, no `~`, no `latest`. Tools that
add a floating range (the shadcn CLI adds `shadcn: ^4.19.0`) fail
`check-pinned-deps.ts`, which is the point. **`pnpm.overrides` counts as a
dependency and is checked too** (**D85**).

**A red `pnpm audit` is closed with an override, not with a threshold**
(**D85**). The nightly SEC-9 job runs `pnpm audit --audit-level moderate`, and
when it goes red the finding is almost always a *transitive dev* dependency —
sixteen of them at once on 2026-08-28, none in the image. Add an exact
`pnpm.overrides` entry: version-scoped (`brace-expansion@1`) when two majors
of one package are in the tree, parent-scoped (`@esbuild-kit/core-utils>esbuild`)
when a global bump would be the bigger change. Do **not** raise
`--audit-level` and do **not** add to an ignore list; if an advisory really is
being left, name it in the decision log with the reason, the way D85 leaves
`drizzle-kit>tsx>esbuild`. Run `pnpm install` afterwards and re-run the gates:
overrides move `postcss`, `esbuild` and friends, which is the build.

---

## Things that will bite you

**The e2e suite drives the *built image*, not the source.** Change anything that
ends up in the image — CSS, components, server code — and rebuild before
`test:e2e`, or you are testing the previous build. `pnpm docker:smoke` rebuilds
and tags `semantius-idp:local`, which is what the suite defaults to.

**"The password is wrong" is sometimes the origin.** Better Auth refuses a post
whose `Origin` is not trusted *before* it looks at a credential, and it says so
in the log — `Invalid origin: …` — while the page used to say the password was
wrong. Since **D57** that refusal has its own code (`untrusted_origin`) and its
own message, and since **D68** an unconfigured deployment trusts the address
the request arrived on (`X-Forwarded-Host`, else `Host`) rather than
`server.baseUrl` alone, so neither `127.0.0.1`-instead-of-`localhost` nor a
reverse proxy produces it any more. What still does: a configured
`server.trustedOrigins` that does not name the address in use, and a genuine
cross-site post. When a password that should work does not, read the log before
you doubt the password.

**Better Auth turns the origin check off under `NODE_ENV=test`.**
`skipOriginCheck` defaults to `true` there (`context/create-context.mjs`), and
its backward-compatibility arm takes the Fetch-Metadata CSRF check with it — so
every test in this repository ran against a build with SEC-3 disabled until
`advanced.disableOriginCheck: false` was set explicitly in
`server/auth/instance.ts` (**D68**). Do not remove it to make a test pass: the
test is telling you the request has no legitimate `Origin`, which is what the
integration harness's `authRequest` sets for you.

**`setResponseStatus` does not reach a rendered page.** It works for server
routes and server functions and silently does nothing for an SSR document:
`renderRouterToStream` builds that response with
`status: router.stores.statusCode.get()`, and the router only ever puts 404
(a `notFound()`), 500 (an errored match) or 200 in there. A loader that wants
its own status leaves it on the request context — `setDocumentStatus` in
`server/http/request-log.ts` — and `server-entry.ts` applies it on the way out.
The first attempt at FR-ROLE-3's 403 typechecked, ran, and changed nothing;
only the e2e suite noticed, because it is the only gate that reads a real
document response.

**Behind `/admin/*` the error mapping is `adminErrorCodeFor`, not
`errorCodeFor`** (**D70**). `errorCodeFor` ends in `invalid_credentials`
because SEC-7 requires a public page to answer a wrong password and an unknown
address identically. Every admin form was using it, so a duplicate address in
the create-user dialog — a dialog with no password field — said the e-mail and
password combination was wrong. The admin variant names the duplicate and turns
anything unrecognised into `request_failed`. Public pages, `change-password.ts`
(which genuinely checks a password) and the account routes keep the collapse;
`/account/security`'s change-email deliberately so, because it is an
enumeration surface for a non-administrator.

**Anything after a create that has already succeeded must not throw its way to
an error page** (**D70**). `/admin/users`'s set-password tail did, the natural
retry was a duplicate, and the duplicate is what produced the sentence above.
The pattern is: wrap the tail, log it, and land on the list with a notice that
names the recovery.

**`/oauth2/token` is not an oracle for "does this client secret work".** It
validates the authorization code *before* the client credential, so a junk code
answers `invalid_grant` whatever secret is presented — including one that was
never right. A D50 test built on that assertion passed for four months and
proved nothing; D72's rotation case is what exposed it. Use
`/oauth2/introspect`, which authenticates the client and then answers about the
token: wrong secret is `401 invalid_client`, right secret is
`200 {"active": false}`.

**A toast is a `role="dialog"`.** Base UI gives it one (with
`aria-modal="false"`) so a keyboard user can reach its close and action
buttons. Since **D71** put a toast on every admin and account page, a bare
`page.getByRole("dialog")` matches two elements the moment a confirmation is
showing, and Playwright's strict mode fails the *test*. The e2e helpers export
`modal(page)`, which selects `[data-slot="dialog-content"]` — what
`DialogContent` stamps and the toast does not. Use it, never the role.

**`--destructive` diverges from the shadcn preset on purpose.** The preset's
own value made `variant="destructive"` — `bg-destructive/10 text-destructive` —
a 3.98:1 pairing, under R-1's 4.5:1 floor, and the axe gate failed on every
page with a destructive dialog trigger. Both themes are darkened, with the
measurements in `globals.css` beside the token. **Re-applying a preset resets
it**, so re-measure after any `shadcn apply`.

**A preset token that carries an *icon* well may not carry *text* at all.**
`--sidebar-primary` against `--sidebar-primary-foreground` measures **3.07:1**
light and **2.12:1** dark. semantius-app's brand and avatar squares use it and
are fine, because what sits on them is a white SVG. The same classes copied
onto a square holding an initial would have failed R-1 on every page of both
signed-in areas; `nav-user.tsx` uses the accent surface instead (16.04:1 /
14.56:1) and records the numbers beside the class. **Measure before you copy a
pairing from the reference app**, and re-measure after a preset.

**A control inside a `role="tree"` has to be inside a `treeitem`, not beside
one** (**D84**). `/admin/database`'s run button is in the schema tree, and axe
is strict about what a `tree` owns: nothing but `treeitem` and `group`, so a
button rendered as a row's *sibling* is a critical `aria-required-children`
finding on a page the R-1 scan visits. Inside the row it is legal —
`treeitem` is not one of the roles whose children must be presentational,
which is what `nested-interactive` keys on — but that means the row cannot be
a `<button>`, because a `button` inside a `button` is invalid HTML that the
parser un-nests, and the hydrated tree then does not match the streamed one.
The row is a `div role="treeitem"` and the tree's own key handler supplies the
Enter and Space the element no longer has. When you add a control to a
composite widget, check what the container's role is allowed to own before
you write the markup.

**The sidebar chrome lives in the two layout routes, not in the page shells**
(**D82**). `SidebarProvider` holds the collapse state, the mobile sheet's state
and a `window` keydown listener, and only a layout route's component survives a
navigation inside its own subtree. Put it in a page and every navigation
remounts the provider, snaps the sidebar open and stacks another listener.
Three more things about it that are easy to get wrong:

- **`activeProps` cannot light a nav entry.** The highlight is
  `SidebarMenuButton`'s own `data-active`, and the `<Link>` is *inside* the
  button, so the prop lands a level too deep. `useMatchRoute()` answers the
  same question a step earlier — `fuzzy: true` unless the entry is the
  subtree's index.
- **Never locate the toggle by its accessible name in a test.** `SidebarRail`
  is a second visible button whose registry `aria-label` is "Toggle Sidebar",
  which matches the catalog's "Toggle sidebar" case-insensitively — two
  matches, and Playwright's strict mode fails the *test*. Use
  `[data-sidebar="trigger"]`.
- **The footer puts the signed-in name and address outside `<main>`.** Any
  existing `page.getByText(email)` — or `getByText("<display name>")` — on a
  signed-in page now matches twice; scope it to `main`. `SidebarInset` renders
  the only `<main>` in both areas.
- **`cn()` does not resolve every pair you assume it does.** The sidebar's
  fixed container is `inset-y-0 h-svh`. `h-[calc(…)]` replaces `h-svh` — same
  tailwind-merge group — but `top-*` does **not** replace `inset-y-0`, so both
  survive and CSS source order decides. Offsetting the sidebar for the
  impersonation banner therefore uses `mt-`, which cannot conflict with an
  inset at all. When you override a registry class, check the merge actually
  happened rather than assuming.
- **The mobile sheet does not close itself on a navigation.** A client-side
  navigation does not unmount it, so the page changes underneath an open modal
  drawer that still holds the focus trap. `ShellSidebar` closes it on the
  route, in an effect — not on each link, which the next link would forget and
  which the back button could not reach anyway.
- **`min-h-svh` is a minimum, not a height, and that difference broke a page**
  (**D87**). The registry provider is `min-h-svh`, which leaves the box
  *indefinite* — and `height: 100%` against an indefinite box computes to
  `auto`. `/admin/database`'s resizable groups set exactly that on
  themselves, so the schema tree grew to every table, the document scrolled,
  and the SQL editor disappeared: two panes with `flex-basis: 0` in a group
  with no height are two panes 0 px tall. The shell is `h-svh` as well now,
  and **`SidebarLayout`'s content box is the scroll container**, not the
  document. A page that wants to fill the window asks `AdminShell` for
  `fill`; everything else is unchanged, because a page shorter than the
  viewport never scrolls either way.

**A Better Auth plugin's `schema` is not a free place to put a table**
(**D91**). `idp-plugin.ts` carries an 85 % *function*-coverage gate written
for the approval workflow, and a table declaration is mostly arrow functions
no test calls — the `defaultValue: () => new Date()` thunks the generator
turns into `.defaultNow()`. Adding the `gateway` table there took that gate
from 90 % to 69 % and failed a run that had nothing to do with approvals. The
declaration lives in `server/gateways/schema.ts` and is spread into the
plugin's `schema` from there; `getAuthTables()`, the DM-1 generator and the
drift gate see no difference. `admin/endpoints.ts`'s header already said this
about that file — believe it for schemas too.

**`/gateway/*` is same-origin with the issuer, and everything odd about it
follows from that** (**D91**). It proxies an operator-named upstream on the
IdP's own hostname, so: cookies are stripped outbound (a browser sends this
IdP's session cookie to `/gateway/x`), `Set-Cookie` is stripped inbound (an
upstream would otherwise set one on the issuer's origin and path), the CSP is
forced to `sandbox; default-src 'none'` — set *explicitly*, so
`security-headers.ts`'s `setUnlessPresent` leaves it, because the IdP's own
policy concedes `'unsafe-inline'` — and a `Location` that resolves off the
upstream's origin is deleted. The key → JWT cache means **a ban is not
re-checked for up to ten minutes**; `admin/guard.ts` calls
`resetGatewayTokenCache()` so a revocation made through this process is
immediate, and anything that ends a user's or a key's access must keep doing
so.

**The integration suite runs against a local Postgres, and must.** It used to
default to the deployment's own Neon instance in `us-east-2` — **~102 ms per
round trip** from here — and every context it builds drops a schema and applies
77 migration statements one at a time, so each was about eight seconds of pure
latency before a single assertion. Times a hundred-odd contexts, serialised by
`fileParallelism: false`: **fifty-four minutes**. Against a container on
loopback the identical suite is **three minutes**.
`apps/web/scripts/test-database.ts` starts and reuses one (`idp-test-db`, port
55432, fsync off) unless `IDP_TEST_DATABASE_URL` is set, which is how CI hands
it the service container it already had. Do not point it back at a hosted
database to be "production-like": it is a hundred milliseconds a query, and a
test schema on *that* database is one typo away from the persistent `idp`
schema this file says never to touch.

Two things when running it by hand: write to a **file**, never pipe through
`tail`, which buffers everything and looks exactly like a hang; and a test that
builds its own `postgres()` handle takes its TLS setting from
`testDatabaseSsl()`, never from `url.includes("localhost")` — that spelling is
the `127.0.0.1` trap D57 and D68 each cost a day to, and here it surfaces as
"Client network socket disconnected", which reads like a network fault.

**A field's `id` is generated, never its `name`.** `name` is unique in a form
and emphatically not in a document: `/account/security` has three fields called
`password` — the change-password dialog's and the two the second-factor forms
ask for — so `<label for>` resolved to whichever came first and named the wrong
control. `TextField` and `PasswordField` derive the id with `useId()`; `name`
still decides what is submitted. Anything hand-rolling an input on a page that
already has one of the same name has the same problem.

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

**The database is a *pair* of connection strings** (**D74**). `database.url` is
ordinary traffic, `database.directUrl` (env `DATABASE_URL_ADMIN`) is the
direct, non-pooled endpoint every lock-taking step needs. Neither is required
on its own and **at least one must be set**; each falls back to the other, so a
single-endpoint deployment is configured under either name and both resolve to
the same string. Read them as `config.databaseUrl` / `config.databaseDirectUrl`
from `derive.ts`, never `config.file.database.url` — that one is
`string | undefined` and is the raw file value, not the resolved one. "It needs
a Postgres" is the wrong sentence for any documentation here.

**A borrowed binary must be pinned to the same platform as the stage that runs
it** (**D73**). `docker/Dockerfile`'s `build` stage is
`--platform=$BUILDPLATFORM` and executes the Bun binary it copies out of the
`bun` stage. When `bun` was unpinned, BuildKit made one instance of it per
**target** platform against a `build` stage that exists once in total, and the
two-platform build handed that one stage the wrong architecture's binary — a
defect no single-platform build can expose, which is why it survived until the
first `--platform=linux/amd64,linux/arm64` run. The symptom is
`qemu-x86_64: Could not open '/lib64/ld-linux-x86-64.so.2'`, which reads like a
missing library. `runtime` stays unpinned on purpose: it is the artefact.
Verify a Dockerfile change with **both** platforms —
`docker buildx build --platform linux/amd64,linux/arm64 -f docker/Dockerfile
--output type=cacheonly .` — because none of the gates do.

**Read the annotations; they need no admin rights.** A job that fails at
`Set up job` names no step, and `GET /repos/{owner}/{repo}/actions/jobs/{id}/logs`
returns 403 without admin. The annotations do not:

```bash
curl -s https://api.github.com/repos/semantius/semantius-idp/check-runs/<job_id>/annotations |
  python3 -c "import json,sys;[print(a['message']) for a in json.load(sys.stdin)]"
```

One call to that named the exact cause after two rounds of correlating job
shapes had guessed wrong (**D75**). Reach for it first, not last.

**An action reference is resolved before any step runs — including the ones
*inside* the actions you name** (**D75**). `aquasecurity/trivy-action@0.28.0`
was wrong twice over: that repository tags `v0.28.0`, and `v0.28.0` then calls
`aquasecurity/setup-trivy@v0.2.1`, **a tag that has since been deleted**. Nothing
local catches either. Verify the refs you wrote — and when one fails, read its
`action.yaml` for the refs *it* uses:

```bash
grep -rhoE "uses: [^@]+@[A-Za-z0-9_.-]+" .github/workflows/ | sed 's/uses: //' | sort -u |
  while read -r r; do repo="${r%@*}"; ver="${r#*@}"; o="${repo%%/*}"; n="$(echo "$repo" | cut -d/ -f2)"
    [ -n "$(git ls-remote --tags --heads "https://github.com/$o/$n" "$ver")" ] &&
      echo "OK $r" || echo "CHECK $r"; done
```

`CHECK` is not proof of a fault: a **commit SHA** is a valid ref and
`ls-remote` lists only branches and tags, so a SHA-pinned action reports
`CHECK` and is in fact the safest form — it cannot be retagged out from under a
build, which is exactly what happened here. Confirm a SHA with
`/repos/{o}/{n}/commits/{sha}`.

**A bind mount carries host ownership into the container, and Docker Desktop
hides it** (**D77**). The image runs as `bun`, uid 1000; a GitHub runner runs
as uid 1001; the e2e suite bind-mounts a directory it created to `/mail` for
D30's capture transport. On Linux the container could not write there, so
twenty tests failed with `Captured: nothing` while every anonymous test passed.
Docker Desktop's bind mounts do not enforce host uids, so **this whole class is
invisible locally on Windows and macOS** - 78 tests passed here against the
exact image that failed on the runner. Anything the container must *write* to
through a bind mount needs its permissions set explicitly by the test harness.

**A dependency the build *inlines* still ships in the image unless you delete
it** (**D86**). `pnpm deploy --legacy` copies the whole virtual store, so
`docker/Dockerfile` removes build tooling by name — and
`@hugeicons/core-free-icons`, the console's icon set, is **148 MB** of it that
Vite had already inlined into the server chunks. It took the image 25 MiB over
OPS-13's ceiling and failed the `v0.3.0` release run at the smoke gate.
`lucide-react` is the opposite case and must stay: the server chunks import it
at runtime. **Which one a dependency is, is a property of the build, not of the
package** — ask the built output:

```bash
grep -ho 'from"[^"]*"' apps/web/dist/server/assets/*.js | sort -u
```

Everything that lists is still expected in `node_modules`; everything else is
inlined and is a candidate for the prune list. Prove a prune with
`test:e2e`, never with the local smoke test — **Docker Desktop reports the
*compressed* size** (89.5 MiB here against 374.8 MiB on a runner), so the size
gate cannot fail locally and never could.

**A tag never reaches `ci.yml`, and `release.yml` is what publishes** (**D73**).
`ci.yml` triggers on `push: branches: [main]`; a tag push does not match a
branch filter. The whole of OPS-1's publish path used to live there behind
`startsWith(github.ref, 'refs/tags/v')` and had therefore never run once —
five steps that looked like a feature and read as green. Anything to do with
publishing belongs in
[.github/workflows/release.yml](.github/workflows/release.yml), which triggers
on `push: tags: v*`; anything to do with validating a change belongs in
`ci.yml`. Before tagging, rehearse: **Actions → Release → Run workflow**
builds both architectures and smokes amd64 without pushing anything. The tag's
version must equal the root `package.json` version, or the run refuses in its
first job — the image stamps `IDP_VERSION` from the tag and three surfaces
report it. **`docker/release.sh vX.Y.Z` is the supported way to cut one**: it
checks the preconditions, bumps the three files that carry a version, commits,
tags and pushes. It is the same script `semantius-app` uses, which is the
sibling repository to copy release conventions from — its
`.github/workflows/docker-publish.yml` has cut three releases and is worth
reading before changing this one.

**There is no bootstrap account.** A database with no users serves the first-run
setup page (`/setup`, **D52**), and whoever completes it is the first
administrator. There is no `reset-admin` command. To get the wizard back on a
schema that already has users, drop the schema — `pnpm drizzle:reset`
(**D56**), which drops `database.schema` and nothing else, after printing the
target and asking `[y/N]`. `--schema <name>` aims it at a throwaway; that is
the supported way to clean one up.

**Restart the app after a reset — the `lock_timeout` does not stop you** (**D58**).
An idle connection holds no table lock, so the drop succeeds against a running
dev server, which then talks to a schema that is no longer there *and* keeps
serving the sign-in page: the first-run gate memoises "setup is done" for the
life of the process (`server/admin/first-user.ts`). The script now counts other
backends on the database and says to restart; believe it.

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
rule is the fix and the file never is. `sidebar.tsx` added an eighth,
`no-shadow`, for a `setOpen(open => !open)` inside a closure that already has
an `open`.

**Two files are exceptions, and they say so in their own headers**:
`schema-explorer.tsx` and `sql-runner.tsx` are **forks** of ui.neon.com's
components (**D84**, **D87**) — the first has no prop for a row action, the
second cannot be told to run, neither followed the window, and
`/admin/database` needs all of it. **Both now fill their container rather than
capping themselves, and the runner requires a parent with a definite height**:
it splits itself with a panel group, and a panel group in an auto-height
column measures zero. Each header lists its
divergences and each one is marked `Fork (D84)` where it sits. `shadcn add`
over either of them overwrites the lot; re-apply from the header's list.
Nothing else in `packages/ui/src/components` is forked, and the next component
that wants to be should be argued for rather than assumed.

### Adding one: `-c packages/ui`, and answer the overwrite prompt

```bash
cd packages/ui && yes n | pnpm dlx shadcn@latest add <name> -c .
```

**Not `-c apps/web`.** Its `components.json` maps `hooks` to `@/hooks`, which
would split a component's hook (`use-mobile`) from the component; `packages/ui`
resolves hooks to `@workspace/ui/hooks`, which is already in its exports map.

The CLI **prompts** before overwriting a component that already exists, and a
non-interactive shell hangs on that prompt and writes nothing at all — no
error, no files, exit 0. `yes n |` declines them; the run then reports what it
skipped. Afterwards check `git status`: the only changes should be the new
files. Nothing under `apps/web`, no `package.json`, and no `globals.css` — if
the CLI touched the stylesheet, revert any hunk near `--destructive`.

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
(owner review round 1, 2026-08-25) → `backend-systems-validate-the-luminous-backus.md`
(API gateways, **D91**, 2026-08-29).

Sessions end on context and hand off through status.md. New owner review
findings recorded there are **pre-work**: they come before anything still open
in status.md's Pending section.
