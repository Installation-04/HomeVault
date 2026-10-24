# Deploying HomeVault

HomeVault runs as one container, plus two optional helpers: Caddy for automatic HTTPS and the
updater behind the in-app *Update* button. The `deploy.sh` script in the repository root does the
setup and the day-to-day chores, so you rarely need to touch Docker directly.

**You need:** Linux (a server, a NAS or a Raspberry Pi) with Docker and the Compose plugin
(`docker compose version`), plus `bash`. About 1 GB of free disk and 512 MB of RAM.

**Supported CPUs:** amd64 (Intel/AMD) and arm64 (Raspberry Pi 3/4/5 with a **64-bit** OS, Apple
silicon, most ARM servers). 32-bit ARM systems are not supported; the wizard says so and suggests
the 64-bit OS image.

## Install

### One line

```bash
curl -fsSL https://raw.githubusercontent.com/Installation-04/HomeVault/main/install.sh | bash
```

This downloads the newest release into `~/homevault` (set `HOMEVAULT_DIR` to choose another
folder) and starts the wizard. Add options after `bash -s --`, for example
`... | bash -s -- --domain home.example.com --yes`. If you'd rather read the script first, clone the
repository and run `./deploy.sh install` yourself; it asks the same questions.

### The wizard

On a terminal, `./deploy.sh install` asks:

1. **How to install:** the ready-made image (a quick download; the right choice on a Raspberry Pi)
   or a build from the source in the folder (several minutes, much longer on a Pi).
