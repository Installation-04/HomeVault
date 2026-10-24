#!/usr/bin/env bash
# HomeVault deployment helper: install, update, back up, restore and check a
# Docker-based HomeVault with one command.
#
#   ./deploy.sh install                       guided setup (questions) on a terminal, defaults otherwise
#   ./deploy.sh install --domain home.example.com   ...with automatic HTTPS
#   ./deploy.sh update                        back up, install the newest release, roll back on failure
#   ./deploy.sh help                          everything else
#
# Safe to re-run: existing secrets and data are never overwritten.

set -euo pipefail

ORIG_ARGS=("$@")
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

ENV_FILE=".env"
CONTAINER="homevault"
BACKUP_DIR_HOST="${BACKUP_DIR_HOST:-$SCRIPT_DIR/backups}"
ARCHIVES_TO_KEEP="${ARCHIVES_TO_KEEP:-10}"
PLACEHOLDER_SECRET="change-me-to-a-long-random-string"
DEFAULT_REPO="Installation-04/HomeVault"

# ----------------------------------------------------------------------------
# output helpers
# ----------------------------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'; C_BOLD=$'\033[1m'; C_OFF=$'\033[0m'
else
  C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_BOLD=""; C_OFF=""
fi
info() { printf '%s==>%s %s\n' "$C_BLUE" "$C_OFF" "$*"; }
ok() { printf '%s ✓%s %s\n' "$C_GREEN" "$C_OFF" "$*"; }
warn() { printf '%s !%s %s\n' "$C_YELLOW" "$C_OFF" "$*" >&2; }
fail_line() { printf '%s ✗%s %s\n' "$C_RED" "$C_OFF" "$*"; }
die() { printf '%sError:%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }

# ----------------------------------------------------------------------------
# arguments
# ----------------------------------------------------------------------------
COMMAND=""
ASSUME_YES=0
OPT_DOMAIN=""
OPT_PORT=""
OPT_BIND=""
OPT_DATA_DIR=""
OPT_IMAGE=""
OPT_TO=""
OPT_LOCALE=""
OPT_UPDATER=""
OPT_ADMIN_EMAIL=""
OPT_ADMIN_NAME=""
OPT_ADMIN_PASSWORD_FILE=""
OPT_SETS=()
OPT_SCHEDULE=""
NO_START=0
NO_GIT=0
EDGE=0
CHECK_ONLY=0
FROM_UPDATER=0
FORCE_SOURCE=0
NO_WIZARD=0
INCLUDE_SECRETS=0
PURGE=0
FOLLOW=0
POSITIONAL=()

usage() {
  cat <<'EOF'
HomeVault deploy script

Usage: ./deploy.sh <command> [options]

Commands
  install            Set HomeVault up. On a terminal it asks a few questions (the wizard); with
                     --yes or without a terminal it uses defaults and your options. Creates .env
                     with fresh secrets, builds or pulls the image, starts HomeVault and waits
                     until it is healthy. (default)
  wizard             Run the guided setup again (also to change settings of an installed copy).
  update             Back up, install the newest release (or --to a version), restart and verify.
                     Rolls back to the previous version automatically if the new one is unhealthy.
  updater <cmd>      enable | disable | status: the helper behind the Update button in Settings.
  schedule <cmd>     on | off | status: a nightly full backup (cron) of data and uploads.
  start | stop | restart
  status             Container health, URL, data size, latest backup, setup state.
  logs [-f]          Show recent logs (-f to follow).
  backup             Verified backup of the database and uploaded files -> ./backups/*.tar.gz
  restore <file>     Replace all data with the contents of a backup archive.
  admin <command>    Run the admin CLI inside the container, e.g.
                       ./deploy.sh admin create-admin you@example.com
                       ./deploy.sh admin reset-password you@example.com
                       ./deploy.sh admin disable-2fa you@example.com
                       ./deploy.sh admin list-users
  doctor             Diagnose common problems (prerequisites, secrets, health, backups).
  uninstall          Stop and remove containers. Data is kept unless --purge is given.
  help               This text.

Options
  --domain <host>    Serve HTTPS for this domain with automatic Let's Encrypt certificates.
                     Needs a DNS record pointing here and ports 80 and 443 reachable.
  --port <n>         Host port for plain HTTP (default 8080).
  --bind <addr>      Address to listen on (default 0.0.0.0; 127.0.0.1 when --domain is used).
  --data-dir <path>  Where the database and uploads live (default ./data). Point at your NAS.
  --image <ref>      Use a prebuilt image, e.g. ghcr.io/installation-04/homevault:1.0.0, instead of
                     building from source. "auto" picks the newest release (builds if there is none).
  --source           Build the image from the source in this folder.
  --locale <en|fr>   Default language for new accounts.
  --set KEY=VALUE    Put any setting into .env (repeatable), e.g. --set SMTP_HOST=smtp.example.com
  --updater          Enable the Update button (installs the updater helper container).
  --no-updater       Do not install the updater (the default with --yes).
  --admin-email <e>  Create the administrator right away (with --admin-name and
  --admin-password-file <file>; the file holds the password and is not kept).
  --schedule | --no-schedule   Set up (or skip) the nightly backup cron entry during install.
  --no-wizard        Do not ask questions even on a terminal.
  --no-start         Only prepare configuration; do not start anything.
  --to <version>     update: install this release (e.g. 1.2.0) instead of the newest.
  --check            update: only report whether a newer release exists.
  --no-git           update: keep the files in this folder as they are (rebuild / re-pull only).
  --edge             update: follow the main branch instead of releases (for developers).
  --include-secrets  backup: also put .env in the archive (it holds your keys: protect the file!).
  --purge            uninstall: also delete all data and certificates (asks first).
  -y, --yes          Do not ask questions (for automation).
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) OPT_DOMAIN="${2:-}"; [ -n "$OPT_DOMAIN" ] || die "--domain needs a value"; shift ;;
    --domain=*) OPT_DOMAIN="${1#*=}" ;;
    --port) OPT_PORT="${2:-}"; [ -n "$OPT_PORT" ] || die "--port needs a value"; shift ;;
    --port=*) OPT_PORT="${1#*=}" ;;
    --bind) OPT_BIND="${2:-}"; [ -n "$OPT_BIND" ] || die "--bind needs a value"; shift ;;
    --bind=*) OPT_BIND="${1#*=}" ;;
    --data-dir) OPT_DATA_DIR="${2:-}"; [ -n "$OPT_DATA_DIR" ] || die "--data-dir needs a value"; shift ;;
    --data-dir=*) OPT_DATA_DIR="${1#*=}" ;;
    --image) OPT_IMAGE="${2:-}"; [ -n "$OPT_IMAGE" ] || die "--image needs a value"; shift ;;
    --image=*) OPT_IMAGE="${1#*=}" ;;
    --to) OPT_TO="${2:-}"; [ -n "$OPT_TO" ] || die "--to needs a value"; shift ;;
    --to=*) OPT_TO="${1#*=}" ;;
    --locale) OPT_LOCALE="${2:-}"; [ -n "$OPT_LOCALE" ] || die "--locale needs a value"; shift ;;
    --locale=*) OPT_LOCALE="${1#*=}" ;;
    --set) [[ "${2:-}" == *=* ]] || die "--set needs KEY=VALUE"; OPT_SETS+=("$2"); shift ;;
    --set=*) [[ "${1#*=}" == *=* ]] || die "--set needs KEY=VALUE"; OPT_SETS+=("${1#*=}") ;;
    --admin-email) OPT_ADMIN_EMAIL="${2:-}"; [ -n "$OPT_ADMIN_EMAIL" ] || die "--admin-email needs a value"; shift ;;
    --admin-name) OPT_ADMIN_NAME="${2:-}"; [ -n "$OPT_ADMIN_NAME" ] || die "--admin-name needs a value"; shift ;;
    --admin-password-file) OPT_ADMIN_PASSWORD_FILE="${2:-}"; [ -n "$OPT_ADMIN_PASSWORD_FILE" ] || die "--admin-password-file needs a value"; shift ;;
    --updater) OPT_UPDATER=true ;;
    --no-updater) OPT_UPDATER=false ;;
    --schedule) OPT_SCHEDULE=on ;;
    --no-schedule) OPT_SCHEDULE=off ;;
    --source) FORCE_SOURCE=1 ;;
    --no-wizard) NO_WIZARD=1 ;;
    --check) CHECK_ONLY=1 ;;
    --edge) EDGE=1 ;;
    --from-updater) FROM_UPDATER=1 ;;
    --no-start) NO_START=1 ;;
    --no-git) NO_GIT=1 ;;
    --include-secrets) INCLUDE_SECRETS=1 ;;
    --purge) PURGE=1 ;;
    -f | --follow) FOLLOW=1 ;;
    -y | --yes) ASSUME_YES=1 ;;
    -h | --help) if [ "$COMMAND" = admin ]; then POSITIONAL+=("$1"); else COMMAND="help"; fi ;;
    --) shift; POSITIONAL+=("$@"); break ;;
    -*) if [ "$COMMAND" = admin ]; then POSITIONAL+=("$1"); else die "Unknown option '$1'. See ./deploy.sh help."; fi ;;
    *) if [ -z "$COMMAND" ]; then COMMAND="$1"; else POSITIONAL+=("$1"); fi ;;
  esac
  shift
done
COMMAND="${COMMAND:-install}"

# ----------------------------------------------------------------------------
# small utilities
# ----------------------------------------------------------------------------
confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  [ -t 0 ] || die "This needs confirmation but there is no terminal. Re-run with --yes."
  local answer
  read -r -p "$1 [y/N] " answer
  [[ "$answer" =~ ^[Yy]([Ee][Ss])?$ ]]
}

rand_hex() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

env_get() { # env_get KEY -> value of the last KEY= line in .env (empty if none)
  [ -f "$ENV_FILE" ] || return 0
  local line
  line="$(grep -E "^$1=" "$ENV_FILE" | tail -n 1 || true)"
  printf '%s' "${line#*=}"
}

env_set() { # env_set KEY VALUE -> replace the KEY= line, or append it. Keeps the file private.
  local key="$1" value="$2" tmp
  tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
  if [ -f "$ENV_FILE" ] && grep -qE "^${key}=" "$ENV_FILE"; then
    K="$key" V="$value" awk 'BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"] } index($0, k "=") == 1 { print k "=" v; next } { print }' "$ENV_FILE" >"$tmp"
  else
    { [ -f "$ENV_FILE" ] && cat "$ENV_FILE"; printf '%s=%s\n' "$key" "$value"; } >"$tmp"
  fi
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

port_in_use() {
  local port="$1"
  local listening
  if command -v ss >/dev/null 2>&1; then
    listening="$(ss -ltn 2>/dev/null | awk '{print $4}' || true)"
    grep -Eq "[:.]${port}$" <<<"$listening"
  elif command -v lsof >/dev/null 2>&1; then lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  else (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null
  fi
}

# Archive names are generated by this script (timestamps, no odd characters), so plain ls ordering is safe.
list_backups() { # newest first
  # shellcheck disable=SC2012
  ls -1t "$BACKUP_DIR_HOST"/homevault-backup-*.tar.gz 2>/dev/null || true
}

image_ref() { local ref; ref="$(env_get HOMEVAULT_IMAGE)"; printf '%s' "${ref:-homevault:latest}"; }

container_running() { [ "$(docker inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)" = true ]; }


# ----------------------------------------------------------------------------
# releases, versions and the updater helper
# ----------------------------------------------------------------------------
repo_slug() { local r; r="$(env_get UPDATE_REPO)"; printf '%s' "${r:-$DEFAULT_REPO}"; }
api_base() { local b="${UPDATE_API_BASE:-$(env_get UPDATE_API_BASE)}"; printf '%s' "${b:-https://api.github.com}"; }

# The newest published release as a tag such as v1.2.0 (empty output and failure when unknown).
latest_release_tag() {
  command -v curl >/dev/null 2>&1 || return 1
  local json tag
  json="$(curl -fsSL -m 20 -H 'Accept: application/vnd.github+json' -H 'User-Agent: homevault-deploy' "$(api_base)/repos/$(repo_slug)/releases/latest" 2>/dev/null)" || return 1
  tag="$(printf '%s' "$json" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  printf '%s' "$tag"
}

normalize_tag() { # 1.2.0 or v1.2.0 -> v1.2.0
  local v="${1#v}"
  [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "'$1' is not a version number like 1.2.0"
  printf 'v%s' "$v"
}

version_newer() { # version_newer A B -> true when A is a higher x.y.z than B
  local a1 a2 a3 b1 b2 b3
  IFS=. read -r a1 a2 a3 <<<"$1"
  IFS=. read -r b1 b2 b3 <<<"$2"
  [[ "$a1$a2$a3$b1$b2$b3" =~ ^[0-9]+$ ]] || return 1
  [ "$a1" -ne "$b1" ] && { [ "$a1" -gt "$b1" ]; return; }
  [ "$a2" -ne "$b2" ] && { [ "$a2" -gt "$b2" ]; return; }
  [ "$a3" -gt "$b3" ]
}

running_version() { # version of the running app image (x.y.z), "dev" or empty
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$CONTAINER" 2>/dev/null | sed -n 's/^HOMEVAULT_VERSION=v\{0,1\}//p' | head -n 1 || true
}

# ref_with_tag REF TAG -> REF with its tag replaced (a digest or a missing tag becomes :TAG)
ref_with_tag() {
  local base="${1%@*}"
  if [[ "${base##*/}" == *:* ]]; then base="${base%:*}"; fi
  printf '%s:%s' "$base" "$2"
}
updater_ref_for() { # ghcr.io/o/homevault:1.0.0 -> ghcr.io/o/homevault-updater:1.0.0
  local base="${1%:*}"
  printf '%s-updater:%s' "$base" "${1##*:}"
}
default_registry_image() { # GHCR needs lowercase names; the release workflow publishes ghcr.io/<owner>/<repo>
  printf 'ghcr.io/%s' "$(repo_slug | tr '[:upper:]' '[:lower:]')"
}
is_prebuilt() { [ "$(image_ref)" != "homevault:latest" ]; }

