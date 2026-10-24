#!/usr/bin/env bash
# Black-box check of a running, brand-new HomeVault over HTTP: first-run setup, sign-in,
# uploads, access control and the security headers. Used by CI after ./deploy.sh install,
# and handy after your own install.
#
#   scripts/smoke-test.sh [base-url]        (default http://127.0.0.1:8080)
#
# It creates an administrator, so run it only against an instance you are about to throw away.
# The setup token is read from $SETUP_TOKEN or from ./.env.

set -euo pipefail

BASE="${1:-http://127.0.0.1:8080}"
BASE="${BASE%/}"
cd "$(dirname "${BASH_SOURCE[0]}")/.."

SETUP_TOKEN="${SETUP_TOKEN:-$(grep -E '^SETUP_TOKEN=' .env 2>/dev/null | tail -n 1 | cut -d= -f2 || true)}"
EMAIL="smoke@homevault.test"
PASSWORD="orbit-lantern-maple-71"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
JAR="$WORK/cookies"
FAILED=0

pass() { printf ' ok   %s\n' "$1"; }
fail() { printf ' FAIL %s\n' "$1" >&2; FAILED=1; }
check() { # check "description" command...
  local what="$1"
  shift
  if "$@" >/dev/null 2>&1; then pass "$what"; else fail "$what"; fi
}

# status_of METHOD PATH [curl options...] -> prints only the HTTP status code
status_of() {
  local method="$1" path="$2"
  shift 2
  curl -s -o /dev/null -w '%{http_code}' -X "$method" "$@" "$BASE$path"
}
json_field() { # json_field FIELD < json
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s)[process.argv[1]];console.log(v===undefined?"":v)})' "$1"
}
expect_status() { # expect_status "description" CODE METHOD PATH [curl options...]
  local what="$1" want="$2" got
  shift 2
  got="$(status_of "$@")"
  if [ "$got" = "$want" ]; then pass "$what"; else fail "$what (expected $want, got $got)"; fi
}

echo "Smoke test against $BASE"

expect_status "health endpoint answers" 200 GET /api/health
check "the built web app is served" bash -c "curl -fsS '$BASE/' | grep -q '<div id=\"root\">'"
check "an unknown /api path is a 404, not the web app" bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' '$BASE/api/nope')\" = 404 ]"

headers="$(curl -sS -D - -o /dev/null "$BASE/")"
has_header() { grep -qi "^$1" <<<"$headers"; }
not() { ! "$@"; }
check "Content-Security-Policy is set" has_header 'content-security-policy:'
check "X-Content-Type-Options: nosniff is set" has_header 'x-content-type-options: nosniff'
check "the server doesn't advertise Express" not has_header 'x-powered-by'

expect_status "nothing is readable before sign-in" 401 GET /api/properties

status="$(curl -fsS "$BASE/api/auth/status")"
if [ "$(json_field needs_setup <<<"$status")" = true ]; then pass "a fresh instance asks for first-run setup"; else fail "expected a fresh instance (needs_setup=true): $status"; fi

if [ "$(json_field setup_token_required <<<"$status")" = true ]; then
  [ -n "$SETUP_TOKEN" ] || { echo "The instance wants a setup token: set SETUP_TOKEN or run from the folder with .env" >&2; exit 2; }
  expect_status "a wrong setup token cannot claim the instance" 403 POST /api/auth/setup \
    -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"name\":\"Smoke\",\"setup_token\":\"wrong-token\"}"
fi
expect_status "a weak password is refused" 400 POST /api/auth/setup \
  -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"password123\",\"name\":\"Smoke\",\"setup_token\":\"$SETUP_TOKEN\"}"

curl -sS -D "$WORK/setup.headers" -o "$WORK/setup.body" -c "$JAR" -X POST "$BASE/api/auth/setup" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"name\":\"Smoke\",\"setup_token\":\"$SETUP_TOKEN\"}" >/dev/null
check "the right token and a strong password create the administrator" grep -q '"is_admin":true' "$WORK/setup.body"
check "the session cookie is HttpOnly and SameSite=Strict" bash -c "grep -i '^set-cookie: .*hv_session=[^;]' '$WORK/setup.headers' | grep -qi 'HttpOnly' && grep -i '^set-cookie: .*hv_session=[^;]' '$WORK/setup.headers' | grep -qi 'SameSite=Strict'"
check "no token is returned in the response body" bash -c "! grep -qi 'token' '$WORK/setup.body'"
expect_status "setup can't be run twice" 403 POST /api/auth/setup \
  -H 'Content-Type: application/json' -d "{\"email\":\"two@homevault.test\",\"password\":\"$PASSWORD\",\"name\":\"Two\",\"setup_token\":\"$SETUP_TOKEN\"}"

C=(-b "$JAR")
expect_status "the cookie identifies the administrator" 200 GET /api/auth/me "${C[@]}"

property="$(curl -fsS "${C[@]}" -X POST "$BASE/api/properties" -H 'Content-Type: application/json' -d '{"name":"Smoke House"}' | json_field id)"
check "a property can be created" test -n "$property"

printf 'hello from the smoke test\n' >"$WORK/note.txt"
document="$(curl -fsS "${C[@]}" -X POST "$BASE/api/documents" -F "property_id=$property" -F 'title=Smoke note' -F "file=@$WORK/note.txt" | json_field id)"
check "a document can be uploaded" test -n "$document"
check "the document downloads unchanged" bash -c "[ \"\$(curl -fsS -b '$JAR' '$BASE/api/documents/$document/download')\" = 'hello from the smoke test' ]"
check "search finds it" bash -c "curl -fsS -b '$JAR' '$BASE/api/search?q=smoke' | grep -q 'Smoke note'"

expect_status "a cross-site write is refused (CSRF)" 403 POST /api/properties "${C[@]}" \
  -H 'Origin: https://evil.example' -H 'Content-Type: application/json' -d '{"name":"CSRF"}'
expect_status "a made-up session cookie is refused" 401 GET /api/properties -H 'Cookie: hv_session=not-a-real-session'
expect_status "the old Authorization-header scheme is gone" 401 GET /api/properties -H 'Authorization: Bearer abc'

curl -fsS "${C[@]}" -X POST "$BASE/api/auth/logout" -o /dev/null
expect_status "logging out ends the session on the server" 401 GET /api/auth/me "${C[@]}"

if [ "$FAILED" = 0 ]; then
  echo "All checks passed."
else
  echo "Some checks failed." >&2
  exit 1
fi
