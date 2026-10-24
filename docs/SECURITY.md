# Security

HomeVault holds the paperwork of a household (deeds, insurance, receipts, serial
numbers), so it is built to be safe to run on a home network and, with HTTPS,
on the internet. This page says what is protected, how, and where the limits
are. For running it, see [DEPLOYMENT.md](DEPLOYMENT.md).

## Reporting a vulnerability

Please don't open a public issue for a security problem. Use **Security →
Report a vulnerability** on the GitHub repository (a private advisory), with
steps to reproduce. You'll get an answer as soon as a maintainer can look.

## The short version

| Threat | What HomeVault does |
| --- | --- |
| Guessing or stuffing passwords | scrypt hashing; per-address and per-account throttles; a password policy that rejects common and personal passwords; optional second factor |
| A stolen password | Two-factor authentication (authenticator app) with single-use recovery codes |
| A stolen or left-open session | Server-side sessions you can end per device; idle and absolute timeouts; all other devices signed out when the password or 2FA changes |
| Cross-site request forgery | `SameSite=Strict` cookie plus an Origin / Fetch-Metadata check on every write |
| Script injection (XSS) | No inline scripts allowed by a strict Content-Security-Policy; React escapes output; the session cookie is `HttpOnly`, so a script can't read it anyway |
| Seeing another household member's data | Access to each property is checked on every request; search, exports and calendar links only cover properties you can see |
| Someone claiming a fresh install | The first administrator needs the one-time `SETUP_TOKEN` |
| A leaked database or backup | Passwords are hashed, session tokens and recovery codes are stored only as hashes, 2FA secrets and calendar-link secrets are encrypted or hashed |
| A compromised container | Unprivileged user, read-only root filesystem, no capabilities for the app, `no-new-privileges`, resource limits |

## Authentication

- **Passwords** are hashed with scrypt (N=32768, r=8, p=1, per-password random
  salt), computed off the main thread with a concurrency limit so a flood of
  logins can't stall the server. Input is Unicode-normalised, so the same
  password typed on different devices matches. Hashes from earlier versions
  (bcrypt) are accepted once and upgraded on that person's next sign-in.
- **Policy:** at least 10 characters (up to 256); common passwords, repeated or sequential
  characters, and passwords containing a word from the person's name or email
  address are refused. There are no composition rules ("one symbol…") because
  length helps more.
- **Unknown accounts take as long as known ones** (a dummy hash is verified), and
  the error message is the same, so response time doesn't reveal who has an
  account.
- **Admin-issued passwords are temporary.** Accounts created by an admin, and
  passwords an admin resets, must be replaced at the next sign-in before anything
  else in the app works.

### Sessions

- A sign-in creates a random 256-bit token. The browser keeps it in an
  `HttpOnly`, `SameSite=Strict` cookie; the database keeps only its SHA-256 hash.
  There is nothing in `localStorage` and no token in any URL.
- Over HTTPS (or with `FORCE_HTTPS=true`) the cookie is `Secure` and named
  `__Host-hv_session`, which browsers refuse to accept from a sibling subdomain
  or over plain HTTP.
- Sessions expire after `SESSION_IDLE_DAYS` (14) of inactivity or `SESSION_DAYS`
  (30) in total. A person can have at most 20; the oldest are retired.
- *Settings → Security* lists every signed-in device (browser, OS, address, last
  seen) and ends any of them immediately. Changing the password, turning 2FA on
  or off, disabling an account or an admin reset all end the other sessions.

### Two-factor authentication

- Standard TOTP (RFC 6238; 6 digits, 30 seconds, one step of clock drift allowed)
  that works with any authenticator app. The enrolment screen shows a QR code and
  the manual key; 2FA only turns on after a correct code is entered.
- A code can be used **once**: replaying a code that was already accepted is
  refused, even inside its time window.
- **Recovery codes:** ten single-use codes, shown once, stored hashed. Using one
  is recorded in the audit log. Regenerating them invalidates the old set.
