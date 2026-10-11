# HomeVault

A self-hosted web app for managing home ownership documents, equipment, and
maintenance — property vaults, expiring-document/warranty reminders, a
month/list maintenance calendar, home-office expense tracking, QR-labeled
equipment with a maintenance history, and shared access for the whole
household. Built to run in a single Docker container on a
NAS or homelab, with all data kept local. Installable as a PWA on iOS and
Android.

**[Releases](https://github.com/Installation-04/HomeVault/releases)** — tagged
versions with notes on what changed.

## Screenshots

| Dashboard | Documents |
| --- | --- |
| ![Dashboard](docs/screenshots/dashboard.png) | ![Documents](docs/screenshots/documents.png) |

| Equipment | Equipment detail |
| --- | --- |
| ![Equipment list](docs/screenshots/equipment-list.png) | ![Equipment detail](docs/screenshots/equipment-detail.png) |

| Calendar | Expenses |
| --- | --- |
| ![Calendar](docs/screenshots/calendar.png) | ![Expenses](docs/screenshots/expenses.png) |

| QR code (printable label) | Settings (sharing & accounts) |
| --- | --- |
| ![QR code modal](docs/screenshots/qr-code.png) | ![Settings](docs/screenshots/settings.png) |

| Mobile (bottom nav) |
| --- |
| <img src="docs/screenshots/mobile-dashboard.png" width="280" alt="Mobile dashboard"> |

## Stack

- **Backend**: Node.js + Express, REST API, SQLite via `better-sqlite3` (zero
  external DB service to run). Postgres is not wired up yet — SQLite keeps a
  single-container NAS deploy trivial and is plenty for a household's data
  volume; if you outgrow it, the `db/` layer is the place to swap it in.
- **Frontend**: React + Vite, Tailwind CSS, mobile-first, installable as a
  PWA (`vite-plugin-pwa`) on iOS and Android.
- **QR codes**: generated entirely client-side (`qrcode.react`) — no
  third-party API call, consistent with "no telemetry, data stays local."
- **Auth**: local email/password with JWT, multi-user households via
  per-property `owner`/`viewer` roles (see [Roles](#roles)). Roles are
  re-checked against the database on every request, so removing someone takes
  effect immediately. Failed logins are rate limited and responses carry
  security headers (CSP, `nosniff`, no referrer).
- **File storage**: local volume (`UPLOAD_DIR`), path configurable to a NAS
  mount.
- **i18n**: `react-i18next` with English and French UI strings from day one.

## Folder structure

```
HomeVault/
├── backend/
│   ├── src/
│   │   ├── db/            # schema.sql + sqlite connection/backup helpers
│   │   ├── middleware/     # JWT auth, per-property access control
│   │   ├── routes/         # auth, properties, documents, equipment,
│   │   │                   #   reminders, tasks, expenses, calendar,
│   │   │                   #   export, dashboard
│   │   ├── utils/           # recurrence math, mailer, reminder engine,
│   │   │                   #   safe upload handling
│   │   ├── app.js           # createApp(): express app (used by tests too)
│   │   ├── config.js        # startup configuration checks
│   │   └── server.js        # entrypoint: cron jobs, listen, graceful shutdown
│   └── test/                 # node:test suite (npm test)
├── frontend/
│   └── src/
│       ├── api/              # fetch client
│       ├── auth/             # AuthContext (login/setup/logout)
│       ├── property/         # PropertyContext (multi-property switcher)
│       ├── components/       # Layout (top nav + mobile tab bar),
│       │                     #   PropertySwitcher, InstallPrompt, QrModal,
│       │                     #   Modal, ConfirmDialog, ExpiryBadge, ...
│       ├── hooks/            # useAsync (loading/error state), useDebounced
│       ├── pages/            # Login, Dashboard, Documents, DocumentDetail,
│       │                     #   Equipment, EquipmentDetail, Calendar,
│       │                     #   Expenses, Settings
│       ├── utils/            # date, recurrence and money formatting
│       └── i18n/              # en.json / fr.json (checked by npm run check:i18n)
├── docs/screenshots/           # README images
├── docker/entrypoint.sh        # fixes data-volume ownership, drops root
├── Dockerfile                 # multi-stage: builds frontend, runs backend
└── docker-compose.yml
```

The backend serves the built frontend as static files in production, so the
whole app ships as **one container** — no reverse-proxy path juggling beyond
what you already do for other services.

## Data model

| Table              | Purpose                                                                 |
| ------------------- | ------------------------------------------------------------------------ |
| `users`             | login + `is_admin` flag + preferred `locale`                            |
| `properties`        | name, address, type, purchase_date, notes                              |
| `property_access`   | many-to-many users↔properties with `role` (`owner`/`viewer`)            |
| `documents`         | file + category (invoice/warranty/insurance/contract/photo/maintenance/tax/other), dates, tags, optional link to an `equipment` item |
| `equipment`         | physical appliances/tools: brand, model number, serial number, category, location, purchase/warranty dates, notes |
| `equipment_photos`  | photo gallery per equipment item (file upload or camera capture)        |
| `maintenance_logs`  | per-equipment history: date, description, cost, who did it, optional receipt document |
| `reminders`         | due date, `recurrence` (none/monthly/yearly/custom), lead time, optional link to a document; remembers which due date it last emailed about |
| `tasks`             | calendar events per property, optionally linked to a document, with recurrence |
| `expenses`          | amount, category, `is_home_office` flag, optional receipt document link |

Full column definitions are in `backend/src/db/schema.sql`. The schema is
applied automatically on backend startup (`CREATE TABLE IF NOT EXISTS`, plus
a small `ensureColumn` migration in `db/index.js` for columns added after a
database already existed), so there's no separate migration step to run.

## Key features implemented

1. Property CRUD (edit/delete in **Settings**) and a dashboard per property
   showing overdue items, upcoming reminders, expiring documents, ending
   equipment warranties, item counts and year-to-date spend
2. Document upload per property with category, tags, expiry date, optional
   link to an equipment item, search (debounced, wildcard-safe), category and
   "expiring soon" filters, an edit screen, and a shareable detail page at
   `/documents/:id`
3. **Equipment / inventory tracking**: brand, model, serial number, location,
   warranty badge, a photo gallery (images only), linked documents, and a
   maintenance log (date, description, cost, who did it) per item. "Find
   manual & pictures online" shows ready-to-click Google/Images/manufacturer
   search links for the entered brand + model — no automatic external calls,
   you pick the right result yourself.
4. **QR codes** for documents and equipment: scan to open the item directly,
   or print one sized for a thermal/label printer (25×25mm, 51×25mm "2×1in",
   102×152mm "4×6in", or a custom size) with the item's ID, name, and key
   details on the label. A QR on the login page also lets you scan to open
   the app on your phone and install it.
5. **Calendar** with a list view (overdue / next 30 days / later / completed)
   and a month grid that projects recurring items into future months. Create,
   edit, complete, reopen and delete reminders and tasks; monthly, yearly or
   custom-interval repeats; completing an overdue recurring item jumps to the
   next *future* date, and month-end dates are clamped (Jan 31 → Feb 28).
6. **Email notices** (optional SMTP, cron-scheduled via `REMINDER_CHECK_CRON`):
   one digest per person and property covering reminders inside their lead
   window or overdue, documents about to expire and equipment warranties about
   to end. Each item is announced **once per due/expiry date**, in the
   recipient's language (EN/FR), and is retried if the mail server is down.
7. Home-office expense tracking: edit, filter by year/category/home-office,
   per-currency totals with a category breakdown, optional receipt link, and
   a CSV export (UTF-8 for Excel, protected against spreadsheet formula
   injection) at `/expenses/property/:id/export.csv`
8. Multi-property support with a property switcher in the header
9. **Sharing**: owners invite family members to a property as owner or viewer
   and revoke access; admins create household logins; everyone can change
   their own password and language (Settings)
10. "Export everything" — zip bundle of all documents plus a summary text file
    (property, documents, equipment, maintenance history, reminders, tasks,
    expenses) per property (`/export/property/:id/bundle.zip`), useful for an
    estate-transfer style archive
11. **Mobile / PWA**: installable on iOS and Android (proper meta tags,
    maskable icons, safe-area padding for notches), a bottom tab bar on
    phone-width screens, an install banner, and camera capture for document
    and equipment photos

### Roles

| | Admin | Owner (of a property) | Viewer |
| --- | :-: | :-: | :-: |
| See the property and everything in it | all properties | ✓ | ✓ |
| Tick off / reopen reminders and tasks, log maintenance | ✓ | ✓ | ✓ |
| Add / edit / delete documents, equipment, reminders, tasks, expenses | ✓ | ✓ | – |
| Edit or delete the property, share it, revoke access | ✓ | ✓ | – |
| Create household accounts | ✓ | – | – |

A property always keeps at least one owner.

Not yet built: push notifications (email is wired up; browser push is a
natural follow-up now that the PWA service worker is in place), a Postgres
backend, raw ESC/POS or ZPL thermal printing (label printing instead relies
on your label printer's normal OS driver, which covers common ones like
Dymo/Brother QL/Rollo).

## Running locally (development)

```bash
# Backend
cd backend
cp .env.example .env   # edit JWT_SECRET at minimum
npm install
npm run dev             # http://localhost:4000

# Frontend (separate terminal)
cd frontend
npm install
npm run dev             # http://localhost:5173, proxies /api to :4000
```

On first visit, use "Create your HomeVault admin account" on the login page
(`POST /api/auth/setup`) — it's only allowed while the `users` table is
empty, so it can't be used to re-seed a running instance. Passwords must be at
least 8 characters.

### Tests and checks

```bash
cd backend  && npm test            # node:test suite against the real app + a temp SQLite DB
cd frontend && npm run check:i18n  # EN/FR files in sync, no missing translation keys
cd frontend && npm run build
```

CI (`.github/workflows/ci.yml`) runs all of these plus a Docker smoke test on
every pull request.

## Running in Docker (NAS / homelab)

```bash
cp .env.example .env    # set JWT_SECRET (openssl rand -hex 32), HOST_PORT, SMTP if desired
docker compose up -d --build
```

`JWT_SECRET` is **required**: in production the app refuses to start if it is
missing, still the placeholder from `.env.example`, or shorter than 16
characters (anyone who knows the placeholder could otherwise forge an admin
login).

The container listens on `4000` internally, published on `HOST_PORT`
(default `8080`). Mount `./data` onto your NAS volume for the SQLite
database, uploaded files, and scheduled backups — see `docker-compose.yml`.

Behind Traefik/Nginx: point your reverse proxy at the `homevault` service on
its published port; no path rewriting is needed since the API and frontend
share one origin. Set `TRUST_PROXY=1` (the number of proxies in front of the
app) so the failed-login limiter sees real client addresses, and terminate
TLS at the proxy — the app deliberately sends no HSTS header so plain-HTTP LAN
installs keep working.

The container starts as root only to make the mounted `./data` folder writable,
then runs the app as the unprivileged `node` user. If your NAS mount refuses
`chown`, it logs a warning and keeps running as root, as earlier versions did.

### Upgrading from an earlier version

- Set a real `JWT_SECRET` (see above) or the container will exit on start.
- Existing reminders that are already inside their lead window will trigger
  **one** email after the upgrade; from then on each due date is announced
  once instead of every day.
- Document-expiry and warranty email notices are new (`EXPIRY_NOTICE_DAYS`,
  default 30, `0` turns them off).
- Reminders created from the UI before this release were saved with email
  notifications off by mistake; edit a reminder to turn them on.

### Backups

`BACKUP_CRON` (default: daily at 3am) writes a timestamped SQLite snapshot
to `BACKUP_DIR`. Point that at your NAS's own backup/snapshot tooling for a
second layer of protection.

## Roadmap / next phases

- Push notifications via the PWA service worker, as an alternative to SMTP
- Optional Postgres backend behind the same `db/` interface
- Short-lived signed URLs for downloads/photos (today a session token is
  accepted as `?token=` on those few file endpoints only)
- Pagination for very large document libraries
- Tailwind 4 migration (clears the remaining build-time-only `npm audit` notes)
- Estate-transfer bundle: add a generated summary PDF alongside the current
  `summary.txt` in the export zip
- Barcode *scanning* (as opposed to the QR codes HomeVault already
  generates) to look up a product by its manufacturer barcode
