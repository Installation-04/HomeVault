#!/usr/bin/env bash
# HomeVault updater: waits for an update request and applies it with ./deploy.sh update.
#
#   /updates/heartbeat     written every few seconds so the app knows this helper is alive
#   /updates/request.json  written by the app after an administrator confirmed with their password
#   /updates/status.json   progress and result, read by the app and shown in Settings
#
# The request is only a trigger. The version to install is looked up from the project's
# releases by deploy.sh itself, and the request's "target" must be a plain version number.

set -uo pipefail

UPDATES="${UPDATES_DIR:-/updates}"
PROJECT="${HV_DIR:?HV_DIR is not set}"
VERSION="${HOMEVAULT_VERSION:-dev}"
POLL_SECONDS=5
LOG="$(mktemp /tmp/updater-log.XXXXXX)"
LAST_HANDLED=""

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
say() { printf '[updater %s] %s\n' "$(now)" "$*"; }

# write_status STATE ID FROM TO STEP MESSAGE STARTED [FINISHED]
write_status() {
  local log_json
  log_json="$(tail -n 40 "$LOG" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | jq -R . | jq -s . 2>/dev/null || echo '[]')"
  jq -n --arg state "$1" --arg id "$2" --arg from "$3" --arg to "$4" --arg step "$5" --arg message "$6" \
    --arg started "$7" --arg finished "${8:-}" --argjson log "$log_json" \
    '{state:$state, request_id:$id, from:$from, to:$to, step:$step, message:$message, started_at:$started, finished_at:$finished, log:$log}' \
    >"$UPDATES/status.json.tmp" && mv -f "$UPDATES/status.json.tmp" "$UPDATES/status.json"
  chmod 644 "$UPDATES/status.json" 2>/dev/null || true
}

current_version() {
  # Version of the running app image, e.g. "1.0.0"; empty when unknown.
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' homevault 2>/dev/null | sed -n 's/^HOMEVAULT_VERSION=v\{0,1\}//p' | head -n 1
}

# Compose would stop this very container half way through replacing it, so the swap to a newer
# updater image is handed to a short-lived helper (same image, same access) that outlives us.
swap_self() {
  local image want have
  image="$(sed -n 's/^UPDATER_IMAGE=//p' "$PROJECT/.env" 2>/dev/null | tail -n 1)"
  [ -n "$image" ] || return 0
  have="$(docker inspect --format '{{.Image}}' homevault-updater 2>/dev/null || true)"
  want="$(docker image inspect --format '{{.Id}}' "$image" 2>/dev/null || true)"
  [ -n "$want" ] && [ "$want" != "$have" ] || return 0
  say "switching to the new updater image $image"
  docker rm -f homevault-updater-swap >/dev/null 2>&1 || true
  docker run -d --rm --name homevault-updater-swap --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
    --user "$(id -u):$(id -g)" --group-add "$(stat -c %g /var/run/docker.sock)" -e HOME=/tmp \
    -v "${DOCKER_SOCKET:-/var/run/docker.sock}:/var/run/docker.sock" -v "$PROJECT:$PROJECT" -w "$PROJECT" \
    --entrypoint sh "$image" -c 'sleep 3; docker compose --profile updater up -d --no-deps updater' >/dev/null 2>&1 \
    || say "could not start the swap helper; run ./deploy.sh updater enable to finish"
}

apply_request() {
  local request="$UPDATES/request.json" id target from started rc pid step
  if [ ! -s "$request" ] || [ "$(stat -c %s "$request")" -gt 4096 ]; then rm -f "$request"; return; fi
  id="$(jq -r '.id // empty' "$request" 2>/dev/null)"
  # A request that could not be deleted must never be applied twice.
  if [ -n "$id" ] && [ "$id" = "$LAST_HANDLED" ]; then rm -f "$request" 2>/dev/null; return; fi
  target="$(jq -r '.target // empty' "$request" 2>/dev/null)"
  started="$(now)"
  from="$(current_version)"

  if [[ ! "$id" =~ ^[A-Za-z0-9-]{1,64}$ ]] || [[ ! "$target" =~ ^v[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$ ]]; then
    : >"$LOG"
    write_status failed "${id:0:64}" "$from" "" "" "The update request was malformed and was ignored." "$started" "$(now)"
    rm -f "$request" 2>/dev/null
    say "ignored a malformed request"
    return
  fi

  say "updating ${from:-?} -> $target (request $id)"
  : >"$LOG"
  write_status updating "$id" "$from" "${target#v}" "Starting" "" "$started"

  # Run the same command an administrator would run on the server. Its "==> ..." lines
  # become the visible progress steps.
  ( cd "$PROJECT" && ./deploy.sh update --to "$target" --yes --from-updater ) >"$LOG" 2>&1 &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    step="$(grep -E '^==> ' "$LOG" | tail -n 1 | sed 's/^==> //')"
    write_status updating "$id" "$from" "${target#v}" "${step:-Working}" "" "$started"
    sleep 2
  done
  wait "$pid"
  rc=$?

  local message state
  message="$(sed 's/\x1b\[[0-9;]*m//g' "$LOG" | grep -vE '^\s*$' | tail -n 1 | sed 's/^Error: //')"
  case "$rc" in
    0) state=success; message="HomeVault is now on ${target#v}." ;;
    3) state=rolled_back ;;
    *) state=failed ;;
  esac
  write_status "$state" "$id" "$from" "${target#v}" "" "$message" "$started" "$(now)"
  LAST_HANDLED="$id"
  rm -f "$request" || say "could not remove the request file (ignored from now on)"
  say "update finished: $state (exit $rc)"

  # A new release may also ship a new updater image: switch to it last (this ends this process).
  if [ "$state" = success ]; then swap_self; fi
}

# An update interrupted by a restart of this helper must not look "in progress" forever.
if [ -s "$UPDATES/status.json" ] && [ "$(jq -r .state "$UPDATES/status.json" 2>/dev/null)" = updating ] && [ ! -e "$UPDATES/request.json" ]; then
  : >"$LOG"
  write_status failed "$(jq -r '.request_id // ""' "$UPDATES/status.json")" "$(jq -r '.from // ""' "$UPDATES/status.json")" "$(jq -r '.to // ""' "$UPDATES/status.json")" "" \
    "The updater was restarted while updating. Check the logs; the previous version may still be running." "$(now)" "$(now)"
fi

say "ready (version $VERSION, project $PROJECT)"
while true; do
  # Written via rename: a file left by an earlier user may not be writable, but the folder is.
  printf '%s\n' "${VERSION#v}" >"$UPDATES/heartbeat.tmp" 2>/dev/null && chmod 644 "$UPDATES/heartbeat.tmp" 2>/dev/null && mv -f "$UPDATES/heartbeat.tmp" "$UPDATES/heartbeat" 2>/dev/null
  [ -e "$UPDATES/request.json" ] && apply_request
  sleep "$POLL_SECONDS"
done