- Secrets are stored encrypted (AES-256-GCM) with a key derived from `DATA_KEY`.
  A database backup alone therefore doesn't reveal them. If `DATA_KEY` is lost or
  changed, existing 2FA secrets become unreadable: the person signs in with a
  recovery code, or an admin runs `./deploy.sh admin disable-2fa <email>`.
- Sign-in with 2FA is two steps. After the password, the server hands back a short
  (5 minute), signed, single-purpose challenge — not a session. Guessing codes is
  throttled (6 wrong attempts per 10 minutes per account).
- Turning 2FA off or generating new recovery codes asks for the current password and
  a valid code; changing the password asks for the current one.

### Throttling

| What | Limit |
| --- | --- |
| Failed sign-ins per IP address | `LOGIN_RATE_LIMIT` per 15 minutes (default 20) |
| Failed sign-ins per account | 10 per 15 minutes, whichever address they come from |
| Wrong 2FA codes | 6 per 10 minutes per account |
| Wrong current password when confirming a change | 8 per 15 minutes per account |
| Calendar-feed requests | rate limited per address |

The per-account counters live in memory, so a restart resets them; the per-IP limit
needs `TRUST_PROXY` set correctly behind a proxy so it sees real addresses.

## Authorization

- Each property has **owners** (full control) and **viewers** (read, tick off
  reminders). The check happens on every request against the database, so removing
  someone takes effect immediately. A property always keeps one owner.
- **Admins** manage accounts and see every property. They can't read anyone's
  password; resetting one produces a temporary password they hand over.
- Global search, the inventory/expense CSV, the "export everything" bundle and the
  calendar links are all limited to properties the signed-in person can access.
- A disabled account can't sign in and its sessions are ended at once.

## Browser-facing hardening

- **CSRF:** every write to `/api` must come from the app's own origin. The server
  compares the `Origin` header to the host it was reached on (or `TRUSTED_ORIGINS`)
  and rejects `Sec-Fetch-Site` values other than same-origin. Command-line clients
  that send neither header still work with their session cookie.
- **CSP and friends:** `default-src 'self'`, no inline scripts, `frame-ancestors
  'none'`, `object-src 'none'`, `Referrer-Policy: no-referrer`,
  `X-Content-Type-Options: nosniff`, a restrictive `Permissions-Policy`, and
  same-origin cross-origin policies. API responses are `Cache-Control: no-store`.
  There is no CORS: the API is for the bundled web app only.
- **HSTS** is sent only when you say HTTPS is permanent (`FORCE_HTTPS=true`, which
  `--domain` sets), so a plain-HTTP LAN install keeps working.
- **Uploads:** size-limited, written to a private temporary folder before anything
  user-controlled is used in a path, stored under generated names, and served as
  attachments with `nosniff`. Equipment photos accept only image types and take
  their extension from the type, not the filename.
- **Spreadsheets:** CSV exports neutralise cells starting with `=`, `+`, `-`, `@`
  so opening them in Excel can't run a formula.

## Calendar subscription links

A link like `/api/calendar-feed/hvcal_….ics` lets a calendar app read your
reminders without signing in. It is a bearer secret, so:

- the secret is 256 bits, shown **once**, and only its hash is stored;
- each link is separate (name them per device) and revocable on its own;
- a link is read-only and covers only what its owner can see;
- anyone who has the URL can read the titles and dates in it. Treat it like a
  password and revoke it if it leaks.

## Audit log

Sign-ins and failures, password and 2FA changes, account creation/disabling/reset,
sharing, exports, backups and link creation are recorded with time, person, IP
address and device. People see their own recent activity in *Settings → Security*;
admins see everyone's in *Settings → Administration* and can filter it. Entries
older than `AUDIT_RETENTION_DAYS` (400) are removed nightly. Secrets — passwords,
codes, tokens — are never written to it (this is tested).

## Data at rest

