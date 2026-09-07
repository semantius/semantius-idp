# Security review before v1.0.0 (2026-09-02)

The pre-1.0 review of semantius-idp as an open-source identity provider. It
was run against `main` at `45e02da` (v0.6.5) and closed with decisions
**D105**–**D126** in [spec-v1.md](../spec-v1.md) §12.1. This document is the
record: what was looked at, what was found, what was done about each finding,
and what was accepted with its reason. `SECURITY.md`'s "What is not" is the
accepted list in short form and must stay in step with the last section here.

**The repository was already public when the review started.** "Before the
release" therefore meant "before the v1.0.0 image and announcement", and
every fix went to the working tree on `main` rather than being held.

## Threat model

**Assets.** User credentials and second factors; sessions and their cookies;
authorization codes, access, refresh and session JWTs; the JWKS private keys
(encrypted with `secret`); OAuth client secrets and API keys (stored hashed);
the audit trail; the configuration folder; the database as a whole; and the
upstreams behind `/gateway/*`, which receive tokens the IdP mints.

**Actors.** An anonymous internet client; an authenticated user; a relying
party holding a client credential; an upstream behind a gateway; an
administrator, and an administrator's API key (which is the administrator);
an operator with the configuration folder and the database, who is trusted
by definition (`SECURITY.md`).

**Trust boundaries.**

| Boundary | Where it is enforced |
| --- | --- |
| browser → IdP | Better Auth's origin check (D68), `assertSameOrigin` in `requireSession` (D117), `SameSite=Lax` host-only cookies (D97), the CSP and `frame-ancestors 'none'` (SEC-4) |
| RP → IdP | exact `redirect_uri` match, PKCE S256 only, client authentication at the token endpoint, per-client rate buckets that count only authenticated grants (D112) |
| IdP → upstream | the gateway's outbound header strip, the inbound deny-list (D118), `Location` and cookie stripping, link-local refusal (D111), path containment (D110), the body cap |
| user → administrator | `admin.adminRoles`, the last-admin and self-action invariants with every non-`active` status counted (D108), the update-user column allow-list |
| application → database | a NOSUPERUSER role in the reference deployment (D109), `BEGIN READ ONLY` for the console's writes, the start-up superuser warning |
| edge → IdP | one address resolution at the edge for every limiter (D115), `server.allowedHosts` for the dynamic issuer (D106) |

## How the review was run

1. Three parallel read-only sweeps of `apps/web/src` (authentication and
   sessions; the OAuth/OIDC surface, tokens, API keys and the gateway; the
   admin API, console, configuration, e-mail, logging, container and CI),
   each reporting entry points, guards and candidate weaknesses with
   `file:line` evidence — about 56 candidates.
2. A regression review of the resulting plan against the repository contract,
   the decision log, and the sibling deployment `semantius-self-hosted`, which
   consumes this IdP's image with `dynamicIssuer` on, `trustProxy: true`
   behind two hops and a `/gateway/rest` to PostgREST on a private address.
   Thirteen planned fixes were changed because of it (recorded per finding).
3. The GitHub repository settings, the pinned Better Auth 1.7.1 and TanStack
   packages against published advisories, `pnpm audit`, and a grep of the tree
   and the full history for committed secrets.
4. Six parallel work streams, one per area, each writing the test that
   demonstrates the finding, watching it fail, then fixing it. Shared documents
   (this one, the spec, the changelog, `status.md`, `AGENTS.md`, `SECURITY.md`)
   were assembled centrally so the decision numbers stay consistent.
5. The full gate run, the container smoke test, the browser suite against the
   rebuilt image, and a boot of the sibling stack against the same image.

## Findings

Verdicts: **fixed** (confirmed by a failing test, then closed), **not
reproducible** (the code was checked and the weakness is not there, with the
evidence), **accepted** (left as is, reason recorded in the `D` row and in
`SECURITY.md`), **documented** (no code change; the docs now say it).

### Authentication, sessions, account

