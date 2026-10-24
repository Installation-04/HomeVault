#!/usr/bin/env bash
# HomeVault installer. Downloads HomeVault and starts the setup wizard:
#
#   curl -fsSL https://raw.githubusercontent.com/Installation-04/HomeVault/main/install.sh | bash
#
# It only needs bash, curl (or wget) and git (or tar). It puts HomeVault in ~/homevault
# (change with HOMEVAULT_DIR), checks out the newest release, then runs ./deploy.sh, which asks
# a few questions and does the rest. Run it again later to change settings; your data is kept.
#
# Environment:  HOMEVAULT_DIR   install folder (default ~/homevault)
#               HOMEVAULT_REPO  owner/name on GitHub (default Installation-04/HomeVault)
#               HOMEVAULT_REF   a release tag or branch to install instead of the newest release
# Anything after "bash -s --" is passed to deploy.sh, e.g.  ... | bash -s -- --domain home.example.com --yes

set -euo pipefail

REPO="${HOMEVAULT_REPO:-Installation-04/HomeVault}"
DIR="${HOMEVAULT_DIR:-$HOME/homevault}"
REF="${HOMEVAULT_REF:-}"

if [ -t 1 ]; then BOLD=$'\033[1m'; RED=$'\033[31m'; OFF=$'\033[0m'; else BOLD=""; RED=""; OFF=""; fi
say() { printf '%s\n' "$*"; }
die() { printf '%sError:%s %s\n' "$RED" "$OFF" "$*" >&2; exit 1; }

say "${BOLD}HomeVault installer${OFF}"

command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || die "curl or wget is needed to download HomeVault."
fetch() { if command -v curl >/dev/null 2>&1; then curl -fsSL -m 30 "$1"; else wget -qO- -T 30 "$1"; fi; }

# Which version? The newest published release unless HOMEVAULT_REF says otherwise.
if [ -z "$REF" ]; then
  api="${UPDATE_API_BASE:-https://api.github.com}"
  REF="$(fetch "$api/repos/$REPO/releases/latest" 2>/dev/null | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1 || true)"
  if [[ ! "$REF" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    say "No release found yet; using the main branch."
    REF="main"
  fi
fi
say "Version: $REF    Folder: $DIR"

if [ -f "$DIR/deploy.sh" ]; then
  say "HomeVault is already downloaded in $DIR."
else
  [ ! -e "$DIR" ] || [ -z "$(ls -A "$DIR" 2>/dev/null)" ] || die "$DIR exists and is not empty. Set HOMEVAULT_DIR to another folder."
  if command -v git >/dev/null 2>&1; then
    git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$REF" "https://github.com/$REPO.git" "$DIR" || die "Could not download $REF from github.com/$REPO."
  else
    command -v tar >/dev/null 2>&1 || die "git or tar is needed to unpack HomeVault."
    mkdir -p "$DIR"
    kind="tags"; [ "$REF" = main ] && kind="heads"
    fetch "https://github.com/$REPO/archive/refs/$kind/$REF.tar.gz" | tar -xz -C "$DIR" --strip-components=1 || die "Could not download $REF from github.com/$REPO."
    say "git is not installed, so this folder cannot fetch file updates itself; the Update button still updates the app."
  fi
fi

cd "$DIR"
chmod +x deploy.sh
# With no arguments: the wizard on a terminal, sensible defaults (ready-made image) without one.
if [ "$#" -eq 0 ]; then
  if ( : </dev/tty ) 2>/dev/null; then set -- install; else set -- install --yes --image auto; fi
fi
exec ./deploy.sh "$@"