- The SQLite file and its backups are created readable by the app user only (0600).
- **Uploaded documents and photos are not encrypted by HomeVault.** Use full-disk
  or volume encryption on the machine or NAS if that matters for your threat model.
- Backups contain password hashes, hashed tokens and *encrypted* 2FA secrets; treat
  them as sensitive. `./deploy.sh backup --include-secrets` also adds `.env` — then
  the file is as sensitive as your whole install.

## Container and network

- `./deploy.sh install --domain` fronts the app with Caddy (automatic Let's Encrypt
  certificates, HTTP→HTTPS redirect, HTTP/2 and HTTP/3). The app is then bound to
  `127.0.0.1` and only Caddy is reachable from outside.
- The app runs as the unprivileged `node` user in a container with a read-only root
  filesystem, `cap_drop: ALL` (the entrypoint keeps only what it needs to fix volume
  ownership before dropping privileges), `no-new-privileges`, a PID limit, a memory
  limit, an init process and rotated logs.
- The server validates its configuration at start-up and **refuses to run** in
  production with a missing, placeholder or short `APP_SECRET`, or with malformed
  security-related settings.

## In-app updates

The *Update* button is convenient, and it needs a privileged helper, so this is the trade-off in
plain terms.

- **The app can't touch Docker.** When an administrator confirms an update (password, and the 2FA
  code when on), the app only writes a tiny request file into the data folder. It also checks for new
  releases by asking `api.github.com` which release is newest; no data about you or the installation is
  sent (turn it off with `UPDATE_CHECK=false`).
- **The updater helper** is a separate container that watches for that file. To replace the app it
  has access to the Docker socket, which on a normal Linux host is equivalent to root on that machine.
  It runs as an ordinary user, with a read-only filesystem, no capabilities, no network ports and
  resource limits, and it is only started if you choose one-click updates.
- **What it will do** is fixed: run `./deploy.sh update` for the newest published release. The request
  contributes nothing but "go": the version is looked up again from the project's releases, must be a
  plain `x.y.z` version, and a malformed request is ignored. So a compromised app (or an administrator
  session) can at worst trigger an update to the official latest release.
- **What you trust** is whoever can publish releases to the GitHub repository (and its package
  registry): an update downloads that release's files and images. This is the same trust as installing
  HomeVault in the first place.
- **If that isn't acceptable**, don't enable it (`./deploy.sh updater disable` or answer *no* in the
  wizard): everything else works, and you update from a terminal.
- Every request and result is recorded in the audit log.

## Supply chain

CI runs the test suite, `npm audit` on production dependencies, shellcheck and a
full install/restore cycle on every pull request. Dependabot proposes dependency,
base-image and workflow updates. Released images are multi-architecture (amd64 and arm64) and carry
build provenance and an SBOM; a CI job runs the arm64 image and a full update and rollback cycle on
every pull request.

## What HomeVault doesn't do (yet)

- No WebAuthn/passkeys; TOTP can be phished by a convincing fake site.
- No email-based password reset: an admin resets it (or use the CLI on the host).
  This is deliberate for a self-hosted install without guaranteed email.
- Uploaded files aren't encrypted at rest (see above).
- One server, one SQLite file: it isn't designed for multi-node deployments.
- It does not defend against someone with root on the host or access to your `.env`
  and data folder together.

## Operator checklist

- [ ] HTTPS in front of anything reachable from outside your LAN (`--domain`)
- [ ] Two-factor authentication on every admin account
- [ ] `.env` kept private (mode 600) **and** copied somewhere safe, separate from backups
- [ ] `./deploy.sh backup` on a schedule, and archives copied off the machine
- [ ] `./deploy.sh update` regularly, or Dependabot/Watchtower-style notices followed
- [ ] `SETUP_TOKEN` removed from `.env` after the first admin exists (optional)
- [ ] Disk or volume encryption if the machine could be physically taken
- [ ] `./deploy.sh doctor` is clean
