# shellcheck shell=bash
# shellcheck disable=SC2034,SC1091
# (OPT_*/W_*/FORCE_SOURCE are read by deploy.sh, which sources this file.)
# HomeVault install wizard. Sourced by deploy.sh (never run directly): it uses deploy.sh's
# helpers (info, ok, warn, die, env_get, port_in_use, latest_release_tag, ...) and answers its
# questions by filling in the same OPT_* variables the command-line options set.
#
# Prompts are read from and written to the terminal (/dev/tty), so the wizard also works when
# the script itself arrives through a pipe: curl -fsSL .../install.sh | bash

TTY=/dev/tty
REPLY_VALUE=""

# --- prompting -----------------------------------------------------------------------------
say() { printf '%s\n' "$*" >"$TTY"; }
heading() { printf '\n%s%s%s\n' "$C_BOLD" "$*" "$C_OFF" >"$TTY"; }
note() { printf '   %s\n' "$*" >"$TTY"; }

ask() { # ask "Question" "default" -> REPLY_VALUE
  local reply
  if [ -n "${2:-}" ]; then printf '%s [%s]: ' "$1" "$2" >"$TTY"; else printf '%s: ' "$1" >"$TTY"; fi
  IFS= read -r reply <"$TTY" || reply=""
  REPLY_VALUE="${reply:-${2:-}}"
}

ask_yn() { # ask_yn "Question" y|n -> status 0 for yes
  local def="${2:-y}" reply hint="Y/n"
  [ "$def" = y ] || hint="y/N"
  while true; do
    printf '%s [%s]: ' "$1" "$hint" >"$TTY"
    IFS= read -r reply <"$TTY" || reply=""
    reply="${reply:-$def}"
    case "$reply" in
      [Yy] | [Yy][Ee][Ss] | [Oo] | [Oo][Uu][Ii]) return 0 ;;
      [Nn] | [Nn][Oo] | [Nn][Oo][Nn]) return 1 ;;
    esac
    say "   Please answer y or n."
  done
}

ask_secret() { # ask_secret "Prompt" -> REPLY_VALUE (not echoed)
  local reply
  printf '%s: ' "$1" >"$TTY"
  IFS= read -r -s reply <"$TTY" || reply=""
  printf '\n' >"$TTY"
  REPLY_VALUE="$reply"
}

ask_choice() { # ask_choice "Question" DEFAULT "option 1" "option 2" ... -> REPLY_VALUE = chosen number
  local question="$1" def="$2" i=1 reply
  shift 2
  say "$question"
  for option in "$@"; do
    say "   $i) $option"
    i=$((i + 1))
  done
  while true; do
    printf 'Choose 1-%s [%s]: ' "$#" "$def" >"$TTY"
    IFS= read -r reply <"$TTY" || reply=""
    reply="${reply:-$def}"
    if [[ "$reply" =~ ^[0-9]+$ ]] && [ "$reply" -ge 1 ] && [ "$reply" -le "$#" ]; then REPLY_VALUE="$reply"; return 0; fi
    say "   Please type a number between 1 and $#."
  done
}

ask_number() { # ask_number "Question" DEFAULT MIN MAX
  while true; do
    ask "$1" "$2"
    if [[ "$REPLY_VALUE" =~ ^[0-9]+$ ]] && [ "$REPLY_VALUE" -ge "$3" ] && [ "$REPLY_VALUE" -le "$4" ]; then return 0; fi
    say "   Please enter a number between $3 and $4."
  done
}

# The current value from .env, else the one shipped in .env.example (a fresh install has no .env yet).
env_or_example() { # env_or_example KEY [FALLBACK]
  local value
  value="$(env_get "$1")"
  if [ -z "$value" ] && [ -f .env.example ]; then value="$(grep -E "^$1=" .env.example | tail -n 1 | cut -d= -f2- || true)"; fi
  printf '%s' "${value:-${2:-}}"
}

free_port_from() { # first port at or above $1 that nothing listens on
  local p="$1"
  while port_in_use "$p" && [ "$p" -lt 65000 ]; do p=$((p + 1)); done
  printf '%s' "$p"
}

