#!/usr/bin/env bash
# End-to-end test of the in-app update, with everything real except GitHub itself:
#   - a local image registry holds HomeVault 1.0.0 and 1.0.1 (and a deliberately broken 1.0.2),
#   - a local git repository with matching tags is the "release" source for the file refresh,
#   - a tiny mock plays the GitHub releases API,
#   - HomeVault is installed with ./deploy.sh (with the updater helper), and an administrator
#     then updates it through the same API the Settings page uses.
# Checks: success (1.0.0 -> 1.0.1, files and updater image follow), then rollback when 1.0.2 does not start.
#
#   scripts/e2e-update.sh            run both
#   scripts/e2e-update.sh success    only the successful update
# Environment: REGISTRY_IMAGE (default registry:2), E2E_NODE_IMAGE (base image override), REG_PORT, API_PORT, APP_PORT.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-all}"
REG_PORT="${REG_PORT:-5000}"
API_PORT="${API_PORT:-18999}"
APP_PORT="${APP_PORT:-18081}"
REGISTRY_IMAGE="${REGISTRY_IMAGE:-registry:2}"
EMAIL="admin@e2e.test"
PASSWORD="orbit-lantern-maple-71"
WORK="$(mktemp -d)"
STATE="$WORK/state.json"
MOCK_PID=""
BUILD_ARGS=()
[ -z "${E2E_NODE_IMAGE:-}" ] || BUILD_ARGS=(--build-arg "NODE_IMAGE=$E2E_NODE_IMAGE")

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31mFAIL:\033[0m %s\n' "$*" >&2; exit 1; }

cleanup() {
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "--- updater log" >&2; docker logs --tail 40 homevault-updater >&2 2>&1 || true
    echo "--- app log" >&2; docker logs --tail 20 homevault >&2 2>&1 || true
  fi
  [ -z "$MOCK_PID" ] || kill "$MOCK_PID" 2>/dev/null || true
  if [ -x "$WORK/inst/deploy.sh" ]; then (cd "$WORK/inst" && ./deploy.sh uninstall --purge --yes >/dev/null 2>&1) || true; fi
  docker rm -f hv-e2e-registry homevault homevault-updater homevault-updater-swap >/dev/null 2>&1 || true
  rm -rf "$WORK" 2>/dev/null || true
  exit "$rc"
}
trap cleanup EXIT

for tool in docker git node curl; do command -v "$tool" >/dev/null 2>&1 || die "$tool is required"; done

step "Local registry"
docker rm -f hv-e2e-registry >/dev/null 2>&1 || true
docker run -d --name hv-e2e-registry -p "127.0.0.1:$REG_PORT:5000" "$REGISTRY_IMAGE" >/dev/null
for _ in $(seq 1 30); do curl -fsS "http://localhost:$REG_PORT/v2/" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "http://localhost:$REG_PORT/v2/" >/dev/null || die "the registry did not start"

step "Release sources: a git repository with tags v1.0.0, v1.0.1 and a broken v1.0.2"
mkdir "$WORK/src"
(cd "$ROOT" && git ls-files -co --exclude-standard -z | tar --null -T - -cf -) | tar -xf - -C "$WORK/src"
git_src() { git -C "$WORK/src" -c user.email=e2e@test -c user.name=e2e "$@"; }
git -C "$WORK/src" init -q -b main
git_src add -A && git_src commit -qm "v1.0.0" && git_src tag v1.0.0
echo "# changed in 1.0.1" >>"$WORK/src/deploy/Caddyfile"
git_src commit -qam "v1.0.1" && git_src tag v1.0.1
sed -i '1i throw new Error("simulated broken release");' "$WORK/src/backend/src/server.js"
git_src commit -qam "v1.0.2 (broken)" && git_src tag v1.0.2

step "Building and publishing images (app + updater) for each version"
for v in 1.0.0 1.0.1 1.0.2; do
  git_src checkout -q "v$v"
  docker build -q "${BUILD_ARGS[@]}" --build-arg "VERSION=v$v" -t "localhost:$REG_PORT/test/homevault:$v" "$WORK/src" >/dev/null
  docker build -q --build-arg "VERSION=v$v" -t "localhost:$REG_PORT/test/homevault-updater:$v" "$WORK/src/updater" >/dev/null
  docker push -q "localhost:$REG_PORT/test/homevault:$v" >/dev/null
  docker push -q "localhost:$REG_PORT/test/homevault-updater:$v" >/dev/null
  docker rmi -f "localhost:$REG_PORT/test/homevault:$v" "localhost:$REG_PORT/test/homevault-updater:$v" >/dev/null 2>&1 || true
  echo "  published $v"
done
git_src checkout -q v1.0.0

step "Mock GitHub (newest release: v1.0.0)"
echo '{"tag":"v1.0.0"}' >"$STATE"
# Something else already answering on the port would silently play the part of GitHub.
if curl -fsS -m 2 "http://127.0.0.1:$API_PORT/" >/dev/null 2>&1 || curl -s -m 2 -o /dev/null "http://127.0.0.1:$API_PORT/"; then
  die "port $API_PORT is already in use; set API_PORT to a free port"
fi
node "$ROOT/scripts/e2e/mock-github.mjs" "$API_PORT" "$STATE" >"$WORK/mock.log" 2>&1 &
MOCK_PID=$!
sleep 1
kill -0 "$MOCK_PID" 2>/dev/null || die "the GitHub mock did not start: $(cat "$WORK/mock.log")"
GATEWAY="$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')"
curl -fsS "http://127.0.0.1:$API_PORT/repos/test/homevault/releases/latest" >/dev/null || die "the mock did not start"

step "Installing v1.0.0 with the updater: ./deploy.sh install"
git clone -q --depth 1 --branch v1.0.0 "file://$WORK/src" "$WORK/inst"
git clone -q --bare "$WORK/src" "$WORK/inst/.origin"
git -C "$WORK/inst" remote set-url origin "file://$WORK/inst/.origin"
printf '%s\n' "$PASSWORD" >"$WORK/adminpw"
(cd "$WORK/inst" && ./deploy.sh install --yes --image "localhost:$REG_PORT/test/homevault:1.0.0" --updater --port "$APP_PORT" \
  --set UPDATE_REPO=test/homevault --set "UPDATE_API_BASE=http://$GATEWAY:$API_PORT" \
  --admin-email "$EMAIL" --admin-name "E2E Admin" --admin-password-file "$WORK/adminpw" --no-schedule)

BASE="http://127.0.0.1:$APP_PORT"
drive() { node "$ROOT/scripts/e2e/drive-update.mjs" "$BASE" "$STATE" "$1" "$2" "$EMAIL" "$PASSWORD"; }

if [ "$MODE" = all ] || [ "$MODE" = success ]; then
  step "Update 1.0.0 -> 1.0.1 through the app (must succeed)"
  drive v1.0.1 success
  grep -q "changed in 1.0.1" "$WORK/inst/deploy/Caddyfile" || die "the release files were not refreshed to v1.0.1"
  [ "$(git -C "$WORK/inst" describe --tags)" = v1.0.1 ] || die "the checkout is not at v1.0.1"
  grep -qx "HOMEVAULT_IMAGE=localhost:$REG_PORT/test/homevault:1.0.1" "$WORK/inst/.env" || die ".env still points at the old image"
  compgen -G "$WORK/inst/backups/homevault-backup-pre-update-*.tar.gz" >/dev/null || die "no backup was taken before the update"
  echo "  files, .env and backup are right; waiting for the updater to switch to its new image"
  for _ in $(seq 1 60); do
    [ "$(docker inspect --format '{{.Config.Image}}' homevault-updater 2>/dev/null || true)" = "localhost:$REG_PORT/test/homevault-updater:1.0.1" ] && break
    sleep 3
  done
  [ "$(docker inspect --format '{{.Config.Image}}' homevault-updater)" = "localhost:$REG_PORT/test/homevault-updater:1.0.1" ] || die "the updater did not switch to its new image"
  for _ in $(seq 1 20); do [ -f "$WORK/inst/data/.update/heartbeat" ] && grep -q '^1.0.1' "$WORK/inst/data/.update/heartbeat" && break; sleep 3; done
  grep -q '^1.0.1' "$WORK/inst/data/.update/heartbeat" || die "the new updater is not reporting in"
fi

if [ "$MODE" = all ] || [ "$MODE" = rollback ]; then
  step "Update to a release that does not start (must roll back and keep running)"
  drive v1.0.2 rolled_back
  [ "$(git -C "$WORK/inst" describe --tags)" != v1.0.2 ] || die "the files were left on the broken release"
  curl -fsS "$BASE/api/health" | grep -q '"status":"ok"' || die "the app is not healthy after the rollback"
fi

step "All end-to-end update checks passed"