updater_enabled() { [ "$(env_get ENABLE_UPDATER)" = true ]; }

docker_socket_path() {
  local host
  host="$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)"
  case "$host" in unix://*) printf '%s' "${host#unix://}" ;; *) printf '/var/run/docker.sock' ;; esac
}

ensure_update_dir() {
  local dir
  dir="$(env_get DATA_DIR)"; dir="${dir:-./data}"
  mkdir -p "$dir/.update"
  # Shared by the app and the updater (different users, no extra privileges): both must be able to
  # replace and remove each other's small files. It holds no secrets, only requests and progress.
  chmod 0777 "$dir/.update" 2>/dev/null || true
}

# Writes what the updater service needs into .env. Not used inside the updater itself.
configure_updater() {
  local sock gid
  sock="$(docker_socket_path)"
  [ -S "$sock" ] || die "The Docker socket was not found at $sock; the updater needs it. (Use --no-updater to skip.)"
  gid="$(stat -c %g "$sock" 2>/dev/null || stat -f %g "$sock" 2>/dev/null || echo 0)"
  env_set ENABLE_UPDATER true
  env_set HV_DIR "$(pwd -P)"
  env_set HV_UID "$(id -u)"
  env_set HV_GID "$(id -g)"
  env_set DOCKER_GID "$gid"
  env_set DOCKER_SOCKET "$sock"
  if is_prebuilt; then env_set UPDATER_IMAGE "$(updater_ref_for "$(image_ref)")"; else env_set UPDATER_IMAGE "homevault-updater:latest"; fi
  ensure_update_dir
}

