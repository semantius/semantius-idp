#!/usr/bin/env bash
# Cut a release: bump the version, tag it, push the tag.
#
# Pushing the tag is the entire trigger. `.github/workflows/release.yml` then
# builds amd64 + arm64, smoke-tests the image, scans it, pushes it to
# ghcr.io/<owner>/semantius-idp and creates the GitHub Release. Nothing is
# built or pushed locally here.
#
# The git tag is the source of truth for a version — the image tags
# (0.1.0 / 0.1 / 0 / latest / sha-<commit>) are derived from it by
# `docker/metadata-action`. `package.json` is bumped here because the release
# workflow's first job **refuses a tag that disagrees with it**: the image
# stamps `IDP_VERSION` from the tag and `/healthz`, `idp version` and
# `/admin/system` all report it, so a tree claiming one version while the
# artifact claims another is a running deployment nobody can trace back to a
# commit (**D73**).
#
# The same shape as `semantius-app`'s `docker/release.sh`, which has cut three
# releases. Two deliberate differences, both because this repository's workflow
# is stricter than that one's:
#
#   * a **pre-release is allowed** here (`v0.2.0-rc.1`). That script refuses
#     one because its workflow tags `latest` unconditionally; this workflow
#     derives `latest` from whether the version is a pre-release, so a release
#     candidate publishes as itself and takes neither `0.2`, `0` nor `latest`;
#   * **three files are bumped**, not one — the root manifest the workflow
#     checks, `apps/web`'s, and `version.ts`'s development fallback, which is
#     what a non-image run of `idp version` reports.
#
# Usage: docker/release.sh v0.1.0 [-y]
set -euo pipefail
cd "$(dirname "$0")/.."

die() { printf 'release: %s\n' "$*" >&2; exit 1; }

VERSION="${1:-}"
[ -n "$VERSION" ] || die "usage: docker/release.sh vX.Y.Z[-pre] [-y]"

ASSUME_YES=0
case "${2:-}" in
  -y|--yes) ASSUME_YES=1 ;;
  "") ;;
  *) die "unknown option: $2" ;;
esac

# The same grammar the workflow's `guard` job enforces, checked here so the
# refusal arrives before the tag is pushed rather than thirty seconds after.
[[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] \
  || die "version must look like v1.2.3 or v1.2.3-rc.1 (got '$VERSION')"
NUMBER="${VERSION#v}"
CORE="${NUMBER%%-*}"
PRERELEASE=0
[ "$NUMBER" != "$CORE" ] && PRERELEASE=1

git fetch --quiet --tags origin

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" != "HEAD" ] || die "detached HEAD — check out a branch first"

git diff --quiet && git diff --cached --quiet \
  || die "uncommitted changes to tracked files — commit or stash first"

UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)" \
  || die "branch '$BRANCH' has no upstream — push it first"
[ "$(git rev-parse HEAD)" = "$(git rev-parse '@{u}')" ] \
  || die "HEAD differs from $UPSTREAM — push/pull first; the tag must point at a commit the remote has"

# `cmd && die` would abort under `set -e` when cmd fails, so both existence
# checks are explicit ifs.
if git rev-parse -q --verify "refs/tags/$VERSION" >/dev/null 2>&1; then
  die "tag $VERSION already exists locally"
fi
if [ -n "$(git ls-remote --tags origin "refs/tags/$VERSION")" ]; then
  die "tag $VERSION already exists on origin"
fi

LATEST="$(git tag --list 'v*' | sort -V | tail -1)"
if [ -n "$LATEST" ] && [ "$(printf '%s\n%s\n' "$LATEST" "$VERSION" | sort -V | tail -1)" != "$VERSION" ]; then
  die "$VERSION is not newer than the latest tag $LATEST"
fi

pkg_version() { sed -n 's/^  "version": "\(.*\)",$/\1/p' "$1" | head -1; }
CURRENT="$(pkg_version package.json)"

# CHANGELOG.md's section for this version becomes the GitHub release body. An
# absent one is not fatal — the workflow falls back to generated notes — but it
# is almost always a mistake worth seeing before the tag is pushed.
NOTES_LINES="$(awk -v v="$CORE" '
  index($0, "## [" v "]") == 1 { grab = 1; next }
  grab && /^## / { exit }
  grab && /^\[[^]]+\]: / { exit }
  grab { print }
' CHANGELOG.md | wc -l | tr -d ' ')"
if [ "$NOTES_LINES" -gt 0 ]; then
  NOTES="CHANGELOG.md [$CORE], $NOTES_LINES lines"
else
  NOTES="none in CHANGELOG.md for [$CORE] — the release will use generated notes"
fi

