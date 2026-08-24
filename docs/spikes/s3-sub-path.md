# Spike S3 — one build, two mount points

**Question.** `server.baseUrl` may carry a path (`https://apps.example.com/idp`),
and it is *runtime* configuration (CFG-5). Vite's `base`, TanStack Start's
router `basepath` and Start's server-function base are all *build-time*
constants. OPS-10/G6 require one image to serve at `/` and at `/idp`.
`createBasePaths()` already covered every URL the server emits; the gap was
client assets, `<Link>` prefixes and the server-function endpoint.

**Verdict: option 1 works — relative asset base plus a runtime router
basepath.** No build argument, no second image, no Caddy rewrite of the origin
root. Verified on 2026-08-24 with a single `pnpm --filter web build` artifact
served twice.

---

## What the build bakes, and what neutralises it

| Baked at build time | Value | Neutralised by |
|---|---|---|
| Vite `base` | `"./"` | Nothing needed — relative is already relocatable |
| SSR asset manifest | `/./assets/…` (Start prepends `/`) | `transformAssets` in `src/server-entry.ts` |
| `?url` asset imports | `./assets/globals-*.css` (server), absolute URL (client) | `assetUrl()` in `src/lib/base-path.ts` |
| Router `basepath` | `"/"` (pinned in `vite.config.ts`) | `router.update` override in `src/router.tsx` |
| Server-function base | `/_serverFn/` | `serverFns.fetch` in `src/start-entry.ts`, stripped again in `src/server-entry.ts` |

The mount path reaches the browser bundle on `<html data-base-path="/idp">`,
rendered by `__root.tsx` from `UiContext.basePath` — already parsed by the time
the client entry builds its router, so there is no inline script and no extra
round trip.

### Why `base: "./"` rather than the default `/`

With the default, Vite's preload helper resolves lazy chunks against the host
root and CSS `url()` against `/assets/`, so a sub-path deployment 404s every
route chunk and every font. With `"./"` both resolve from `import.meta.url` and
from the stylesheet's own URL, which relocates with the bundle. The cost is the
two rows above that stay document-relative, and both are pinned at runtime.

`vite.config.ts` therefore also pins `router: { basepath: "/" }`. Without it,
Start derives the router basepath *from* `base` and bakes `"."` into both the
router and the server-function base.

### Why the router basepath has to be re-applied

Start's request handler calls `router.update({ …, basepath: ROUTER_BASEPATH })`
on every request, after `getRouter()` has returned. Setting `basepath` at
creation time is therefore not enough — the handler overwrites it. `getRouter`
wraps `update` so the runtime value wins, which also means the wiring survives
a future version that stops passing `basepath` at all.

### Why server functions need two edits

`SERVER_FN_BASE` is a literal in *both* bundles and they must agree. The client
half is movable through the documented `createStart({ serverFns: { fetch } })`
seam; the server half is not, so the entry strips the prefix back off before
Start's handler matches the URL. Page requests keep their prefix — the router
matches those with the same basepath the links were rendered with.

**Declaring a start instance disables Start's implicit CSRF middleware** (it is
only installed when no instance exists). `src/start-entry.ts` registers
`createCsrfMiddleware({ filter: ctx => ctx.handlerType === "serverFn" })`
explicitly to keep the behaviour identical; a cross-origin `POST` to a server
function still answers 403.

---

## Two bugs this found

**1. Better Auth was unreachable under a sub-path.** `createAuthOptions` passed
the issuer as `baseURL` (`http://host/idp`) and `"/api/auth"` as `basePath`,
on the assumption that the two concatenate. In 1.7.1 they do not: `withPath()`
appends `basePath` **only when `baseURL` has no path of its own**. The issuer
therefore mounted every endpoint at `/idp/*` and ignored `basePath` entirely,
so `/idp/api/auth/sign-in/email` answered 404 and no one could sign in — while
the host root, where `baseURL` has no path, worked perfectly. Fixed by passing
`paths.origin` as `baseURL` and `paths.authBasePath` as `basePath`, which makes
the sub-path resolve to exactly what the root resolves to.

**2. The favicon was probed at the origin root.** With no `site.favicon`
configured, nothing emitted `<link rel="icon">`, so the browser fell back to
`GET /favicon.ico` — the *origin* root, which under a sub-path deployment
belongs to somebody else's application. `UiContext.favicon` is now always set
and always mount-path-absolute, and `site.logo` / `site.favicon` are resolved
through `/branding` (CFG-1) instead of being handed to the browser raw.

---

## Exit criteria

Both mounts were served from the same `dist/`, against a throwaway schema
(`IDP_SCHEMA_NAME=idp_spike_s3`, P0'.2), with `scripts/spike-s3-proxy.ts`
standing in for Caddy — forwarding `/idp/*` **without stripping the prefix**
and answering 404 for everything else, so any leaked host-root URL fails the
way it would in production.

| Criterion | Host root | `/idp` behind the proxy |
|---|---|---|
| Page renders | `GET /login` 200 | `GET /idp/login` 200 |
| No 404 assets | all 200, incl. font and favicon | all 200, incl. font and favicon |
| Links prefixed | `href="/assets/…"` | `href="/idp/assets/…"` |
| Hydration | React fiber attached, no console errors | same |
| Client-side navigation | — | `router.navigate('/pending-approval')` → `/idp/pending-approval`, chunk from `/idp/assets/…` |
| Server function | `GET /_serverFn/<id>` 200 | `GET /idp/_serverFn/<id>` 200 |
| Sign-in | 303 → `/change-password?forced=1`, cookies `Path=/` | 303 → `/idp/change-password?forced=1`, cookies `Path=/idp` |
| Better Auth endpoints | `/api/auth/ok`, `/api/auth/jwks` 200 | `/idp/api/auth/ok`, `/idp/api/auth/jwks` 200 |

Sign-in stopped at the forced-change screen; the form was not submitted.

## Reproducing

```bash
pnpm --filter web build

# host root
IDP_SCHEMA_NAME=idp_spike_s3 IDP_BASE_URL=http://localhost:3000 \
  bun run apps/web/src/serve.ts

# sub-path, behind the stand-in proxy
IDP_SCHEMA_NAME=idp_spike_s3 IDP_BASE_URL=http://localhost:3100/idp \
  bun run apps/web/src/serve.ts
bun scripts/spike-s3-proxy.ts --port 3100 --mount /idp --target http://127.0.0.1:3000
```

## What this leaves for M12

- `src/serve.ts` is the wrapper the spike needed: `Bun.serve`, static files out
  of `dist/client` with the mount path stripped, immutable caching for hashed
  assets. OPS-4 draining, health-check exclusions and the SEC-5 request log are
  M11/M12's.
- `Caddyfile.subpath` proxies `{path}/*` without stripping, exactly as
  `scripts/spike-s3-proxy.ts` does, and adds the origin-root RFC 8414 route.
- One image, one tag set: the fallback of baking a base path per mount
  (spec-relevant deviation) is not needed.