# --- what are we running on? -----------------------------------------------------------------
detect_platform() {
  W_OS="$(. /etc/os-release 2>/dev/null && printf '%s' "${PRETTY_NAME:-}" || true)"
  [ -n "$W_OS" ] || W_OS="$(uname -s)"
  W_MODEL=""
  if [ -r /proc/device-tree/model ]; then W_MODEL="$(tr -d '\0' </proc/device-tree/model 2>/dev/null || true)"; fi
  W_MEM_MB=0
  if [ -r /proc/meminfo ]; then W_MEM_MB="$(awk '/^MemTotal:/ {print int($2/1024)}' /proc/meminfo)"; fi
  W_ARCH="$(docker info --format '{{.Architecture}}' 2>/dev/null || uname -m)"
}

ensure_docker_for_wizard() {
  if ! command -v docker >/dev/null 2>&1; then
    warn "Docker is not installed."
    if [ "$(uname -s)" = Linux ] && ask_yn "Install Docker now using Docker's official install script (get.docker.com)? It needs sudo" n; then
      command -v curl >/dev/null 2>&1 || die "curl is needed to download the Docker installer."
      local installer sudo_cmd=""
      installer="$(mktemp)"
      curl -fsSL https://get.docker.com -o "$installer" || die "Could not download the Docker installer."
      [ "$(id -u)" = 0 ] || sudo_cmd="sudo"
      $sudo_cmd sh "$installer" || die "The Docker installation failed."
      rm -f "$installer"
      if [ "$(id -u)" != 0 ]; then
        $sudo_cmd usermod -aG docker "$USER" || true
        say ""
        ok "Docker is installed. Log out and back in (so the 'docker' group applies), then run this again."
        exit 0
      fi
    else
      die "Install Docker first: https://docs.docker.com/engine/install/ (on a Raspberry Pi: curl -fsSL https://get.docker.com | sh), then run this again."
    fi
  fi
  if ! docker info >/dev/null 2>&1; then
    die "Docker is installed but this user cannot use it. Add yourself to the docker group (sudo usermod -aG docker \$USER, then log in again) or run with sudo."
  fi
  docker compose version >/dev/null 2>&1 || die "The Docker Compose plugin is missing. Install it: https://docs.docker.com/compose/install/"
}

# --- the questions -----------------------------------------------------------------------------
wizard_install_method() {
  heading "1. How should HomeVault be installed?"
  local tag="" ref=""
  if tag="$(latest_release_tag)"; then
    ref="$(default_registry_image):${tag#v}"
    if ! registry_has_image "$ref"; then tag=""; fi
  fi
  if [ -n "$tag" ]; then
    note "Newest release: ${tag}"
    ask_choice "" 1 \
      "Ready-made image (recommended): a quick download, and the right choice for a Raspberry Pi" \
      "Build from the source in this folder (slow: several minutes, much longer on a Pi)"
    if [ "$REPLY_VALUE" = 1 ]; then OPT_IMAGE="$ref"; W_METHOD="ready-made image $ref"; else FORCE_SOURCE=1; W_METHOD="build from source"; fi
  else
    note "No ready-made image was found (no internet, or no release published yet), so HomeVault will be built from the source in this folder."
    if [ "$W_MEM_MB" -gt 0 ] && [ "$W_MEM_MB" -lt 1500 ]; then
      warn "This machine has only ${W_MEM_MB} MB of memory; building may run out of memory. Try again later when a release is available."
    fi
    FORCE_SOURCE=1
    W_METHOD="build from source"
  fi
}

wizard_access() {
  heading "2. How will you reach HomeVault?"
  ask_choice "" 1 \
    "Only at home, over plain HTTP on my own network" \
    "From anywhere, over HTTPS on my own domain (automatic certificate)" \
    "Behind a reverse proxy I already run (Traefik, Nginx, Cloudflare Tunnel...)"
  local mode="$REPLY_VALUE" default_port
  default_port="$(env_or_example HOST_PORT 8080)"
  case "$mode" in
    1)
      ask_number "Port to listen on" "$(free_port_from "$default_port")" 1 65535
      OPT_PORT="$REPLY_VALUE"
      W_ACCESS="plain HTTP on port $OPT_PORT (home network)"
      ;;
    2)
      note "You need a domain name that points to this machine, and ports 80 and 443 forwarded to it."
      note "HomeVault then gets and renews a free Let's Encrypt certificate by itself."
      while true; do
        ask "Domain name (for example home.example.com)" "$(env_get DOMAIN)"
        if [[ "$REPLY_VALUE" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ && "$REPLY_VALUE" == *.* ]]; then break; fi
        say "   That doesn't look like a domain name."
      done
      OPT_DOMAIN="$REPLY_VALUE"
      if command -v getent >/dev/null 2>&1 && ! getent hosts "$OPT_DOMAIN" >/dev/null 2>&1; then
        warn "$OPT_DOMAIN does not resolve yet. The certificate can only be issued once its DNS record points here."
        ask_yn "Continue anyway?" y || die "Cancelled. Nothing was changed."
      fi
      W_ACCESS="HTTPS at https://$OPT_DOMAIN (certificate from Let's Encrypt)"
      ;;
    3)
      ask_number "Local port the proxy should forward to (listens on 127.0.0.1 only)" "$(free_port_from "$default_port")" 1 65535
      OPT_PORT="$REPLY_VALUE"
      OPT_BIND=127.0.0.1
      OPT_SETS+=("TRUST_PROXY=1")
      if ask_yn "Does the proxy provide HTTPS to your browsers?" y; then OPT_SETS+=("FORCE_HTTPS=true"); fi
      note "Make sure the proxy passes the original Host header and X-Forwarded-For / -Proto (docs/DEPLOYMENT.md has an example)."
      W_ACCESS="behind your reverse proxy (127.0.0.1:$OPT_PORT)"
      ;;
  esac
}