# ----------------------------------------------------------------------------
# docker / compose
# ----------------------------------------------------------------------------
COMPOSE=()
need_docker() {
  command -v docker >/dev/null 2>&1 || die "Docker is not installed. See https://docs.docker.com/engine/install/"
  docker info >/dev/null 2>&1 || die "Cannot talk to the Docker daemon. Is it running, and are you in the 'docker' group (or using sudo)?"
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (the 'docker compose' plugin). See https://docs.docker.com/compose/install/"
  COMPOSE=(docker compose)
  if [ -n "$(env_get DOMAIN)" ]; then COMPOSE+=(--profile https); fi
  if updater_enabled; then COMPOSE+=(--profile updater); fi
}
compose() {
  [ -f "$ENV_FILE" ] || die "No $ENV_FILE found here. Run ./deploy.sh install first."
  "${COMPOSE[@]}" "$@"
}

# Run a shell snippet inside the app container as the unprivileged user, whether or not it is running.
in_app() { # in_app SCRIPT  (stdin/stdout are passed through)
  if container_running; then compose exec -T -u node "$CONTAINER" sh -c "$1"
  else compose run --rm --no-deps -T -u node --entrypoint sh "$CONTAINER" -c "$1"
  fi
}

app_get() { # app_get /path -> body of a local GET against the app, from inside the container
  docker exec "$CONTAINER" node -e "fetch('http://127.0.0.1:4000$1').then(async r=>{process.stdout.write(await r.text());process.exit(r.ok?0:1)}).catch(()=>process.exit(2))" 2>/dev/null
}

# Under pipefail, "cmd | grep -q" can fail spuriously when grep exits before cmd finished writing,
# so these capture the output first.
api_has() { # api_has PATH TEXT -> true when the app's response for PATH contains TEXT
  local body
  body="$(app_get "$1" || true)"
  [[ "$body" == *"$2"* ]]
}
archive_has_db() { # archive_has_db FILE -> true when FILE is a tar.gz with homevault.sqlite at its top level
  local listing
  listing="$(tar -tzf "$1" 2>/dev/null || true)"
  grep -qx 'homevault.sqlite' <<<"$listing"
}

wait_healthy() { # wait_healthy [seconds]
  local timeout="${1:-90}" waited=0
  while [ "$waited" -lt "$timeout" ]; do
    if container_running && api_has /api/health '"status":"ok"'; then return 0; fi
    if [ "$(docker inspect --format '{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo missing)" = exited ]; then return 1; fi
    sleep 2
    waited=$((waited + 2))
  done
  return 1
}

show_failure_logs() {
  warn "Last log lines from the container:"
  compose logs --tail=20 "$CONTAINER" 2>&1 | sed 's/^/    /' >&2 || true
}

# ----------------------------------------------------------------------------
# configuration (.env)
# ----------------------------------------------------------------------------
NEW_ENV=0
ADMIN_CREATED=0
W_ADMIN_PASSWORD=""
GENERATED_NOTES=()

