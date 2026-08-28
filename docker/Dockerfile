# syntax=docker/dockerfile:1.7
#
# The image (OPS-1).
#
# Three stages, and the split is not decorative: `deps` holds the pnpm store
# and `node_modules`, `build` holds the toolchain, and `runtime` holds neither.
# What ships is the Vite output, a production dependency tree, the CLI bundle
# and `config.example/` with `config-schema/` — no source, no lockfile, no
# compilers.
#
# **Bun runs the application; Node never appears at runtime.** pnpm needs Node
# to install, so the build stages have both; the final stage has only Bun,
# which is also why the HEALTHCHECK is a Bun one-liner (OPS-3) — a slim image
# has no curl and adding one to run a health check is 10 MB for an HTTP GET
# that Bun already does.
#
# `--platform=$BUILDPLATFORM` on the build stages: the output is JavaScript, so
# cross-building it under emulation would be minutes of QEMU for a
# byte-identical result. Only the runtime stage is per-architecture.

# Exact version tags, not digests — the comment that used to sit here claimed
# "the digest is what Docker actually resolves", and there has never been a
# digest in this file. Tags are what resolve, so `oven/bun:1.3.12-slim` is
# pinned to a version and not to bytes.
#
# `BUN_VERSION` is the one that matters. Bun is not a build tool here, it is
# **the runtime**: the final stage is `oven/bun:<version>-slim`, Bun is PID 1,
# and on arm64 that is a different binary from the one CI runs. The version
# lives in `.bun-version` and is copied into four other files;
# `scripts/check-bun-version.ts` refuses a build where they disagree, because
# the smoke test passing on one Bun while the image ships another is a failure
# that only appears in somebody's deployment (**D73**).
ARG BUN_VERSION=1.3.12
ARG NODE_VERSION=22

# Named so the build stage can `COPY --from=bun`. A global `ARG` is in scope
# for a `FROM` line but not for a `COPY --from=<image>` inside a stage, where
# the reference is resolved before the ARG exists — the error is
# "invalid reference format", which does not say that.
#
# `--platform=$BUILDPLATFORM`, and it is load-bearing: the `build` stage below
# is pinned to the build platform, and it *executes* the binary copied out of
# here. Without the pin this stage is instantiated once per **target**
# platform, while `build` is instantiated once in total — so a
# `--platform=linux/amd64,linux/arm64` run hands the single build stage
# whichever `bun` one of the two passes resolved, and half the time that is the
# wrong architecture. It failed exactly that way on 2026-08-27, on the first
# multi-architecture build anybody had ever run: `qemu-x86_64: Could not open
# '/lib64/ld-linux-x86-64.so.2'`, which reads like a missing library and is an
# amd64 binary inside an arm64 root filesystem. The pin makes the borrowed
# binary match the rootfs that runs it, on any host. `runtime` below is
# deliberately **not** pinned — that stage is the artefact, and it is the one
# thing here that must be per-architecture.
FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION}-slim AS bun

# ---------------------------------------------------------------- deps --
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-slim AS deps
WORKDIR /repo

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# The version the repository declares. `corepack` reads it from package.json,
# so the image installs with the same pnpm the developer did.
RUN corepack enable

# Manifests first, so a change to application source does not invalidate the
# dependency layer. This is the whole reason the copy is split.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc* ./
COPY apps/web/package.json apps/web/
COPY packages/ui/package.json packages/ui/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# --------------------------------------------------------------- build --
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-slim AS build
WORKDIR /repo

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

# Bun, borrowed rather than installed. Vite needs Node to build, and the CLI
# has to be bundled by Bun so `--target=bun` resolves the same runtime the
# image executes it with — one statically linked binary is a cheaper way to
# have both than an install script that fetches one over the network at build
# time.
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /repo/packages/ui/node_modules ./packages/ui/node_modules
COPY . .

# Stamped into `server/version.ts` at build time, so `/healthz`, `idp version`
# and the admin system page all report the image that is actually running.
ARG IDP_VERSION=0.0.0-dev
ARG IDP_REVISION=
ENV IDP_VERSION=${IDP_VERSION}
ENV IDP_REVISION=${IDP_REVISION}

RUN pnpm --filter web run build

# The CLI and the entrypoint, each bundled to one file.
#
# Both are TypeScript that imports across `src/`, and the final stage has no
# `src/`. Copying `serve.ts` on its own produced exactly the error worth
# recording — `Cannot find module './server/config/loader' from
# '/app/serve.ts'` — on every restart, with the container reported only as
# "unhealthy".
#
# `dist/serve.js`, and not `dist/server/serve.js`: the wrapper locates the
# built handler and `dist/client` through `new URL("../dist/…",
# import.meta.url)`, so it has to sit exactly one level below `/app`. The
# `await import(entryPath)` inside it stays dynamic — the path is a runtime
# value — which is why the server bundle remains a separate file.
RUN cd apps/web \
    && bun build src/cli/index.ts --target=bun --outfile=/repo/apps/web/dist/idp.js \
    && bun build src/serve.ts --target=bun --outfile=/repo/apps/web/dist/serve.js

# Only what runtime needs: the `dist` output, the production dependency tree,
# and the migrations the entrypoint applies (OPS-5).
RUN pnpm --filter web deploy --legacy --prod /prod/web

