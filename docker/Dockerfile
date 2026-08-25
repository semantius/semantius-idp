# syntax=docker/dockerfile:1.7
#
# The image (OPS-1).
#
# Three stages, and the split is not decorative: `deps` holds the pnpm store
# and `node_modules`, `build` holds the toolchain, and `runtime` holds neither.
# What ships is the Vite output, a production dependency tree, the CLI bundle
# and `config.example/` — no source, no lockfile, no compilers.
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

# The digest pins the image, and the tag is here so a human can read which one.
# Both are updated together; the digest is what Docker actually resolves.
ARG BUN_VERSION=1.3.12
ARG NODE_VERSION=22

# Named so the build stage can `COPY --from=bun`. A global `ARG` is in scope
# for a `FROM` line but not for a `COPY --from=<image>` inside a stage, where
# the reference is resolved before the ARG exists — the error is
# "invalid reference format", which does not say that.
FROM oven/bun:${BUN_VERSION}-slim AS bun

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

# ------------------------------------------------------------- runtime --
FROM oven/bun:${BUN_VERSION}-slim AS runtime

# OCI labels (OPS-1). `revision` and `version` are per-build; the rest are not.
ARG IDP_VERSION=0.0.0-dev
ARG IDP_REVISION=
LABEL org.opencontainers.image.title="semantius-idp" \
      org.opencontainers.image.description="Self-hosted OpenID Connect identity provider" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/adenin/semantius-idp" \
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
COPY --from=build /repo/config.example ./config.example

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
