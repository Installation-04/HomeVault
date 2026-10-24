#!/usr/bin/env bash
# Runs the install wizard on a pseudo-terminal with a scripted "person", including bad input
# (invalid email, short password, mismatched confirmation), and checks the .env it writes.
# Nothing is started (--no-start), so this needs Docker only for its prerequisite checks.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
die() { printf '\033[31mFAIL:\033[0m %s\n' "$*" >&2; exit 1; }

mkdir "$WORK/inst"
(cd "$ROOT" && git ls-files -co --exclude-standard -z | tar --null -T - -cf -) | tar -xf - -C "$WORK/inst"
rm -f "$WORK/inst/.env"

# The answers; prompts that only exist on some machines are added when they will appear.
steps='[["Choose 1-3","2"],["Domain name","homevault-test.invalid"]'
if command -v getent >/dev/null 2>&1; then steps+=',["Continue anyway?","y"]'; fi
steps+=',["Data folder","./mydata"],["Choose 1-2","2"],["Set up email now?","y"],["SMTP server","smtp.example.com"],["SMTP port",""],["SMTP user name","mailer"],["SMTP password","s3cret-pass"],["Send mail from",""]'
steps+=',["Enable one-click updates?","y"]'
if command -v crontab >/dev/null 2>&1; then steps+=',["Make a full backup every night","n"]'; fi
steps+=',["Create the administrator now?","y"],["Your name","Ana Admin"],["Email address","bad-email"],["Email address","ana@example.com"]'
steps+=',["Password (typing","short"],["Password (typing","orbit-lantern-maple-71"],["Type it again","different-password-99"],["Password (typing","orbit-lantern-maple-71"],["Type it again","orbit-lantern-maple-71"],["Install now?","y"]]'

# No release lookup: an unreachable address makes the wizard take the "build from source" path.
SCRIPT="$steps" UPDATE_API_BASE="http://127.0.0.1:9" python3 "$ROOT/scripts/e2e/pty_drive.py" "$WORK/inst" ./deploy.sh wizard --no-start | tee "$WORK/session.txt"

env_file="$WORK/inst/.env"
expect() { grep -qx "$1" "$env_file" || die "expected '$1' in .env"; }
expect "DOMAIN=homevault-test.invalid"
expect "BIND_ADDRESS=127.0.0.1"
expect "TRUST_PROXY=1"
expect "FORCE_HTTPS=true"
expect "DATA_DIR=./mydata"
expect "DEFAULT_LOCALE=fr"
expect "SMTP_HOST=smtp.example.com"
expect "SMTP_PORT=587"
expect "SMTP_USER=mailer"
expect "SMTP_PASS=s3cret-pass"
expect "ENABLE_UPDATER=true"
expect "HOMEVAULT_IMAGE=homevault:latest"
[ "$(stat -c %a "$env_file")" = 600 ] || die ".env must be private (600)"
[ "$(grep -cE '^(APP_SECRET|DATA_KEY|SETUP_TOKEN)=.{8,}' "$env_file")" = 3 ] || die "secrets were not generated"
if grep -rq "orbit-lantern-maple-71" "$env_file"; then die "the admin password must not be stored in .env"; fi
grep -q "That doesn't look like an email address" "$WORK/session.txt" || die "the invalid email was not rejected"
grep -q "Too short" "$WORK/session.txt" || die "the short password was not rejected"
grep -q "The two passwords differ" "$WORK/session.txt" || die "the mismatch was not detected"
grep -q "orbit-lantern-maple-71" "$WORK/session.txt" && die "the typed password was echoed to the terminal"
echo "Wizard checks passed."