| # | Finding | Verdict | Decision |
| --- | --- | --- | --- |
| F1 | A forced password change was bypassable by navigation: `/login` set the cookie before redirecting, and nothing under `/account/*`, `/admin/*` or `/api/auth/*` read `mustChangePassword`; a temporary password minted a long-lived API key. | fixed — `requireSession`, both layouts and a before hook on every cookie-bearing write or mint | D107 |
| F7 | Ban and approval state were not re-evaluated on a session read or on the refresh grant. | fixed — the refresh grant answers `invalid_grant`; `readSession` runs the standing gate (the session read had only been refused by accident, through the JWT plugin's `set-auth-jwt` hook) | bug fix |
| F9 | An impersonating administrator could mint an API key as the user, and the audit rows named the victim. | fixed — key creation refused under impersonation; `impersonatedBy` on every row | bug fix |
| F12 / F35 | Three rate-limit keying faults: `/setup` keyed on an anonymized /24; two address resolvers disagreed, so `trustProxy: true` behind two hops put every user in one bucket; IPv6 keyed by full address in the IdP's own buckets. | fixed — one resolution at the edge, `/64` keys, `/reset-password` rule | D115 |
| F13 (D-C) | Sign-up enumeration by redirect shape. | not reproducible as described (Better Auth 1.7.1 answers a duplicate with a generic success when `autoSignIn` is off) — the missing half fixed: the owner is told, `signup.duplicate` is recorded, `signup.created` no longer written for a phantom; and sign-up without e-mail, the only case left, is refused on a production deployment | D116, D127 |
| F15 | CSRF consistency: `assertSameOrigin` guarded three account pages; the profile, API keys and every admin form relied on the allow-list, which the documented `*.example.com` pattern let a sibling subdomain through. | fixed — the check is `requireSession`'s | D117 |
| F18 | The reset/invite page named the account to any token holder. | fixed — the page reports validity only; address and name are no longer returned | bug fix |
| F19 | A trusted-device row was renewed to a full window on every use, so a stolen cookie was a permanent second-factor bypass. | fixed — a ceiling of three windows from first trust | D124 |
| F20 | TOTP secrets and backup codes are decryptable with `secret`. | documented, and a start-up warning when the SQL console is on alongside two-factor | D123, D127 |
| F25 | The first-boot window on `/setup`. | documented (README quick start, runbooks) | — |
| F29 | The first administrator's e-mail was logged. | fixed | bug fix |
| F31 | The draft stash's never-list was name-based and missed `pin`, `otp`, `code`, `backup`. | fixed | bug fix |
| F32 | `audit.record` accepted a caller-supplied `ipAddress`. | fixed — the field is gone | bug fix |
| F34 | The setup gate's memoization is process-local and one-directional. | accepted (OPS-11) | D123 |

### OAuth / OIDC, tokens, API keys, gateway

| # | Finding | Verdict | Decision |
| --- | --- | --- | --- |
| F4 | Gateway sub-path traversal: the router decodes the splat, so `..%2fadmin` on a gateway scoped to `…/v1` reached `…/admin`. | fixed — `400 invalid_path` unless the normalized target stays under `<url>/` | D110 |
| F5 | Gateway SSRF reached link-local (the cloud metadata service). | fixed — link-local refused at configuration time and per request against the resolved address; private addresses stay reachable as D91 accepts | D111 |
| F6 | The token endpoint's per-client bucket was keyed on the unauthenticated `client_id`, so anyone could take a client's token endpoint offline. | fixed — counts authenticated grants only; refusals keyed per address and client | D112 |
| F10 | The consent audit row took `clientId` from a hidden form field. | fixed | bug fix |
| F14 | `dynamicIssuer` had no host allow-list, and no decision row. | fixed — `server.allowedHosts`, optional with a warning (the sibling's Dokploy variant cannot know its host in advance); D105 records the shipped feature | D105, D106 |
| F16 | Gateway hardening: upstream headers relayed onto the issuer origin, no per-gateway audience, no body cap. | fixed — deny-list extended (an allow-list would have dropped PostgREST's headers), an optional `audience` per gateway (first named `resource` after RFC 8707's request parameter; renamed at the owner's direction, since it is the `aud` the token gets), `server.maxRequestBodyBytes`; no total timeout (FR-GW-3 streams) | D118 |
| F17 | The refresh-lifetime sweep was O(table) per refresh grant. | fixed — bounded in SQL, hook unchanged | D119 |
| F21 | Client secrets are an unsalted digest with a length floor only. | fixed — ≥ 8 distinct characters refused below; a placeholder marker is a start-up warning (an old development `.env` must keep booting) | D125 |
| F22 | RFC 7009 normalization matched the library's wording. | fixed — keyed on the error code and the request's own facts | bug fix |
| F23 (D-B) | `skipConsent` defaulted to true for admin-created clients. | fixed — the create form ticks "Require consent"; file clients and existing rows unchanged | D120 |
| F24 | API keys are unscoped and an administrator's key is an administrator. | accepted, stated in `SECURITY.md`; scoping is post-1.0 | D123 |
| F26 | The role catalog was not enforced on write; a comma-joined role became two. | fixed — the admin plugin is handed the catalog | bug fix |

### Admin API, console, configuration, infrastructure

| # | Finding | Verdict | Decision |
| --- | --- | --- | --- |
| F2 | `/admin/update-user` with `status: "pending"` bypassed the last-admin and self-action invariants, and its body reached every column. | fixed — any non-`active` status is a rejection; a twelve-column allow-list | D108 |
| F3 | The SQL console as a Postgres superuser: verified on `postgres:17.4-alpine` as the reference compose's bootstrap user — inside `BEGIN READ ONLY`, `COPY (SELECT 1) TO PROGRAM 'id'` answered `COPY 1` and `pg_read_file('/etc/passwd')` returned the file. | fixed — the reference compose provisions a NOSUPERUSER `idp` role (fresh volumes), start-up warns when the console runs as a superuser, D83's claim corrected; proved by the smoke test and a throwaway project where all three probes answered `permission denied` | D109 |
| F8 | The recorded console statement was not scrubbed although a comment said it was; `actorType` was always `session`. | fixed — value-level scrub, `actorTypeFor` | D113 |
| F11 | `rateLimit.enabled: false` and `allowInsecureHttp: true` were silent. | fixed — start-up warnings | D114 |
| F27 | A `read-write` console can delete the audit trail. | accepted, documented | D123 |
| F28 | `/branding/*.svg` served without a CSP; the config was re-read per request. | fixed | D126 |
| F30 | The anonymous sign-in page revealed that a SQL console exists. | fixed | bug fix |
| F33 | The IdP's own rate limiter fails open on a database error. | left as is — a database outage stops sign-in itself; not listed in `SECURITY.md` | — |
| Phase 0.5 | Every workflow action was a tag; `anchore/sbom-action@v0` was two releases behind; no workflow-level `permissions`. | fixed — SHA pins enforced by `check-pinned-deps.ts`, `contents: read` | D121 |
| Phase 0.6 | A first run copied `.env.example` with `IDP_SECRET=` empty and failed until edited. | fixed — `docker/idp-setup-env` generates every secret | D122 |
| — | Stale documentation: the removed freshness gate (`AGENTS.md`, `CONTRIBUTING.md`), the `pending_authorization` comment describing a session-bound store that does not exist, the spec header two decisions behind. | fixed | — |

### Found on the way

- **Better Auth's own `/admin/*` endpoints refuse an API key.** `adminMiddleware`
  re-reads the session authoritatively and discards the key-built one; only
  this repository's `requireAdmin` (`admin/gate.ts`) carries the D35 fallback.
  So the two authentication methods `docs/admin-api.md` calls equivalent are
  equivalent for `/idp/*` only. Documented; not changed.
- **Better Auth 1.7.1's `/sign-up/email` never refuses a duplicate here.** It
  answers a taken address with a generic success and a synthetic user whenever
  `autoSignIn` is off, which `instance.ts` sets for every deployment. The
  redirect-shape leak the review set out to close did not exist; the audit row
  it caused did (D116).
- **The static asset handler crashed on an encoded slash.** Probing D110
  against the built image, directly at the IdP rather than through Caddy,
  `/gateway/rest/..%2fadmin` answered a bare 500 with no request-log line:
  `serve.ts` handed the path to `Bun.file`, which throws on `%2F` inside a
  `file:` URL, before routing. Pre-existing, reachable by anyone, and it hid
  the gateway's designed 400. Fixed in `serve.ts`; the probe now answers 400.
  Through Caddy the same path had collapsed to `unknown_gateway`, because
  Caddy normalizes it first — which is why a check that goes through the
  reference front door alone would not have found it.
- **The sibling's Caddy did not trust Traefik.** With no `trusted_proxies`,
  Caddy replaces `X-Forwarded-For` with Traefik's address in the Dokploy
  variant, so the IdP saw one client for everyone whatever `trustProxy` said.
  Fixed in the sibling's source `Caddyfile` with a global
  `trusted_proxies static {$TRUSTED_PROXIES:127.0.0.1/32}` — trust nobody by
  default, because whatever is trusted can forge the client address — and
  `TRUSTED_PROXIES=172.16.0.0/12` in the Dokploy template, where Traefik lives
  in Docker's address pools, with the advice to tighten it to
  `dokploy-network`'s own subnet. The blueprint was regenerated; the owner committed the change in the
  sibling repository as `214459d` on 2026-09-03.

## The vendored library, against its advisories

Better Auth and `@better-auth/*` are pinned at 1.7.1, above every published
Better Auth advisory range, including the fourteen from May to August 2026
(GHSA-7w99-5wm4-3g79, GHSA-392p-2q2v-4372, GHSA-9h47-pqcx-hjr4,
GHSA-86j7-9j95-vpqj, GHSA-g38m-r43w-p2q7, GHSA-p2fr-6hmx-4528,
GHSA-pw9m-5jxm-xr6h, GHSA-cq3f-vc6p-68fh, GHSA-p6v2-xcpg-h6xw,
GHSA-wxw3-q3m9-c3jr, GHSA-qq9h-g4jm-xgf3, GHSA-2vg6-77g8-24mp,
GHSA-3q45-2fh7-66cj, GHSA-99h5-pjcv-gr6v). The resolved `@tanstack/*` versions
are not on GHSA-g7cv-rxg3-hmpx's list. `pnpm audit --audit-level low` reports
one low finding, esbuild under `drizzle-kit>tsx`, development-only, left open by
name in D85.

What the vendored code was read for, and what it does:

| Check | Verdict |
| --- | --- |
| PKCE | `S256` only; `plain` refused by name |
| Authorization code | consumed atomically (`consumeVerificationValue`); a replay revokes the tokens the code produced |
| Refresh rotation | `invalidateRefreshFamily` on reuse; `refreshTokenReuseInterval: 0` set by this app |
| `redirect_uri` | exact match; the loopback-port carve-out applies to `127.0.0.0/8` and `[::1]` only |
| `javascript:` / `data:` / `vbscript:` | refused for redirect and resource URIs |
| Origin check | `Origin`, falling back to `Referer`; force-enabled under `NODE_ENV=test` by this app (D68) |
| Rate-limit key | `${ip}|${path}`; IPv6 masked to /64 by default, now set explicitly; the IdP's own keys masked by D115 |
| `alg=none` | not advertised (asserted by `discovery.test.ts`) |

## Repository settings applied

Applied on 2026-09-02 with the GitHub API (the token holds `admin`), each
reversible by the same call:

```text
PATCH /repos/semantius/semantius-idp
      security_and_analysis.secret_scanning = enabled
      security_and_analysis.secret_scanning_push_protection = enabled
PUT   /repos/semantius/semantius-idp/vulnerability-alerts            (Dependabot alerts; no automated PRs)
PUT   /repos/semantius/semantius-idp/private-vulnerability-reporting (the form SECURITY.md links to)
PUT   /repos/semantius/semantius-idp/branches/main/protection
      required_status_checks: null, enforce_admins: false,
      required_pull_request_reviews: null, restrictions: null,
      allow_force_pushes: false, allow_deletions: false
```

The branch rule refuses only `push --force` and deleting `main`; direct pushes
and `./release.sh` are unchanged. Dependabot security *updates* stay off, and
there is no `dependabot.yml`: exact pins with reviewed, manual bumps are policy
(D85). `pnpm audit` stays nightly for the reason D85 gives.

No committed secret was found in the working tree or in the full history.

## Documented behavior and trade-offs

Recorded in D123 and mirrored in `SECURITY.md`. The first four are standard
for the class of product and are listed so a reporter does not have to guess;
the rest are trade-offs this product makes, each with its reason:

- the first-run gate's memoization is process-local (F34, OPS-11);
- API keys are unscoped; an administrator's key is an administrator (F24);
- second factors are decryptable with `secret` (F20);
- a `read-write` console can delete the audit trail; the role is the boundary (F27, D109);
- `script-src 'unsafe-inline'`, the access-token validity window, and
  everything requiring configuration-folder or database access, as before.

## Verification

Filled in at the close of the review; see the closing section of
[status.md](../status.md) for the same numbers in narrative form.

All numbers from the final working tree on 2026-09-02, after every stream had
landed, with the shared throwaway Postgres on port 55433 for the integration
suite and `IDP_SCHEMA_NAME`-style per-file schemas; nothing touched the
persistent `idp` schema or the owner's `.env`.

| Gate | Result |
| --- | --- |
| `pnpm lint`, `pnpm typecheck` | green |
| `vitest run --coverage` (unit + integration, thresholds) | 99 files, 1234 tests, all thresholds met |
| `config:schemas --check`, `docs:config --check`, `db:generate-schema --check` | green (regenerated for `server.allowedHosts`, `server.maxRequestBodyBytes`, `gateways.<name>.audience`, the `audience` column) |
| `check-pinned-deps.ts` (now covering workflow `uses:`), `check-bun-version.ts` | green |
| `pnpm --filter web run build` + `check-client-bundle.ts` | green — 86 files, no server-only markers |
| `pnpm docker:smoke` (rebuilt image, non-superuser compose role) | passed twice: after the streams landed, and again after the `serve.ts` fix |
| `test:e2e` against the rebuilt image | 101 passed, both deployment shapes — five runs on the final code paths; one of them stopped at the accessibility scan of `/admin/database` with a `role="separator"` lacking `aria-valuenow`, which the vendored resizable component sets only after it has measured the panel group, so a scan that arrives first sees it missing. The vendored component is unchanged; the re-run passed. A wait for `aria-valuenow` in `a11y.spec.ts` before scanning that page would close the race, and is not done here |
| US-spelling sweep | only pre-existing quotations (D94's own examples) |
| `pnpm audit --audit-level low` | 1 low, esbuild under drizzle-kit>tsx, left open by D85 |
| secret grep, tree and 150-commit history | nothing |

**F3 empirically**, on `postgres:17.4-alpine` as the reference compose's
bootstrap user, inside `BEGIN READ ONLY`: `COPY (SELECT 1) TO PROGRAM 'id'`
→ `COPY 1`; `pg_read_file('/etc/passwd', 0, 60)` → the file;
`pg_ls_dir('/')` → the listing. After D109, as the `idp` role the compose now
creates: `rolsuper = f`, and all three → `permission denied`.

**The sibling, without touching its files.** An isolated compose project
(`-p secrev-sibling`, its own container names, ports 3999/55434/56432, fresh
volumes) of `semantius-self-hosted` on the review image
(`SEMANTIUS_IDP_VERSION=secrev-local`, `IDP_PULL_POLICY=missing` as shell
variables; the owner's `.env` read for interpolation only, never written; the
owner's running stack untouched):

- boot: `/idp/readyz` 200, discovery issuer `http://localhost:3999/idp`, root
  → `/idp/setup`; the boot log carries `database.console_as_superuser` (the
  sibling's own compose still runs as `postgres`) and the shipped-default
  warnings for its development secrets;
- first-run wizard → sign-in → `POST /api/auth/api-key/create` → `GET
  /gateway/rest/` with the key: 200, and a table query answers with
  PostgREST's `Content-Range` and `Content-Location` intact under the forced
  `sandbox; default-src 'none'` and `no-store`;
- `/gateway/rest/..%2fadmin` through Caddy: `unknown_gateway` (Caddy
  normalizes the path first); directly at the IdP, before the `serve.ts` fix: a bare 500 with no log
  line; after it: forwarded — the sibling's `rest` gateway targets a bare
  origin, so `/admin` is inside it and PostgREST answers its own 404, as
  D110 specifies — and on a gateway added with a path prefix
  (`http://postgrest:3000/rpc`) the same path answers `400 invalid_path`;
- `/idp/create-gateway` with `http://169.254.169.254`: refused by name;
- recreated with `IDP_DYNAMIC_ISSUER=true` and no `allowedHosts`: ready,
  `server.dynamic_issuer_unrestricted` in the log, and the issuer follows a
  foreign `Host` as designed;
- torn down with `down -v`; the `secrev-local` tag removed.

