#!/usr/bin/env bash
# Prints the release notes for a tag: its section of CHANGELOG.md plus how to install or update.
# The same text is what administrators see under "What's new" in Settings, so it is written for them.
#   scripts/release-notes.sh v1.2.3 [owner/repo]
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

tag="${1:-}"
[[ "$tag" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)$ ]] || { echo "usage: $0 vX.Y.Z [owner/repo]" >&2; exit 2; }
version="${BASH_REMATCH[1]}"
repo="${2:-Installation-04/HomeVault}"
image="ghcr.io/$(printf '%s' "$repo" | tr '[:upper:]' '[:lower:]')"

awk -v header="## [$version]" 'index($0, header) == 1 { found = 1; next } found && /^## \[/ { exit } found { print }' CHANGELOG.md | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}'
cat <<NOTES

---

**Update an existing installation:** open *Settings → Administration* and press *Update*, or run \`./deploy.sh update\` on the server. A backup is made first and HomeVault goes back to the old version by itself if the new one doesn't start.

**New installation** (Linux, Raspberry Pi or NAS with Docker; amd64 and arm64):

\`\`\`sh
curl -fsSL https://raw.githubusercontent.com/$repo/main/install.sh | bash
\`\`\`

Image: \`$image:$version\` (linux/amd64, linux/arm64)
NOTES
