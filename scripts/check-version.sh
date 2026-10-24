#!/usr/bin/env bash
# Fails unless the release tag and the version in backend/ and frontend/ (package.json and the
# lockfiles) agree, so a release can't ship an app that reports the wrong version.
#   scripts/check-version.sh v1.2.3
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

tag="${1:-}"
[[ "$tag" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)$ ]] || { echo "usage: $0 vX.Y.Z" >&2; exit 2; }
want="${BASH_REMATCH[1]}"

status=0
for dir in backend frontend; do
  for file in package.json package-lock.json; do
    got="$(node -p "const j=require('./$dir/$file'); (file => file === 'package.json' ? j.version : j.packages[''].version)('$file')")"
    if [ "$got" != "$want" ]; then
      echo "$dir/$file says $got but the tag is $tag" >&2
      status=1
    fi
  done
done
grep -q "^## \[$want\]" CHANGELOG.md || { echo "CHANGELOG.md has no section for $want" >&2; status=1; }
[ "$status" = 0 ] && echo "Version $want is consistent."
exit "$status"
