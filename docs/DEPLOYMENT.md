# Deploying HomeVault

HomeVault runs as one container (plus an optional Caddy container for HTTPS). The
`deploy.sh` script in the repository root does the setup and the day-to-day chores,
so you rarely need to touch Docker directly.

**You need:** Linux, macOS or a NAS with Docker and the Compose plugin
(`docker compose version`), `bash`, `git`. About 1 GB free disk for the image build and
512 MB of RAM for the app (the container is limited to 768 MB by default).

## Install

```bash
git clone https://github.com/Installation-04/HomeVault.git
cd HomeVault
./deploy.sh install
```

What it does, in order:

1. Checks Docker, Compose, free disk space and that the port is free.
2. Creates `.env` from `.env.example` (mode 600) with freshly generated
   `APP_SECRET`, `DATA_KEY` and `SETUP_TOKEN`. Existing values are never overwritten, so
   it is safe to run again.
3. Builds the image (or pulls it, with `--image`) and starts the container.
4. Waits until the health check passes and prints the address and the setup token.

Open the address, create the administrator account (you will be asked for the setup
token), then go to *Settings → Security* and turn on two-factor authentication.

> **Back up `.env` right now** — in a password manager, not next to your database
> backups. `DATA_KEY` is what makes the two-factor secrets in a restored backup
> readable; without it people just need to re-enrol (or sign in with a recovery code).

### Options

| Option | Meaning |
| --- | --- |
| `--domain home.example.com` | Serve HTTPS with an automatic Let's Encrypt certificate (see below) |
| `--port 8080` | Host port for plain HTTP |
| `--bind 127.0.0.1` | Listen address; the default is all interfaces (`127.0.0.1` with `--domain`) |
| `--data-dir /volume1/homevault` | Where the database and uploads live; use your NAS volume |
| `--image ghcr.io/installation-04/homevault:latest` | Use a prebuilt image instead of building |
| `--no-start` | Write the configuration only |
| `-y`, `--yes` | Never ask questions (for automation) |

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
| `./deploy.sh update` | Back up, fetch the new version, rebuild, restart, verify |
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

## Updating

```bash
./deploy.sh update
```

It takes a backup (`backups/homevault-backup-pre-update-*.tar.gz`), runs `git pull` (skipped
if you have local changes, or with `--no-git`), rebuilds, restarts and waits for the health
check. **If the new version doesn't become healthy, it automatically restarts the previous
image** and tells you; your data isn't changed by an update that failed to start. The
previous image stays available as `homevault-rollback:latest` until the next update.

With a prebuilt image (`--image ...`) `update` pulls the image instead of building.

Release notes are on the [Releases page](https://github.com/Installation-04/HomeVault/releases).

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
| `HOMEVAULT_IMAGE` | `homevault:latest` | Image to run (set by `--image`) |
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
    └── backups/            nightly database snapshots
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
- **Starting over** — `./deploy.sh uninstall --purge` removes the containers and all data
  (asks first); `.env` and `backups/` are left alone.