ensure_env() {
  if [ ! -f "$ENV_FILE" ]; then
    [ -f .env.example ] || die ".env.example is missing; run this script from the HomeVault folder."
    cp .env.example "$ENV_FILE"
    NEW_ENV=1
    info "Created $ENV_FILE from .env.example"
  fi
  chmod 600 "$ENV_FILE" 2>/dev/null || true

  local secret
  secret="$(env_get APP_SECRET)"
  [ -n "$secret" ] || secret="$(env_get JWT_SECRET)" # name used by older versions
  if [ -z "$secret" ] || [ "$secret" = "$PLACEHOLDER_SECRET" ] || [ "${#secret}" -lt 16 ]; then
    env_set APP_SECRET "$(rand_hex)"
    GENERATED_NOTES+=("APP_SECRET")
  fi
  if [ -z "$(env_get DATA_KEY)" ]; then
    env_set DATA_KEY "$(rand_hex)"
    GENERATED_NOTES+=("DATA_KEY")
  fi
  if [ "$NEW_ENV" = 1 ] && [ -z "$(env_get SETUP_TOKEN)" ]; then
    env_set SETUP_TOKEN "$(rand_hex | cut -c1-16)"
    GENERATED_NOTES+=("SETUP_TOKEN")
  fi

  # Options given on the command line win and are remembered for next time.
  resolve_image_option
  [ "$FORCE_SOURCE" = 0 ] || env_set HOMEVAULT_IMAGE homevault:latest
  [ -z "$OPT_LOCALE" ] || { [[ "$OPT_LOCALE" =~ ^(en|fr)$ ]] || die "--locale must be en or fr"; env_set DEFAULT_LOCALE "$OPT_LOCALE"; }
  local pair key
  for pair in "${OPT_SETS[@]+"${OPT_SETS[@]}"}"; do
    key="${pair%%=*}"
    [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || die "'$key' is not a valid setting name (use upper case, e.g. SMTP_HOST)."
    env_set "$key" "${pair#*=}"
  done
  [ -z "$OPT_PORT" ] || env_set HOST_PORT "$OPT_PORT"
  [ -z "$OPT_BIND" ] || env_set BIND_ADDRESS "$OPT_BIND"
  [ -z "$OPT_DATA_DIR" ] || env_set DATA_DIR "$OPT_DATA_DIR"
  [ -z "$OPT_IMAGE" ] || env_set HOMEVAULT_IMAGE "$OPT_IMAGE"
  if [ -n "$OPT_DOMAIN" ]; then
    [[ "$OPT_DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ && "$OPT_DOMAIN" == *.* ]] || die "'$OPT_DOMAIN' doesn't look like a domain name."
    env_set DOMAIN "$OPT_DOMAIN"
    env_set TRUST_PROXY 1
    env_set FORCE_HTTPS true
    # Only the reverse proxy should be reachable from outside.
    [ -n "$OPT_BIND" ] || env_set BIND_ADDRESS 127.0.0.1
  fi
  local port
  port="$(env_get HOST_PORT)"
  [[ "${port:-8080}" =~ ^[0-9]+$ ]] || die "HOST_PORT must be a number, got '$port'."

  # The updater helper (the Update button). Its settings follow this folder, user and Docker socket.
  if [ "$FROM_UPDATER" = 0 ]; then
    if [ "$OPT_UPDATER" = false ]; then env_set ENABLE_UPDATER false; fi
    if [ "$OPT_UPDATER" = true ] || updater_enabled; then
      configure_updater
    fi
  fi
}

# --image auto: the newest release's ready-made image if it exists, otherwise build from source.
resolve_image_option() {
  [ "$OPT_IMAGE" = auto ] || { [ -z "$OPT_IMAGE" ] || env_set HOMEVAULT_IMAGE "$OPT_IMAGE"; return 0; }
  local tag ref
  if tag="$(latest_release_tag)"; then
    ref="$(default_registry_image):${tag#v}"
    if registry_has_image "$ref"; then
      env_set HOMEVAULT_IMAGE "$ref"
      ok "Using the ready-made image $ref"
      return 0
    fi
  fi
  warn "No ready-made image is available yet; the image will be built from source."
}

# ghcr.io images are checked anonymously (no Docker needed); anything else is assumed to exist.
registry_has_image() { # registry_has_image ghcr.io/owner/name:tag
  local path="${1%:*}" tag="${1##*:}" name token
  [[ "$path" == ghcr.io/* ]] || return 0
  name="${path#ghcr.io/}"
  command -v curl >/dev/null 2>&1 || return 1
  token="$(curl -fsSL -m 15 "https://ghcr.io/token?service=ghcr.io&scope=repository:$name:pull" 2>/dev/null | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  [ -n "$token" ] || return 1
  curl -fsS -m 15 -o /dev/null -I -H "Authorization: Bearer $token" \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json' \
    "https://ghcr.io/v2/$name/manifests/$tag" >/dev/null 2>&1
}

# ----------------------------------------------------------------------------
# preflight
# ----------------------------------------------------------------------------
preflight() {
  info "Checking prerequisites"
  need_docker
  ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?') with $("${COMPOSE[0]}" compose version --short 2>/dev/null || echo compose)"

  local free_kb
  free_kb="$(df -Pk "$SCRIPT_DIR" | awk 'NR==2 {print $4}')"
  if [ -n "$free_kb" ] && [ "$free_kb" -lt 1048576 ]; then warn "Less than 1 GB free in $SCRIPT_DIR; building the image needs room."; else ok "Disk space"; fi

  if ! container_running; then
    local port bind
    port="$(env_get HOST_PORT)"; port="${port:-8080}"
    bind="$(env_get BIND_ADDRESS)"; bind="${bind:-0.0.0.0}"
    if port_in_use "$port"; then die "Port $port is already in use. Choose another: ./deploy.sh install --port 8081"; fi
    ok "Port $port is free ($bind)"
  fi
  if [ -n "$(env_get DOMAIN)" ]; then
    for p in 80 443; do
      if ! container_running && port_in_use "$p"; then warn "Port $p is in use; HTTPS needs 80 and 443 for certificates."; fi
    done
  fi
}

# ----------------------------------------------------------------------------
# commands
# ----------------------------------------------------------------------------
build_or_pull() {
  local services=("$CONTAINER")
  updater_enabled && services+=(updater)
  if ! is_prebuilt; then
    info "Building the image (first time takes a few minutes; longer on a Raspberry Pi)"
    local version
    version="$(git describe --tags --always 2>/dev/null || echo dev)"
    # --pull refreshes the base image (security patches); BUILD_PULL=0 builds from a local base image instead.
    local pull_flag=(--pull)
    [ "${BUILD_PULL:-1}" != 0 ] || pull_flag=()
    HOMEVAULT_VERSION="$version" compose build "${pull_flag[@]}" "${services[@]}"
  else
    info "Downloading $(image_ref)"
    compose pull "${services[@]}"
  fi
}

# Creates the first administrator through the CLI; the password travels on standard input.
create_admin_now() {
  local password out
  if [ -n "$W_ADMIN_PASSWORD" ]; then password="$W_ADMIN_PASSWORD"
  elif [ -n "$OPT_ADMIN_PASSWORD_FILE" ]; then
    [ -r "$OPT_ADMIN_PASSWORD_FILE" ] || die "Cannot read $OPT_ADMIN_PASSWORD_FILE"
    password="$(head -n 1 "$OPT_ADMIN_PASSWORD_FILE")"
  else die "--admin-email also needs --admin-password-file."; fi
  if out="$(printf '%s\n' "$password" | compose exec -T -u node "$CONTAINER" node src/cli.js create-admin "$OPT_ADMIN_EMAIL" --name "${OPT_ADMIN_NAME:-Admin}" --password-stdin 2>&1)"; then
    ok "Administrator account created for $OPT_ADMIN_EMAIL"
    ADMIN_CREATED=1
    return 0
  fi
  warn "Could not create the administrator: ${out#Error: }"
  return 1
}

print_summary() {
  local port bind domain url token
  port="$(env_get HOST_PORT)"; port="${port:-8080}"
  bind="$(env_get BIND_ADDRESS)"; bind="${bind:-0.0.0.0}"
  domain="$(env_get DOMAIN)"
  if [ -n "$domain" ]; then url="https://$domain"
  elif [ "$bind" = 127.0.0.1 ]; then url="http://127.0.0.1:$port"
  else url="http://$(hostname -I 2>/dev/null | awk '{print $1}' || true):$port"; fi
  [ "$url" != "http://:$port" ] || url="http://localhost:$port"

  echo
  printf '%sHomeVault is running%s at %s%s%s\n' "$C_BOLD" "$C_OFF" "$C_BOLD" "$url" "$C_OFF"
  echo
  if [ "$ADMIN_CREATED" = 1 ]; then
    echo "Sign in at that address with ${OPT_ADMIN_EMAIL} and the password you chose."
  elif api_has /api/auth/status '"needs_setup":true'; then
    token="$(env_get SETUP_TOKEN)"
    echo "Next: open that address and create your administrator account."
    if [ -n "$token" ]; then
      printf '      Setup token (asked for on that screen): %s%s%s\n' "$C_BOLD" "$token" "$C_OFF"
    fi
    echo "      Or from the command line:  ./deploy.sh admin create-admin you@example.com"
  else
    echo "An administrator account already exists. Sign in at the address above."
  fi
  echo
  echo "Good to do next"
  echo "  • Turn on two-factor authentication: Settings → Security."
  if [ -z "$domain" ]; then
    echo "  • This is plain HTTP, fine on a home network. Before exposing it to the internet, add HTTPS:"
    echo "      ./deploy.sh install --domain your.domain.example"
  fi
  echo "  • Keep a copy of your secrets: ${C_BOLD}$SCRIPT_DIR/$ENV_FILE${C_OFF} (password manager, not the same place as backups)."
  echo "  • Back up regularly:  ./deploy.sh backup     Update later:  ./deploy.sh update"
  if updater_enabled; then echo "  • One-click updates are on: administrators see an Update button in Settings → Administration."; fi
  if [ "${#GENERATED_NOTES[@]}" -gt 0 ]; then
    echo
    echo "Generated for you in $ENV_FILE: ${GENERATED_NOTES[*]}"
  fi
}

# True when we should ask questions: install on a terminal for a fresh copy, or `wizard`.
interactive() { [ "$ASSUME_YES" = 0 ] && ( : </dev/tty ) 2>/dev/null; }
wizard_wanted() {
  [ "$NO_WIZARD" = 0 ] || return 1
  [ "$COMMAND" = wizard ] && return 0
  [ "$COMMAND" = install ] && [ ! -f "$ENV_FILE" ] && interactive
}

cmd_install() {
  if wizard_wanted; then
    [ -f "$SCRIPT_DIR/scripts/wizard.sh" ] || die "scripts/wizard.sh is missing from this folder."
    # shellcheck source=scripts/wizard.sh
    . "$SCRIPT_DIR/scripts/wizard.sh"
    run_wizard
  fi
  ensure_env
  preflight
  mkdir -p "$(env_get DATA_DIR)" 2>/dev/null || mkdir -p ./data
  if [ "$NO_START" = 1 ]; then ok "Configuration ready in $ENV_FILE (not started: --no-start)."; return 0; fi
  build_or_pull
  info "Starting"
  compose up -d
  info "Waiting for HomeVault to become healthy"
  if ! wait_healthy 120; then
    show_failure_logs
    die "HomeVault did not become healthy. Run './deploy.sh doctor' for hints."
  fi
  ok "Healthy"
  if [ -n "$OPT_ADMIN_EMAIL" ] && api_has /api/auth/status '"needs_setup":true'; then
    create_admin_now || if declare -F wizard_retry_admin >/dev/null; then wizard_retry_admin; fi
  fi
  case "$OPT_SCHEDULE" in
    on) cmd_schedule_on || true ;;
  esac
  print_summary
}

update_check() {
  local running latest
  running="$(running_version)"
  latest="$(latest_release_tag)" || die "Could not look up the newest release (no network, or none published yet)."
  echo "Installed : ${running:-unknown}"
  echo "Newest    : ${latest#v}"
  if [ "$running" = dev ] || [ -z "$running" ]; then echo "This is a development build; releases are not compared."
  elif version_newer "${latest#v}" "$running"; then echo "A newer version is available. Install it with: ./deploy.sh update"
  else ok "You are up to date."; fi
}

# Switch the files in this folder (compose file, scripts) to a release tag. They are replaced
# while this script runs, so it starts itself again afterwards (HV_REFRESHED stops a loop).
refresh_files() { # refresh_files TAG
  local tag="$1" previous
  [ "${HV_REFRESHED:-0}" = 1 ] && return 0
  if [ ! -d .git ] || ! command -v git >/dev/null 2>&1; then
    warn "This folder is not a git checkout, so only the image is updated; compose files stay as they are."
    return 0
  fi
  if [ -n "$(git status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    warn "You have local changes in this folder; leaving the files as they are and only updating the image."
    return 0
  fi
  info "Downloading release $tag"
  previous="$(git symbolic-ref -q --short HEAD 2>/dev/null || git rev-parse HEAD)"
  git fetch --quiet --depth 1 origin "refs/tags/$tag:refs/tags/$tag" || die "Could not download $tag from the repository."
  git -c advice.detachedHead=false checkout -q "$tag" || die "Could not switch to $tag."
  export HV_REFRESHED=1 HV_PREVIOUS_GIT_REF="$previous"
  exec "$SCRIPT_DIR/deploy.sh" "${ORIG_ARGS[@]}"
}

cmd_update() {
  [ -f "$ENV_FILE" ] || die "Nothing to update: no $ENV_FILE here. Run './deploy.sh install' first."
  need_docker
  [ "$FROM_UPDATER" = 1 ] || ensure_env
  if [ "$CHECK_ONLY" = 1 ]; then update_check; return 0; fi

  # Which release? The newest, unless told otherwise. --no-git / --edge update from the files that are here.
  local tag="" ver="" running
  running="$(running_version)"
  if [ -n "$OPT_TO" ] && [ "$OPT_TO" != latest ]; then
    tag="$(normalize_tag "$OPT_TO")"
  elif [ "$OPT_TO" = latest ] || { [ "$NO_GIT" = 0 ] && [ "$EDGE" = 0 ]; }; then
    tag="$(latest_release_tag)" || die "Could not look up the newest release. Check the internet connection, or use --no-git to rebuild what is already here."
  fi
  ver="${tag#v}"
  if [ -n "$ver" ] && [ "$ver" = "$running" ]; then ok "Already on v$ver; nothing to do."; return 0; fi
  if [ -n "$ver" ] && [ -n "$running" ] && [ "$running" != dev ] && version_newer "$running" "$ver" && [ -z "$OPT_TO" ]; then
    ok "This installation (v$running) is newer than the latest release (v$ver); nothing to do."
    return 0
  fi

  [ -z "$tag" ] || refresh_files "$tag"
  if [ "$EDGE" = 1 ] && [ -d .git ]; then
    info "Fetching the latest code (main)"
    if ! { git fetch --quiet origin main && git checkout -q main && git merge --ff-only origin/main; }; then warn "Could not fast-forward main; using what is here."; fi
  fi

  container_running || warn "HomeVault is not running right now; updating anyway."
  if container_running; then
    info "Backing up before the update"
    cmd_backup pre-update || warn "Backup failed; continuing, but you have no fresh safety copy."
  fi

  # Remember what is running so we can go back to it.
  local previous_id="" previous_ref
  previous_id="$(docker inspect --format '{{.Image}}' "$CONTAINER" 2>/dev/null || true)"
  if [ -n "$previous_id" ]; then docker tag "$previous_id" homevault-rollback:latest; fi
  previous_ref="$(image_ref)"

  local new_ref="$previous_ref" new_updater=""
  if is_prebuilt && [ -n "$ver" ]; then new_ref="$(ref_with_tag "$previous_ref" "$ver")"; fi
  if updater_enabled; then
    if is_prebuilt && [ -n "$ver" ]; then new_updater="$(updater_ref_for "$new_ref")"; else new_updater="$(env_get UPDATER_IMAGE)"; fi
  fi

  info "Fetching the new version"
  if is_prebuilt; then
    local pull=("$CONTAINER")
    [ -z "$new_updater" ] || pull+=(updater)
    HOMEVAULT_IMAGE="$new_ref" UPDATER_IMAGE="$new_updater" compose pull "${pull[@]}"
  else
    local build_version build=("$CONTAINER") pull_flag=(--pull)
    [ "${BUILD_PULL:-1}" != 0 ] || pull_flag=()
    build_version="${ver:-$(git describe --tags --always 2>/dev/null || echo dev)}"
    [ -z "$new_updater" ] || build+=(updater)
    HOMEVAULT_VERSION="$build_version" compose build "${pull_flag[@]}" "${build[@]}"
  fi

  info "Restarting with the new version"
  local services=("$CONTAINER")
  [ -z "$(env_get DOMAIN)" ] || services+=(caddy)
  HOMEVAULT_IMAGE="$new_ref" UPDATER_IMAGE="$new_updater" compose up -d --no-deps "${services[@]}"
  if wait_healthy 120; then
    [ "$new_ref" = "$previous_ref" ] || env_set HOMEVAULT_IMAGE "$new_ref"
    [ -z "$new_updater" ] || env_set UPDATER_IMAGE "$new_updater"
    # The updater replaces itself last when it is the one running this script.
    if [ -n "$new_updater" ] && [ "$FROM_UPDATER" = 0 ]; then compose up -d --no-deps updater; fi
    ok "Updated${ver:+ to v$ver} and healthy"
    docker image prune -f >/dev/null 2>&1 || true
    return 0
  fi

  show_failure_logs
  if [ -n "$previous_id" ]; then
    warn "The new version is not healthy. Rolling back to the previous version."
    if [ -n "${HV_PREVIOUS_GIT_REF:-}" ]; then git -c advice.detachedHead=false checkout -q "$HV_PREVIOUS_GIT_REF" || warn "Could not restore the previous files."; fi
    # Point the configured image name back at the previous version so later start/restart/up keep using it.
    docker tag "$previous_id" "$previous_ref"
    compose up -d --no-deps --no-build "${services[@]}"
    if wait_healthy 90; then
      printf '%sError:%s Rolled back: the previous version is running again. Your data was not changed.\n' "$C_RED" "$C_OFF" >&2
      exit 3
    fi
  fi
  die "Update failed and rollback did not recover. Restore with: ./deploy.sh restore backups/<latest>.tar.gz"
}

cmd_start() {
  need_docker
  compose up -d
  if wait_healthy 90; then ok "Running"; else show_failure_logs; die "Not healthy."; fi
}
cmd_stop() { need_docker; compose stop; ok "Stopped (data is untouched)"; }
cmd_restart() {
  need_docker
  compose restart
  if wait_healthy 90; then ok "Running"; else show_failure_logs; die "Not healthy."; fi
}

cmd_logs() {
  need_docker
  if [ "$FOLLOW" = 1 ]; then compose logs --tail=100 -f; else compose logs --tail=100; fi
}

cmd_admin() {
  need_docker
  container_running || die "HomeVault is not running. Start it with ./deploy.sh start."
  [ "${#POSITIONAL[@]}" -gt 0 ] || die "Give an admin command, e.g. ./deploy.sh admin list-users (or: ./deploy.sh admin help)"
  local tty_flag=()
  [ -t 0 ] && [ -t 1 ] || tty_flag=(-T)
  compose exec "${tty_flag[@]}" -u node "$CONTAINER" node src/cli.js "${POSITIONAL[@]}"
}

# cmd_backup [label]  -> ./backups/homevault-backup-<label->TIMESTAMP.tar.gz
cmd_backup() {
  need_docker
  local label="${1:-}" stamp out partial
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$BACKUP_DIR_HOST"
  chmod 700 "$BACKUP_DIR_HOST" 2>/dev/null || true
  out="$BACKUP_DIR_HOST/homevault-backup-${label:+$label-}${stamp}.tar.gz"
  partial="$out.partial"
  info "Creating a consistent backup (database snapshot + uploaded files)"

  # Runs inside the container so file ownership never matters. The database is copied with
  # SQLite's online backup (safe while the app is running) and integrity-checked first.
  # shellcheck disable=SC2016
  local script='set -e
snap=$(mktemp -d /tmp/hvbackup.XXXXXX)
node src/cli.js backup "$snap" >/dev/null
mv "$snap"/homevault-*.sqlite "$snap/homevault.sqlite"
{ echo "HomeVault backup"; echo "created: $(date -u +%FT%TZ)"; echo "version: ${HOMEVAULT_VERSION:-unknown}"; node src/cli.js check; } > "$snap/MANIFEST.txt"
up="${UPLOAD_DIR:-./data/uploads}"
if [ -d "$up" ]; then
  tar -czf - --exclude="$(basename "$up")/_tmp" -C "$snap" homevault.sqlite MANIFEST.txt -C "$(cd "$up/.." && pwd)" "$(basename "$up")"
else
  tar -czf - -C "$snap" homevault.sqlite MANIFEST.txt
fi
rm -rf "$snap"'
  if ! in_app "$script" >"$partial"; then
    rm -f "$partial"
    die "Backup failed."
  fi
  archive_has_db "$partial" || { rm -f "$partial"; die "The backup archive is incomplete (no database inside)."; }

  if [ "$INCLUDE_SECRETS" = 1 ] && [ -f "$ENV_FILE" ]; then
    warn "Adding $ENV_FILE to the archive: anyone with the file can read your secrets. Store it carefully."
    local tmpdir
    tmpdir="$(mktemp -d)"
    cp "$ENV_FILE" "$tmpdir/env.backup"
    gunzip -c "$partial" >"$tmpdir/base.tar"
    tar -rf "$tmpdir/base.tar" -C "$tmpdir" env.backup
    gzip -c "$tmpdir/base.tar" >"$partial"
    rm -rf "$tmpdir"
  fi
  mv "$partial" "$out"
  chmod 600 "$out"
  ok "Backup written: $out ($(du -h "$out" | awk '{print $1}'))"

  # Keep the newest N archives.
  local old
  old="$(list_backups | tail -n "+$((ARCHIVES_TO_KEEP + 1))")"
  if [ -n "$old" ]; then printf '%s\n' "$old" | xargs rm -f; fi
  if [ "$INCLUDE_SECRETS" = 0 ]; then
    echo "   Your secrets (.env) are NOT in this archive. Keep a separate copy: without DATA_KEY, 2FA secrets in a restored backup can't be read."
  fi
}

cmd_restore() {
  need_docker
  local archive="${POSITIONAL[0]:-}"
  [ -n "$archive" ] || die "Usage: ./deploy.sh restore <backup.tar.gz>"
  [ -f "$archive" ] || die "No such file: $archive"
  archive_has_db "$archive" || die "$archive is not a HomeVault backup (no homevault.sqlite inside)."

  ensure_env
  echo "This will REPLACE all current HomeVault data (database and uploaded files) with:"
  echo "    $archive"
  echo "The current data is kept aside until the restored copy is confirmed healthy."
  confirm "Continue?" || die "Cancelled."

  if container_running; then
    info "Taking a safety backup of the current data first"
    cmd_backup pre-restore || warn "Could not take a safety backup; the old data will still be kept aside."
  fi
  info "Stopping HomeVault"
  compose stop "$CONTAINER" >/dev/null 2>&1 || true

  local stamp aside
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  aside=".pre-restore-$stamp"
  # shellcheck disable=SC2016
  local script='set -e
data=/app/backend/data
db="${DB_PATH:-./data/homevault.sqlite}"; up="${UPLOAD_DIR:-./data/uploads}"
rm -rf "$data/.restore" && mkdir -p "$data/.restore"
tar -xzf - -C "$data/.restore" --no-same-owner --no-same-permissions
[ -f "$data/.restore/homevault.sqlite" ] || { echo "archive has no database" >&2; exit 3; }
head -c 15 "$data/.restore/homevault.sqlite" | grep -q "SQLite format 3" || { echo "the database in the archive is not a SQLite file" >&2; exit 3; }
mkdir -p "$data/ASIDE"
for f in "$db" "$db-wal" "$db-shm"; do [ -e "$f" ] && mv "$f" "$data/ASIDE/" || true; done
[ -d "$up" ] && mv "$up" "$data/ASIDE/uploads" || true
mkdir -p "$(dirname "$db")" "$(dirname "$up")"
mv "$data/.restore/homevault.sqlite" "$db"
if [ -d "$data/.restore/uploads" ]; then mv "$data/.restore/uploads" "$up"; else mkdir -p "$up"; fi
rm -rf "$data/.restore"
chown -R node:node "$data"'
  script="${script//ASIDE/$aside}"
  info "Restoring"
  if ! compose run --rm --no-deps -T --entrypoint sh "$CONTAINER" -c "$script" <"$archive"; then
    warn "The restore step failed; your previous data was not removed. Starting the app again."
    compose up -d >/dev/null 2>&1 || true
    die "Restore failed."
  fi
  compose up -d
  if wait_healthy 120; then
    ok "Restored and healthy"
    if api_has /api/auth/status '"needs_setup":true'; then warn "The restored database has no accounts."; fi
    info "Removing the set-aside copy of the previous data"
    compose run --rm --no-deps -T --entrypoint sh "$CONTAINER" -c "rm -rf /app/backend/data/$aside" >/dev/null 2>&1 || warn "Could not remove data/$aside; delete it manually once you are happy."
    echo "   If two-factor sign-in fails for someone, the DATA_KEY in .env differs from the one the backup was made with."
    echo "   Reset it with:  ./deploy.sh admin disable-2fa <email>"
  else
    show_failure_logs
    die "The restored data did not start. Your previous data is in $(env_get DATA_DIR)/$aside; move it back to undo."
  fi
}

cmd_status() {
  need_docker
  if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then die "HomeVault is not installed here. Run ./deploy.sh install."; fi
  local state health image created version
  state="$(docker inspect --format '{{.State.Status}}' "$CONTAINER")"
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}' "$CONTAINER")"
  image="$(docker inspect --format '{{.Config.Image}}' "$CONTAINER")"
  created="$(docker inspect --format '{{.Created}}' "$CONTAINER")"
  version="$(docker exec "$CONTAINER" printenv HOMEVAULT_VERSION 2>/dev/null || echo unknown)"
  echo "Container : $state (health: $health)"
  echo "Image     : $image  (version $version)"
  echo "Platform  : $(docker info --format '{{.OSType}}/{{.Architecture}}' 2>/dev/null || echo unknown)"
  echo "Started   : $created"
  echo "Address   : $( [ -n "$(env_get DOMAIN)" ] && echo "https://$(env_get DOMAIN)" || echo "http://localhost:$(env_get HOST_PORT)" )"
  if container_running; then
    if api_has /api/health '"status":"ok"'; then ok "API responds"; else fail_line "API does not respond"; fi
    if api_has /api/auth/status '"needs_setup":true'; then warn "No administrator yet: open the app (setup token: $(env_get SETUP_TOKEN))"; fi
  fi
  if updater_enabled; then
    if [ "$(docker inspect --format '{{.State.Running}}' homevault-updater 2>/dev/null || echo false)" = true ]; then echo "Updater   : running (Update button enabled)"
    else warn "Updater   : enabled but not running (./deploy.sh updater enable)"; fi
  else echo "Updater   : off (update from a terminal with ./deploy.sh update)"; fi
  local data
  data="$(env_get DATA_DIR)"; data="${data:-./data}"
  [ -d "$data" ] && echo "Data      : $(du -sh "$data" 2>/dev/null | awk '{print $1}') in $data"
  local latest
  latest="$(list_backups | head -n 1 || true)"
  if [ -n "$latest" ]; then echo "Backup    : $(basename "$latest") ($(date -r "$latest" '+%Y-%m-%d %H:%M'))"; else warn "No backup archive yet. Run ./deploy.sh backup"; fi
}

cmd_doctor() {
  local problems=0
  check() { # check "label" command... ; prints a pass/fail line
    local label="$1"; shift
    if "$@" >/dev/null 2>&1; then ok "$label"; else fail_line "$label"; problems=$((problems + 1)); fi
  }
  info "Prerequisites"
  check "docker is installed" command -v docker
  check "the Docker daemon is reachable" docker info
  check "Docker Compose v2 is available" docker compose version
  [ "$problems" = 0 ] || die "Fix the above first (see https://docs.docker.com/engine/install/)."
  need_docker

  info "Configuration"
  check ".env exists" test -f "$ENV_FILE"
  if [ -f "$ENV_FILE" ]; then
    local secret mode
    secret="$(env_get APP_SECRET)"; [ -n "$secret" ] || secret="$(env_get JWT_SECRET)"
    check "APP_SECRET is set, not the placeholder, and long enough" test -n "$secret" -a "$secret" != "$PLACEHOLDER_SECRET" -a "${#secret}" -ge 16
    check "DATA_KEY is set" test -n "$(env_get DATA_KEY)"
    mode="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE" 2>/dev/null || echo '?')"
    if [ "$mode" = 600 ]; then ok ".env is private (600)"; else warn ".env permissions are $mode; run: chmod 600 $ENV_FILE"; fi
  fi

  info "Runtime"
  if container_running; then
    ok "the container is running"
    api_healthy() { api_has /api/health '"status":"ok"'; }
    check "the API answers /api/health" api_healthy
    local app_uid
    app_uid="$(docker top "$CONTAINER" -eo pid,uid,args 2>/dev/null | awk '$3 == "node" && $4 == "src/server.js" {print $2}' | head -n 1 || true)"
    if [ -z "$app_uid" ]; then warn "could not determine which user the app runs as"
    elif [ "$app_uid" = 0 ]; then warn "the app runs as root inside the container; check that the data folder can be chowned (see logs)"
    else ok "the app runs unprivileged (uid $app_uid)"; fi
    if [ -z "$(env_get DOMAIN)" ]; then warn "no HTTPS: traffic is unencrypted. Fine on a trusted LAN; use --domain before exposing it to the internet."; else ok "HTTPS is configured for $(env_get DOMAIN)"; fi
    if docker exec "$CONTAINER" node src/cli.js list-users 2>/dev/null | awk '/(^|[ ,])admin($|,)/ && !/(^|[ ,])2fa($|,)/ {found=1} END {exit !found}'; then warn "at least one administrator has no two-factor authentication (Settings → Security)"; fi
  else
    fail_line "the container is not running (./deploy.sh start; logs: ./deploy.sh logs)"
    problems=$((problems + 1))
  fi

  if updater_enabled; then
    info "Updater"
    if [ "$(docker inspect --format '{{.State.Running}}' homevault-updater 2>/dev/null || echo false)" = true ]; then ok "the updater is running"; else fail_line "the updater is enabled but not running (./deploy.sh updater enable)"; problems=$((problems + 1)); fi
    warn "the updater can control Docker on this machine (see docs/SECURITY.md); turn it off with: ./deploy.sh updater disable"
  fi

  info "Platform"
  local arch
  arch="$(docker info --format '{{.Architecture}}' 2>/dev/null || echo unknown)"
  case "$arch" in
    x86_64 | aarch64) ok "architecture $arch is supported" ;;
    *) fail_line "architecture $arch is not supported (use a 64-bit OS: amd64 or arm64)"; problems=$((problems + 1)) ;;
  esac

  info "Backups"
  local latest age_days
  latest="$(list_backups | head -n 1 || true)"
  if [ -z "$latest" ]; then warn "no backup archive in $BACKUP_DIR_HOST (./deploy.sh backup)"
  else
    age_days=$(( ( $(date +%s) - $(date -r "$latest" +%s) ) / 86400 ))
    if [ "$age_days" -gt 7 ]; then warn "the newest backup is $age_days days old"; else ok "recent backup: $(basename "$latest")"; fi
  fi

  echo
  if [ "$problems" = 0 ]; then ok "No problems found."; else die "$problems problem(s) found."; fi
}

# --- nightly backups via cron -------------------------------------------------------------
SCHEDULE_MARK="# homevault-backup"

cmd_schedule_on() {
  command -v crontab >/dev/null 2>&1 || { warn "cron is not available here (no 'crontab' command), so no nightly backup was scheduled."; return 1; }
  local line current
  mkdir -p "$BACKUP_DIR_HOST"
  line="30 3 * * * cd '$SCRIPT_DIR' && PATH='$PATH' ./deploy.sh backup >> '$BACKUP_DIR_HOST/backup.log' 2>&1 $SCHEDULE_MARK"
  current="$(crontab -l 2>/dev/null | grep -vF "$SCHEDULE_MARK" || true)"
  printf '%s\n%s\n' "$current" "$line" | sed '/^$/d' | crontab -
  ok "Nightly backup scheduled for 03:30 (newest $ARCHIVES_TO_KEEP kept in $BACKUP_DIR_HOST)"
}

cmd_schedule() {
  case "${POSITIONAL[0]:-status}" in
    on) cmd_schedule_on ;;
    off)
      command -v crontab >/dev/null 2>&1 || die "cron is not available here."
      crontab -l 2>/dev/null | grep -vF "$SCHEDULE_MARK" | crontab - || true
      ok "The nightly backup schedule was removed."
      ;;
    status)
      if command -v crontab >/dev/null 2>&1 && crontab -l 2>/dev/null | grep -qF "$SCHEDULE_MARK"; then ok "A nightly backup is scheduled (crontab -l shows it)."
      else echo "No nightly backup is scheduled. Turn it on with: ./deploy.sh schedule on"; fi
      ;;
    *) die "Usage: ./deploy.sh schedule on|off|status" ;;
  esac
}

# --- the updater helper (Update button) ---------------------------------------------------
cmd_updater() {
  case "${POSITIONAL[0]:-status}" in
    enable)
      need_docker
      OPT_UPDATER=true
      ensure_env
      need_docker # pick up the updater profile
      info "Starting the updater"
      if is_prebuilt; then compose pull updater; else compose build updater; fi
      compose up -d --no-deps updater
      ok "The updater is running. Administrators now see an Update button in Settings → Administration."
      warn "It can control Docker on this machine; see docs/SECURITY.md. Turn it off with: ./deploy.sh updater disable"
      ;;
    disable)
      need_docker
      env_set ENABLE_UPDATER false
      docker rm -f homevault-updater >/dev/null 2>&1 || true
      ok "The updater is off. Update from a terminal with ./deploy.sh update."
      ;;
    status)
      need_docker
      if updater_enabled; then
        if [ "$(docker inspect --format '{{.State.Running}}' homevault-updater 2>/dev/null || echo false)" = true ]; then ok "The updater is running."; else warn "The updater is enabled but not running."; fi
      else echo "The updater is off."; fi
      ;;
    *) die "Usage: ./deploy.sh updater enable|disable|status" ;;
  esac
}

cmd_uninstall() {
  need_docker
  if [ "$PURGE" = 1 ]; then
    echo "This removes the containers AND permanently deletes all HomeVault data and certificates."
    confirm "Delete everything?" || die "Cancelled."
    compose down --volumes --remove-orphans
    local data
    data="$(env_get DATA_DIR)"; data="${data:-./data}"
    if [ -d "$data" ]; then
      # Files are owned by the container user, so remove them from inside a container.
      docker run --rm -v "$(cd "$data" && pwd):/d" --entrypoint sh "$(image_ref)" -c 'rm -rf /d/* /d/.[!.]* 2>/dev/null || true'
      rmdir "$data" 2>/dev/null || true
    fi
    ok "Everything removed. Your .env and backups/ were left alone."
  else
    compose down --remove-orphans
    ok "Containers removed. Your data is still in $(env_get DATA_DIR). Reinstall with ./deploy.sh install."
  fi
}

case "$COMMAND" in
  install | wizard) cmd_install ;;
  update) cmd_update ;;
  updater) cmd_updater ;;
  schedule) cmd_schedule ;;
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) cmd_restart ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  backup) cmd_backup ;;
  restore) cmd_restore ;;
  admin) cmd_admin ;;
  doctor) cmd_doctor ;;
  uninstall) cmd_uninstall ;;
  help) usage ;;
  *) printf '%sUnknown command:%s %s\n\n' "$C_RED" "$C_OFF" "$COMMAND" >&2; usage >&2; exit 1 ;;
esac