wizard_data() {
  heading "3. Where should HomeVault keep its data?"
  note "The database and every uploaded document live here. On a NAS, pick a folder on its volume."
  local def
  def="$(env_or_example DATA_DIR ./data)"
  while true; do
    ask "Data folder" "$def"
    if mkdir -p "$REPLY_VALUE" 2>/dev/null && [ -w "$REPLY_VALUE" ]; then break; fi
    say "   Cannot create or write to that folder. Try another (you may need sudo for system paths)."
  done
  OPT_DATA_DIR="$REPLY_VALUE"
}

wizard_language() {
  heading "4. Language"
  local def=1
  [ "$(env_get DEFAULT_LOCALE)" = fr ] && def=2
  ask_choice "Default language for new accounts (everyone can change theirs):" "$def" "English" "Français"
  if [ "$REPLY_VALUE" = 1 ]; then OPT_LOCALE=en; else OPT_LOCALE=fr; fi
}

wizard_email() {
  heading "5. Email reminders (optional)"
  note "HomeVault can email reminders for expiring warranties, documents and maintenance."
  W_EMAIL="off"
  ask_yn "Set up email now?" n || return 0
  local host port user pass from
  ask "SMTP server (for example smtp.gmail.com)" "$(env_get SMTP_HOST)"; host="$REPLY_VALUE"
  [ -n "$host" ] || { say "   No server given; skipping email."; return 0; }
  ask_number "SMTP port" "$(env_or_example SMTP_PORT 587)" 1 65535; port="$REPLY_VALUE"
  ask "SMTP user name (blank if none)" "$(env_get SMTP_USER)"; user="$REPLY_VALUE"
  pass=""
  if [ -n "$user" ]; then ask_secret "SMTP password (typing is hidden)"; pass="$REPLY_VALUE"; fi
  ask "Send mail from" "$(env_or_example SMTP_FROM homevault@example.com)"; from="$REPLY_VALUE"
  OPT_SETS+=("SMTP_HOST=$host" "SMTP_PORT=$port" "SMTP_USER=$user" "SMTP_PASS=$pass" "SMTP_FROM=$from")
  W_EMAIL="through $host"
}

wizard_updater() {
  heading "6. Updates"
  W_UPDATER="off"
  if [ "$(uname -s)" != Linux ] || [ ! -S "$(docker_socket_path)" ]; then
    note "One-click updates need Linux and access to the Docker socket, so they are off here. Update with ./deploy.sh update."
    OPT_UPDATER=false
    return 0
  fi
  note "HomeVault tells administrators when a new version is out. With one-click updates they can install it with a button in Settings."
  note "That adds a small helper container that can control Docker on this machine. It only acts when an administrator confirms an update with their password."
  note "(You can turn it off at any time: ./deploy.sh updater disable. Without it, update with ./deploy.sh update.)"
  if ask_yn "Enable one-click updates?" y; then OPT_UPDATER=true; W_UPDATER="on"; else OPT_UPDATER=false; fi
}

