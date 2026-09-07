#!/usr/bin/env bash
# idp-setup-env.sh — create ../.env from ../.env.example on first run, with
# UNIQUE secrets.
#
# This replaces the plain `cp ../.env.example ../.env` that idp-create used to
# do. The copy is the same; what changes is that every secret the example
# ships is replaced with a freshly generated value before the file is written:
#
#   IDP_SECRET                         signs sessions, encrypts the stored
#                                      signing keys
#   POSTGRES_PASSWORD                  the `postgres` superuser of the bundled
#                                      database
#   IDP_DB_PASSWORD                    the `idp` application role — written
#                                      here AND into the same line of
#                                      DATABASE_URL, because the IdP reads the
#                                      URL and Postgres reads the variable, and
#                                      the two have to agree (the whole-string contract still holds:
#                                      the application is handed one whole
#                                      string and assembles nothing)
#   EXAMPLE_WEB_CLIENT_SECRET          the two example clients' secrets
#   EXAMPLE_FIRSTPARTY_CLIENT_SECRET
#
# WHY AT .env CREATION and not later: all of them are load-bearing BEFORE the
# first boot. IDP_SECRET encrypts the stored signing keys, so changing it
# afterwards signs everyone out and makes those keys undecryptable; the two
# passwords are baked into the database by the image's init scripts, which
# run ONCE per data directory. Generating them here makes the secure state the
# DEFAULT state instead of a step nobody reads — and it removes the one edit
# (`IDP_SECRET=` was shipped empty) that a first `idp-create` used to fail on.
#
# IDEMPOTENT: an existing .env is never touched — no overwrite, no
# re-generation, and an old one with an empty IDP_SECRET is left exactly as it
# is. Delete .env (or edit it) if you want different values.
#
# The Windows twin is idp-setup-env.cmd, which hands off to idp-setup-env.ps1.
#
# Usage:
#   ./idp-setup-env.sh      create ../.env with generated secrets, or leave the existing one alone
set -euo pipefail
cd "$(dirname "$0")"

if [ -f ../.env ]; then
  echo ".env already exists — leaving it untouched."
  exit 0
fi

[ -f ../.env.example ] || { echo "idp-setup-env: .env.example is missing." >&2; exit 1; }

# URL-SAFE by construction: IDP_DB_PASSWORD is spliced into DATABASE_URL, and
# anything from `@ : / ? #` or a space would break the URL. Hex avoids the lot
# — note `openssl rand -base64` does NOT: it emits `/` and `+`. The superuser's
# password is never in a URL, but one alphabet for both is one fewer thing to
# reason about.
gen_urlsafe() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
  else
    LC_ALL=C tr -dc 'a-f0-9' < /dev/urandom 2>/dev/null | head -c 48 || true
  fi
}

# IDP_SECRET is read straight from the environment and never spliced into a
# URL, so the full base64 alphabet is fine, and 48 bytes clears the ">= 32
# random bytes" the IdP requires with room to spare.
gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 48 | tr -d '\n'
  else
    LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom 2>/dev/null | head -c 64 || true
  fi
}

# A client secret is presented in a POST body or a Basic header, where `+` and
# `/` survive but `=` and `/` are exactly what a hand-typed curl gets wrong.
# base64url of 48 bytes is 64 characters with no padding and nothing to escape.
gen_client_secret() {
  gen_secret | tr '+/' '-_'
}

idp_secret="$(gen_secret)"
pg_password="$(gen_urlsafe)"
db_password="$(gen_urlsafe)"
web_secret="$(gen_client_secret)"
firstparty_secret="$(gen_client_secret)"

# 32 chars is well short of what either generator produces; this only catches a
# box with neither openssl nor a readable /dev/urandom, where a SHORT or EMPTY
# secret would otherwise be written out and silently accepted.
for v in "$idp_secret" "$pg_password" "$db_password" "$web_secret" "$firstparty_secret"; do
  if [ "${#v}" -lt 32 ]; then
    echo "idp-setup-env: could not generate a secret (no openssl, no usable /dev/urandom)." >&2
    echo "Install openssl, or copy .env.example to .env and set the secrets by hand." >&2
    exit 1
  fi
done

# Written to a temp file and moved into place, so an interrupted run cannot
# leave a half-substituted .env behind — which would boot with an example
# value still in it. `|` as the sed delimiter: absent from hex, base64 and
# base64url alike, as is `&` (which would otherwise expand to the match in the
# replacement).
#
# The DATABASE_URL line is edited in place rather than rewritten: only the
# password between `idp:` and `@postgres:5432/idp` changes, so a host, port or
# query string the example carries stays exactly as shipped.
tmp="$(mktemp ../.env.tmp.XXXXXX)"
trap 'rm -f "$tmp"' EXIT

sed -e "s|^IDP_SECRET=.*|IDP_SECRET=${idp_secret}|" \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${pg_password}|" \
    -e "s|^IDP_DB_PASSWORD=.*|IDP_DB_PASSWORD=${db_password}|" \
    -e "s|^\(DATABASE_URL=postgres://idp:\)[^@]*\(@postgres:5432/idp\)|\1${db_password}\2|" \
    -e "s|^EXAMPLE_WEB_CLIENT_SECRET=.*|EXAMPLE_WEB_CLIENT_SECRET=${web_secret}|" \
    -e "s|^EXAMPLE_FIRSTPARTY_CLIENT_SECRET=.*|EXAMPLE_FIRSTPARTY_CLIENT_SECRET=${firstparty_secret}|" \
    ../.env.example > "$tmp"

# The substitutions are silent when a key is absent (a renamed variable, an
# .env.example edited to comment one out), which would ship a stack with an
# example value where the reader assumes a generated one. Fail instead — and
# check the URL by its generated password, because a DATABASE_URL that no
# longer has the `idp:…@postgres:5432/idp` shape was not spliced either.
for key in IDP_SECRET POSTGRES_PASSWORD IDP_DB_PASSWORD EXAMPLE_WEB_CLIENT_SECRET EXAMPLE_FIRSTPARTY_CLIENT_SECRET; do
  if ! grep -qE "^${key}=.+" "$tmp"; then
    echo "idp-setup-env: .env.example has no uncommented ${key}= line — nothing was generated for it." >&2
    exit 1
  fi
done
if ! grep -qF "DATABASE_URL=postgres://idp:${db_password}@postgres:5432/idp" "$tmp"; then
  echo "idp-setup-env: .env.example has no DATABASE_URL=postgres://idp:…@postgres:5432/idp line — the database password was not spliced into it." >&2
  exit 1
fi

mv "$tmp" ../.env
trap - EXIT
chmod 600 ../.env 2>/dev/null || true

echo "Created .env from .env.example, with freshly generated values for"
echo "  IDP_SECRET, POSTGRES_PASSWORD, IDP_DB_PASSWORD (also inside DATABASE_URL),"
echo "  EXAMPLE_WEB_CLIENT_SECRET and EXAMPLE_FIRSTPARTY_CLIENT_SECRET."
echo "They are in .env (gitignored) — that is the only copy. Read the superuser password with:"
echo "  grep '^POSTGRES_PASSWORD=' ../.env"