# **`--prod` above does nothing, and `--legacy` is not optional** (**D76**).
#
# pnpm 10 refuses a non-injected workspace deploy without `--legacy`
# (`ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE`), and the legacy path copies the
# whole virtual store regardless of `--prod` — verified directly: `drizzle-kit`,
# `prettier`, `vitest` and three `esbuild` binaries all survive it, and so do
# they with `--prod` before the command, with injection forced on, and with
# `pnpm prune --prod` afterwards (which deletes the tree outright).
#
# So the build tooling is removed by name. Every entry is a compiler, a
# formatter, a test runner or a types package; none is reachable from what
# actually runs, because Vite and `bun build` have already produced it. The
# TST-8 smoke test is what proves that claim on every build — it starts the
# image, migrates, signs somebody in and mints a token, and a module this
# deleted would fail it.
#
# **`@hugeicons+*` is on the list and `lucide-react` deliberately is not**
# (**D86**). The free icon set is **148 MB** — one module per icon, several
# thousand of them — and it took the image to 374.8 MiB on the runner, 25 MiB
# over OPS-13's ceiling, on the first release that contained the database
# console. Vite *inlines* what the two components use: the built server chunk
# holds `Database01Icon`'s path data and imports nothing from the package, so
# in the image it is 148 MB of files nothing can reach. `lucide-react` is the
# opposite and stays — the server chunks really do
# `import { CheckIcon } from "lucide-react"`, and deleting it would break the
# first page that renders. Which of the two a dependency is decides whether it
# belongs here, and the built output answers it: grep the `from` specifiers in
# `apps/web/dist/server/assets/*.js` for everything the server still expects
# to find in node_modules.
#
# `set -e` with an explicit count, so a rename upstream fails the build here
# rather than silently reverting the saving.
RUN set -eu; cd /prod/web/node_modules/.pnpm; \
    before=$(du -sm . | cut -f1); \
    rm -rf esbuild@* @esbuild+* @rolldown+binding-* rolldown@* \
           drizzle-kit@* prettier@* vitest@* @vitest+* vite@* \
           lightningcss@* lightningcss-* caniuse-lite@* bun-types@* \
           typescript@* @types+* playwright@* @playwright+* \
           @hugeicons+*; \
    after=$(du -sm . | cut -f1); \
    echo "pruned build tooling: ${before} MB -> ${after} MB"; \
    if [ "$before" -le "$after" ]; then \
      echo "nothing was pruned — have these packages been renamed?" >&2; exit 1; \
    fi

# ------------------------------------------------------------- runtime --
FROM oven/bun:${BUN_VERSION}-slim AS runtime

# OCI labels (OPS-1). `revision` and `version` are per-build; the rest are not.
ARG IDP_VERSION=0.0.0-dev
ARG IDP_REVISION=
LABEL org.opencontainers.image.title="semantius-idp" \
      org.opencontainers.image.description="Self-hosted OpenID Connect identity provider" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/semantius/semantius-idp" \
      org.opencontainers.image.version="${IDP_VERSION}" \
      org.opencontainers.image.revision="${IDP_REVISION}"

ENV NODE_ENV=production \
    TZ=UTC \
    IDP_CONFIG_DIR=/config \
    IDP_VERSION=${IDP_VERSION} \
    IDP_REVISION=${IDP_REVISION}

WORKDIR /app

COPY --from=build /prod/web/node_modules ./node_modules
COPY --from=build /repo/apps/web/dist ./dist
COPY --from=build /repo/apps/web/drizzle ./drizzle
# CFG-1: the annotated defaults ship *inside* the image, so an operator can
# copy them out of a running container rather than hunting for the repository.
# The generated schemas come too, from their own folder — CFG-1 says they ship
# in the repository *and* the image, and they stopped being siblings of the
# examples when a copied `config/` proved to be the wrong place for a
# generated file.
COPY --from=build /repo/config.example ./config.example
COPY --from=build /repo/config-schema ./config-schema

# `idp` on the PATH, so `docker run <image> idp migrate` reads the way OPS-6
# writes it.
RUN printf '#!/bin/sh\nexec bun /app/dist/idp.js "$@"\n' > /usr/local/bin/idp \
    && chmod 0755 /usr/local/bin/idp

# `bun` the image already provides a non-root user of that name (uid 1000).
# Nothing under /app is writable by it: the only writable path is /tmp, which
# is a tmpfs the compose file supplies.
USER bun

EXPOSE 3000

# OPS-3. `IDP_HEALTH_URL` is derived by the compose file when the deployment
# sits under a sub-path; the default is the host root on the default port.
ENV IDP_HEALTH_URL=http://127.0.0.1:3000/healthz
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
    CMD bun -e 'const r = await fetch(process.env.IDP_HEALTH_URL); process.exit(r.ok ? 0 : 1)'

# Bun is PID 1 so SIGTERM reaches the drain (OPS-4). No shell form, no init
# wrapper: an `sh -c` in between would swallow the signal, which is the classic
# way a container that implements graceful shutdown never performs one.
ENTRYPOINT []
CMD ["bun", "/app/dist/serve.js"]