wizard_backups() {
  heading "7. Backups"
  W_BACKUP="off"
  if ! command -v crontab >/dev/null 2>&1; then
    note "cron is not installed, so no automatic schedule can be set up. Run ./deploy.sh backup yourself, or install cron and use ./deploy.sh schedule on."
    OPT_SCHEDULE=off
    return 0
  fi
  note "HomeVault always keeps nightly database snapshots. A full backup also includes your uploaded files."
  if ask_yn "Make a full backup every night at 03:30 (the newest 10 are kept in ./backups)?" y; then OPT_SCHEDULE=on; W_BACKUP="nightly at 03:30"; else OPT_SCHEDULE=off; fi
  note "Remember to copy backups to another machine or disk: a backup on the same disk is not enough."
}

wizard_admin() {
  heading "8. Your administrator account"
  if [ -f "$ENV_FILE" ] && [ "$COMMAND" = wizard ]; then
    W_ADMIN="(already set up)"
    return 0
  fi
  W_ADMIN="create it in the browser"
  note "You can create it now, or later in the browser (a one-time setup token is shown at the end)."
  ask_yn "Create the administrator now?" y || return 0
  ask "Your name" "Admin"; OPT_ADMIN_NAME="$REPLY_VALUE"
  while true; do
    ask "Email address (used to sign in)" ""
    if [[ "$REPLY_VALUE" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; then break; fi
    say "   That doesn't look like an email address."
  done
  OPT_ADMIN_EMAIL="$REPLY_VALUE"
  wizard_ask_password
  W_ADMIN="$OPT_ADMIN_NAME <$OPT_ADMIN_EMAIL>"
}

wizard_ask_password() {
  local first second
  note "Choose a long password (10+ characters). A few random words make a strong, memorable one."
  while true; do
    ask_secret "Password (typing is hidden)"; first="$REPLY_VALUE"
    if [ "${#first}" -lt 10 ]; then say "   Too short: use at least 10 characters."; continue; fi
    ask_secret "Type it again"; second="$REPLY_VALUE"
    if [ "$first" = "$second" ]; then W_ADMIN_PASSWORD="$first"; return 0; fi
    say "   The two passwords differ. Try again."
  done
}

# Called by deploy.sh when the server refused the password (for example "too common").
wizard_retry_admin() {
  local tries=0
  while [ "$tries" -lt 3 ]; do
    tries=$((tries + 1))
    say "Let's try a different password."
    wizard_ask_password
    if create_admin_now; then return 0; fi
  done
  warn "Could not create the administrator. You can do it later: ./deploy.sh admin create-admin $OPT_ADMIN_EMAIL"
  return 0
}

# --- the wizard ----------------------------------------------------------------------------------
run_wizard() {
  W_METHOD="" W_ACCESS="" W_EMAIL="" W_UPDATER="" W_BACKUP="" W_ADMIN=""
  heading "HomeVault setup"
  say "A few questions, then everything is installed. Press Enter to accept the suggestion in [brackets]."

  ensure_docker_for_wizard
  detect_platform
  heading "This machine"
  note "${W_MODEL:-$W_OS}"
  note "Architecture: $W_ARCH, memory: ${W_MEM_MB} MB"
  case "$W_ARCH" in
    x86_64 | aarch64) ok "Supported platform (amd64 / arm64)" ;;
    armv7l | armhf | arm | armv6l)
      die "This is a 32-bit ARM system. HomeVault needs a 64-bit operating system. On a Raspberry Pi 3, 4 or 5 install Raspberry Pi OS (64-bit) and run this again." ;;
    *) die "Architecture '$W_ARCH' is not supported (HomeVault runs on amd64 and arm64)." ;;
  esac
  if [ "$W_MEM_MB" -gt 0 ] && [ "$W_MEM_MB" -lt 1500 ]; then
    note "Less than 1.5 GB of memory: HomeVault will be limited to 512 MB, which is plenty for a household."
    OPT_SETS+=("HOMEVAULT_MEMORY=512m")
  fi

  wizard_install_method
  wizard_access
  wizard_data
  wizard_language
  wizard_email
  wizard_updater
  wizard_backups
  wizard_admin

  heading "Ready to install"
  note "Install     : $W_METHOD"
  note "Access      : $W_ACCESS"
  note "Data folder : ${OPT_DATA_DIR:-./data}"
  note "Language    : $OPT_LOCALE"
  note "Email       : $W_EMAIL"
  note "Updates     : one-click $W_UPDATER"
  note "Backups     : $W_BACKUP"
  note "Admin       : $W_ADMIN"
  say ""
  ask_yn "Install now?" y || die "Cancelled. Nothing was changed."
  say ""
}
