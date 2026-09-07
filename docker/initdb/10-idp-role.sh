#!/usr/bin/env bash
# Creates the role the IdP connects as, without SUPERUSER.
#
# The bundled Postgres used to make `idp` the bootstrap superuser: one role,
# owning everything, because a second one was judged deployment-invasive.
# That same role sat behind `/admin/database`, and a superuser inside a
# `BEGIN READ ONLY` transaction still runs `COPY … TO PROGRAM` and
# `pg_read_file` — the console's read-only mode was a promise about the
# database and said nothing about the host it runs on. So the superuser is
# `postgres` now, this script creates `idp` without that attribute, and the
# credential inside `DATABASE_URL` can no longer leave SQL.
#
# What the role gets, and why exactly this:
#
#   LOGIN                                 the IdP connects as it
#   NOSUPERUSER NOCREATEROLE NOCREATEDB   the point
#   CONNECT, CREATE ON DATABASE           boot runs `create schema if not
#                                         exists` (migrate.ts), an
#                                         IDP_SCHEMA_NAME throwaway creates a
#                                         second one, and `pnpm drizzle:reset`
#                                         drops one. A schema takes CREATE on
#                                         the database; the role then *owns*
#                                         every schema it creates, and an
#                                         owner can drop its own. Nothing on
#                                         `public` — the IdP never puts
#                                         anything there, and Postgres
#                                         15+ withholds it anyway.
#
# The postgres image runs this directory exactly once, on an EMPTY data
# directory, as POSTGRES_USER against POSTGRES_DB. An existing volume never
# sees it: its `idp` stays the superuser it was initialized as, and the IdP
# says so at start-up (the start-up warning). `idp-destroy` (all data) and a fresh
# `idp-create` is the way onto this layout.
#
# `IDP_DB_PASSWORD` arrives from the compose file. `psql -v` binds it as a
# variable and `:'pw'` interpolates it as a quoted literal, so a password with
# a quote in it becomes a password with a quote in it, not SQL. The generated
# one is hex and could not carry one; the operator's need not be.
#
# The entrypoint *executes* this file when it is executable and *sources* it
# when it is not — and a checkout on Linux is 644 unless git carries the bit
# (`git update-index --chmod=+x`). So no `set -u` and no `exit`: sourced, both
# would land in the entrypoint's own shell, which does not expect either.
# `-e` and `pipefail` it already has; restating them costs nothing when run.
set -eo pipefail

: "${IDP_DB_PASSWORD:?IDP_DB_PASSWORD must be set (docker-compose.yml defaults it)}"

psql -v ON_ERROR_STOP=1 -v pw="$IDP_DB_PASSWORD" -v db="$POSTGRES_DB" \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
create role idp login nosuperuser nocreaterole nocreatedb password :'pw';
grant connect, create on database :"db" to idp;
SQL