2. **How you will reach it:** only at home over plain HTTP; from anywhere over HTTPS on your own domain
   (automatic Let's Encrypt certificate, see below); or behind a reverse proxy you already run.
3. **Where the data lives** (point it at your NAS volume if you like).
4. **Language** for new accounts, English or French.
5. **Email reminders** through your SMTP server (optional).
6. **One-click updates** (the updater helper; see [Updates](#updates-in-the-app)).
7. **A nightly full backup** through cron (database and uploaded files).
8. **Your administrator account**, so there is nothing left to do in the browser.

It shows a summary and asks for confirmation before changing anything. Run `./deploy.sh wizard`
later to change settings of an installed copy; secrets and data are kept.

Without a terminal, or with `--yes`, no questions are asked: defaults and your options are used.

### What install does

1. Checks Docker, Compose, the CPU architecture, free disk space and that the port is free.
2. Creates `.env` from `.env.example` (mode 600) with freshly generated `APP_SECRET`, `DATA_KEY`
   and `SETUP_TOKEN`. Existing values are never overwritten, so it is safe to run again.
3. Downloads (or builds) the image and starts the container.
4. Waits until the health check passes, creates your administrator (or prints the setup token) and
   shows the address.

> **Back up `.env` right now** (in a password manager, not next to your database backups).
> `DATA_KEY` is what makes the two-factor secrets in a restored backup readable; without it people
> just need to re-enrol (or sign in with a recovery code).

### Options (for scripts)

| Option | Meaning |
| --- | --- |
| `--yes`, `-y` | Never ask questions |
| `--image <ref>` | Use this image, e.g. `ghcr.io/installation-04/homevault:1.0.0`; `auto` = the newest release's image (builds if none) |
| `--source` | Build from the source in this folder |
| `--domain home.example.com` | Serve HTTPS with an automatic Let's Encrypt certificate (see below) |
| `--port 8080` / `--bind 127.0.0.1` | Host port / listen address (loopback with `--domain`) |
| `--data-dir /volume1/homevault` | Where the database and uploads live |
| `--locale en\|fr` | Default language |
| `--set KEY=VALUE` | Put any setting into `.env` (repeatable), e.g. `--set SMTP_HOST=smtp.example.com` |
| `--updater` / `--no-updater` | Enable or skip the one-click update helper |
| `--admin-email`, `--admin-name`, `--admin-password-file` | Create the administrator during install (the file's first line is the password; it is not kept) |
| `--schedule` / `--no-schedule` | Set up (or skip) the nightly backup cron entry |
| `--no-wizard` | Don't ask questions even on a terminal |
| `--no-start` | Only write the configuration |

Options are saved in `.env`, so later commands remember them.

## HTTPS

### Bundled (Caddy, automatic certificates)

```bash
./deploy.sh install --domain home.example.com
```

Needs a DNS record for the name pointing at this machine, and ports **80** and **443**
reachable from the internet (forward them on your router). Caddy gets and renews the
certificate, redirects HTTP to HTTPS, and serves HTTP/2 and HTTP/3. The app itself is
then bound to `127.0.0.1`, so nothing but Caddy is exposed. The script also sets
`TRUST_PROXY=1` and `FORCE_HTTPS=true`.

Certificates are kept in the `homevault_caddy_data` volume. Don't delete it casually:
Let's Encrypt limits how often a name can be issued new certificates.

Only for use on your LAN? Skip HTTPS; plain HTTP on a trusted network is fine, but don't
forward the port to the internet without it.

### Your own reverse proxy

Already running Traefik, Nginx Proxy Manager or similar? Install without `--domain`, bind
to the loopback address, and proxy to it:

```bash
./deploy.sh install --bind 127.0.0.1 --port 8080
# then in .env:  TRUST_PROXY=1   (and FORCE_HTTPS=true once HTTPS works)
```

The proxy must pass the original `Host` header (the app compares it with the browser's
`Origin` to refuse cross-site writes), set `X-Forwarded-For` / `X-Forwarded-Proto`, and
allow uploads of about 60 MB. Nginx example:

```nginx
server {
  listen 443 ssl http2;
  server_name home.example.com;
  # ssl_certificate ... ;
  client_max_body_size 60m;
  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

If the host name the browser uses differs from the one the proxy forwards, add the public
one to `TRUSTED_ORIGINS` (comma-separated, e.g. `https://home.example.com`).

## Everyday commands

| Command | What it does |
| --- | --- |
| `./deploy.sh status` | Container health, address, data size, latest backup |
| `./deploy.sh logs [-f]` | Recent logs (`-f` to follow) |
| `./deploy.sh start` / `stop` / `restart` | Control the container; data is untouched |
| `./deploy.sh update` | Back up, install the newest release, restart, verify; roll back on failure |
| `./deploy.sh updater enable\|disable\|status` | The helper behind the in-app Update button |
| `./deploy.sh schedule on\|off\|status` | Nightly full backup through cron |
| `./deploy.sh wizard` | Run the guided setup again to change settings |
| `./deploy.sh backup` | Verified backup archive in `./backups` |
| `./deploy.sh restore <file>` | Replace the data with a backup (safety backup first) |
| `./deploy.sh admin <cmd>` | Admin CLI inside the container (below) |
| `./deploy.sh doctor` | Checks configuration, health, user, HTTPS, backups |
| `./deploy.sh uninstall [--purge]` | Remove containers (`--purge` also deletes data) |

### Admin CLI

```bash
./deploy.sh admin list-users
./deploy.sh admin create-admin you@example.com --name "Your Name"   # prints a temporary password
./deploy.sh admin reset-password someone@example.com                 # new temporary password, signs them out
./deploy.sh admin disable-2fa someone@example.com                    # lost phone and recovery codes
./deploy.sh admin revoke-sessions someone@example.com
./deploy.sh admin check                                              # integrity check and record counts
./deploy.sh admin help
```

This is also how you get back in if every administrator is locked out. Each use is
written to the audit log.

## Updates

HomeVault is released as numbered versions (for example `1.2.0`) on the
[Releases page](https://github.com/Installation-04/HomeVault/releases); the
[changelog](../CHANGELOG.md) says what changed.

### Updates in the app

When an administrator opens HomeVault, the app asks GitHub whether a newer release exists (the answer
is remembered for hours; nothing about you or your data is sent; `UPDATE_CHECK=false` turns it off).
If there is one, administrators see a notice, and *Settings → Administration → Software update*
shows the release notes and an **Update** button.

Pressing it asks for the administrator's password (and two-factor code, if on) and then:

1. the app writes a small request; **the app itself never touches Docker**,
2. the *updater* helper container picks it up and runs `./deploy.sh update`,
3. that takes a backup, switches the files and image to the new release, restarts HomeVault and
   waits for it to be healthy,
4. if the new version doesn't start, the previous version and files are put back and the page says
   so. Your data is not touched by an update that failed to start.

The page shows progress and reloads itself when the update has finished. A few seconds of downtime
during the restart is normal.

**The updater helper** is a small container with access to the Docker socket (that is how it can
replace the app container), so it can control Docker on this machine. It has no ports, a read-only
filesystem and no extra capabilities, only acts when an administrator confirms an update, and always
installs the newest published release, never something the request names. The wizard offers it
(default yes); manage it with:

```bash
./deploy.sh updater status
./deploy.sh updater disable     # the Update button then shows the terminal command instead
./deploy.sh updater enable
```

See [SECURITY.md](SECURITY.md#in-app-updates) for the trade-off. It needs Linux and a local Docker
socket (it does not work with Docker Desktop on Mac or Windows).

### Updates from a terminal

```bash
./deploy.sh update              # install the newest release
./deploy.sh update --check      # only say whether there is one
./deploy.sh update --to 1.2.0   # a specific release
```

For a git checkout (what the installer creates) the files in the folder move to the release's tag
too; with a ready-made image the image tag moves; with a source install it rebuilds. If you changed
files in the folder, they are left alone and only the image is updated. The previous image stays
available as `homevault-rollback:latest` until the next update. `--no-git` keeps the files as they
are and just re-pulls or rebuilds; `--edge` follows the `main` branch (for developers).

## Backups

There are two layers and you should use both:

1. **Automatic nightly database snapshots** by the app itself (`BACKUP_CRON`, default
   3 am; the newest `BACKUP_KEEP`, default 14, are kept in `DATA_DIR/backups`). Each is
   integrity-checked. These cover the database only.
2. **`./deploy.sh backup`**: one `.tar.gz` in `./backups` with a consistent database
   snapshot (taken with SQLite's online backup, safe while the app runs), all uploaded
   files, and a `MANIFEST.txt` with record counts. The newest 10 are kept (`ARCHIVES_TO_KEEP`).

A backup on the same disk isn't a backup. Copy the archives elsewhere, for example with a
cron entry:

```cron
15 3 * * *  cd /opt/HomeVault && ./deploy.sh backup && rsync -a backups/ nas:/backups/homevault/
```

Archives do not contain `.env`. Add `--include-secrets` only if the archive will be stored as
carefully as the key itself.

### Restoring

```bash
./deploy.sh restore backups/homevault-backup-20261024T030000Z.tar.gz
```

It shows what will be replaced and asks first, takes a safety backup of what is there now,
stops the app, swaps in the database and uploads, starts it and checks health. The previous
data is only removed after the restored copy is healthy.

**Moving to a new machine:** clone the repository, copy your saved `.env` into it, run
`./deploy.sh install`, copy the archive over and `./deploy.sh restore` it. With the original
`DATA_KEY` in `.env`, two-factor sign-in keeps working.

## Configuration (`.env`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `APP_SECRET` | generated | Required. Signs short-lived sign-in challenges. (`JWT_SECRET` still works as the old name.) |
| `DATA_KEY` | generated | Encrypts 2FA secrets in the database. Keep it with your backups' key material. |
| `SETUP_TOKEN` | generated | Needed to create the first admin. Harmless to leave; remove it if you like. |
| `HOST_PORT` / `BIND_ADDRESS` | `8080` / `0.0.0.0` | Where the app is published on the host |
| `DOMAIN` | empty | Enables the HTTPS profile (set by `--domain`) |
| `TRUST_PROXY` | empty | Number of reverse proxies in front (`1` for Caddy/Traefik/Nginx) |
| `TRUSTED_ORIGINS` | empty | Extra allowed `Origin`s for writes, comma-separated |
| `COOKIE_SECURE` | `auto` | `auto`, `always` or `never` for the Secure cookie flag |
| `FORCE_HTTPS` | `false` | `true` sends HSTS and always uses Secure cookies |
| `DATA_DIR` | `./data` | Host folder mounted into the container |
| `SESSION_DAYS` / `SESSION_IDLE_DAYS` | `30` / `14` | Absolute and idle session lifetime |
| `LOGIN_RATE_LIMIT` | `20` | Failed sign-ins per address per 15 minutes |
| `BACKUP_CRON` / `BACKUP_KEEP` | `0 3 * * *` / `14` | Nightly database snapshot schedule and retention |
| `AUDIT_RETENTION_DAYS` | `400` | How long audit entries are kept |
| `REMINDER_CHECK_CRON` / `EXPIRY_NOTICE_DAYS` | `0 8 * * *` / `30` | Email reminder schedule and lead time (`0` turns expiry notices off) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | empty | Optional email for reminders |
| `DEFAULT_LOCALE` | `en` | `en` or `fr` for new accounts |
| `UPDATE_CHECK` | `true` | Check GitHub for new releases and offer updates; `false` turns it off |
| `ENABLE_UPDATER` | `false` | The one-click update helper (managed by `./deploy.sh updater`) |
| `HOMEVAULT_IMAGE` | `homevault:latest` | Image to run (set by `--image`; updates move its tag) |
| `HOMEVAULT_MEMORY` | `768m` | Container memory limit |

After editing `.env`, run `./deploy.sh restart`. The app checks its configuration on start
and says exactly what is wrong if something is invalid.

## Where things live

```
HomeVault/            the repository (deploy.sh, docker-compose.yml, .env)
├── .env              your secrets and settings (mode 600)
├── backups/          archives from ./deploy.sh backup
└── data/             DATA_DIR, mounted at /app/backend/data
    ├── homevault.sqlite    the database
    ├── uploads/            documents and photos
    ├── backups/            nightly database snapshots
    └── .update/            requests and progress shared with the updater helper (no secrets)
```

The image itself holds no data; you can rebuild or replace it at will. File ownership in
`data/` is set to the container's `node` user (uid 1000) when the container starts. On a NAS
share that refuses `chown`, the container logs a warning and keeps working as root.

## Without the script

```bash
cp .env.example .env     # fill in APP_SECRET, DATA_KEY, SETUP_TOKEN (openssl rand -hex 32)
chmod 600 .env
docker compose up -d --build            # add --profile https for Caddy (needs DOMAIN in .env)
docker compose exec -u node homevault node src/cli.js help
```

## Troubleshooting

Start with `./deploy.sh doctor` and `./deploy.sh logs`.

- **"Port 8080 is already in use"** — another service has it: `./deploy.sh install --port 8081`.
- **The container exits straight away** — the log says why. Usually `APP_SECRET` is the
  placeholder or too short, or a numeric setting isn't a number.
- **Permission errors on the data folder (NAS)** — the share has to allow the container to
  `chown`, or make `DATA_DIR` writable for uid 1000.
- **Sign-in works but every action says "Forbidden" behind a proxy** — the proxy isn't passing
  the original `Host` header. Fix the proxy, or add the public origin to `TRUSTED_ORIGINS`.
- **Everyone is rate-limited together behind a proxy** — set `TRUST_PROXY=1` so the app sees
  real client addresses.
- **HTTPS certificate isn't issued** — check that the DNS name points here, that ports 80 and
  443 reach this machine, and `docker compose logs caddy`.
- **"That code isn't right" with the correct number** — the phone's clock is off by more than
  about 30 seconds (enable automatic time), or `DATA_KEY` changed since 2FA was set up (the
  log says so). Use a recovery code, or `./deploy.sh admin disable-2fa <email>`.
- **Forgot the administrator password** — `./deploy.sh admin reset-password <email>`.
- **Lost the setup token** — it is `SETUP_TOKEN` in `.env`, or create the first admin with
  `./deploy.sh admin create-admin <email>`.
- **No Update button, only a command** — the updater helper isn't running: `./deploy.sh updater enable`.
- **"Could not check for updates"** — the container cannot reach `api.github.com` (firewall or no internet).
  Everything else still works; update with `./deploy.sh update` from a machine that can.
- **An update says it rolled back** — the new version didn't start; the page shows the reason and
  `./deploy.sh logs` has details. You are still on the previous version with all your data.
- **"This is a 32-bit ARM system"** — install a 64-bit OS (Raspberry Pi OS 64-bit) and run the installer again.
- **Slow on a Raspberry Pi** — use the ready-made image (not a source build), keep the data on a USB SSD
  instead of the SD card, and give it a power supply that doesn't throttle.
- **Starting over** — `./deploy.sh uninstall --purge` removes the containers and all data
  (asks first); `.env` and `backups/` are left alone.