# Advisory only. It cannot gate — `gh` may be absent, the run may still be in
# flight — but "the gates were green on the commit being tagged" is the first
# line of docs/release.md, and this is the moment to look at it.
CI="not checked (gh not on PATH)"
if command -v gh >/dev/null 2>&1; then
  CI="$(gh run list --commit "$(git rev-parse HEAD)" --limit 5 \
        --json workflowName,conclusion,status \
        --jq '[.[] | "\(.workflowName)=\(.conclusion // .status)"] | join(" ")' 2>/dev/null)" \
    || CI="not checked (gh call failed)"
  [ -n "$CI" ] || CI="no runs recorded for this commit"
fi

# No concrete `sha-<commit>` here on purpose: a version bump below adds a
# commit, so the tag lands on something this line cannot yet name. Printing
# today's HEAD would be a plan that quietly disagrees with what gets published.
if [ "$PRERELEASE" -eq 1 ]; then
  IMAGE_TAGS=":$NUMBER :sha-<commit> only (pre-release: no $CORE, no ${CORE%.*}, no latest)"
else
  IMAGE_TAGS=":$NUMBER :${NUMBER%.*} :${NUMBER%%.*} :latest :sha-<commit>"
fi

printf '\n  release    %s%s\n  commit     %s  %s\n  branch     %s (in sync with %s)\n  version    package.json %s -> %s\n  ci         %s\n  notes      %s\n  publishes  ghcr.io/<owner>/semantius-idp %s\n             + GitHub Release %s, amd64 and arm64\n\n' \
  "$VERSION" "$([ "$PRERELEASE" -eq 1 ] && printf '  (pre-release)')" \
  "$(git rev-parse --short HEAD)" "$(git log -1 --format=%s)" \
  "$BRANCH" "$UPSTREAM" "${CURRENT:-?}" "$CORE" \
  "$CI" "$NOTES" "$IMAGE_TAGS" "$VERSION"

if [ "$ASSUME_YES" -eq 0 ] && [ -t 0 ]; then
  read -r -p "proceed? [y/N] " reply
  case "$reply" in y|Y|yes|YES) ;; *) die "aborted" ;; esac
fi

# The workflow compares the tag's `X.Y.Z` against the root manifest, so a
# pre-release bumps to the core version and not to `0.2.0-rc.1`.
if [ "$CURRENT" != "$CORE" ]; then
  # Surgical edits: a JSON round-trip would reformat the whole file, and
  # `version.ts` is source. Each one is verified, because a silent no-op here
  # is a tag the workflow refuses.
  for manifest in package.json apps/web/package.json; do
    sed -i "0,/^  \"version\": \".*\",$/s//  \"version\": \"$CORE\",/" "$manifest"
    [ "$(pkg_version "$manifest")" = "$CORE" ] \
      || die "failed to bump $manifest (still '$(pkg_version "$manifest")')"
  done

  FALLBACK=apps/web/src/server/version.ts
  sed -i "s/process.env.IDP_VERSION ?? \"[^\"]*\"/process.env.IDP_VERSION ?? \"$CORE-dev\"/" "$FALLBACK"
  grep -q "IDP_VERSION ?? \"$CORE-dev\"" "$FALLBACK" || die "failed to bump $FALLBACK"

  git add package.json apps/web/package.json "$FALLBACK"
  git commit -q -m "chore(release): $VERSION"
  git push -q origin "$BRANCH"
  echo "bumped to $CORE and pushed chore(release): $VERSION"
fi

# Signed if this machine is set up to sign, annotated if not. docs/release.md
# asks for `-s`; failing the release outright on a machine with no key would be
# the wrong way to enforce it, and an unsigned annotated tag still carries a
# tagger and a message.
#
# The fallback matters more than it looks: by this point the bump commit has
# already been **pushed**. A configured-but-unusable key — locked agent, gpg
# missing, a key that lives on the other machine — would abort here under
# `set -e` and leave the branch bumped and the release untagged, which is the
# one state that needs a human to unpick. So a failed `-s` degrades to `-a`
# and says so, rather than stranding the release half-made.
if [ -n "$(git config user.signingkey || true)" ] || [ "$(git config tag.gpgsign || true)" = "true" ]; then
  if git tag -s "$VERSION" -m "Release $VERSION" 2>/dev/null; then
    echo "tagged $VERSION (signed)"
  else
    git tag -a "$VERSION" -m "Release $VERSION"
    echo "tagged $VERSION (annotated — signing was configured but failed; re-tag by hand if a signature is required)"
  fi
else
  git tag -a "$VERSION" -m "Release $VERSION"
  echo "tagged $VERSION (annotated; no signing key configured)"
fi
git push origin "$VERSION"

ORIGIN="$(git remote get-url origin)"
case "$ORIGIN" in
  *github.com*)
    REPO="$(printf '%s' "$ORIGIN" | sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##')"
    printf '\npushed %s — CI is building. Verify:\n  actions  https://github.com/%s/actions/workflows/release.yml\n  release  https://github.com/%s/releases/tag/%s\n  image    https://github.com/%s/pkgs/container/%s\n' \
      "$VERSION" "$REPO" "$REPO" "$VERSION" "$REPO" "${REPO#*/}"
    ;;
  *) printf '\npushed %s to %s\n' "$VERSION" "$ORIGIN" ;;
esac
