# HomeVault

A self-hosted web app for managing home ownership documents and maintenance —
property vaults, expiring-document/warranty reminders, a maintenance
calendar, and home-office expense tracking. Built to run in a single Docker
container on a NAS or homelab, with all data kept local.

## Stack

- **Backend**: Node.js + Express, REST API, SQLite via `better-sqlite3` (zero
  external DB service to run). Postgres is not wired up yet — SQLite keeps a
  single-container NAS deploy trivial and is plenty for a household's data
  volume; if you outgrow it, the `db/` layer is the place to swap it in.
- **Frontend**: React + Vite, Tailwind CSS, mobile-first, installable as a
  PWA (`vite-plugin-pwa`).
- **Auth**: local email/password with JWT, multi-user households via
  per-property `owner`/`viewer` roles.
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
│   │   ├── routes/         # auth, properties, documents, reminders,
│   │   │                   #   tasks, expenses, calendar, export, dashboard
│   │   ├── utils/           # recurrence math, mailer, reminder engine
│   │   └── server.js        # express app, cron jobs, serves built frontend
│   └── uploads/              # (dev) local file storage
├── frontend/
│   └── src/
│       ├── api/              # fetch client
│       ├── auth/             # AuthContext (login/setup/logout)
│       ├── property/         # PropertyContext (multi-property switcher)
│       ├── components/       # Layout, PropertySwitcher
│       ├── pages/            # Login, Dashboard, Documents, Calendar, Expenses
│       └── i18n/              # en.json / fr.json
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
| `documents`         | file + category (invoice/warranty/insurance/contract/photo/maintenance/tax/other), dates, tags |
| `reminders`         | due date, `recurrence` (none/monthly/yearly/custom), lead time, optional link to a document |
| `tasks`             | calendar events per property, optionally linked to a document, with recurrence |
| `expenses`          | amount, category, `is_home_office` flag, optional receipt document link |

Full column definitions are in `backend/src/db/schema.sql`. The schema is
applied automatically on backend startup (`CREATE TABLE IF NOT EXISTS`), so
there's no separate migration step for this first version.

## Key features implemented

1. Property CRUD + dashboard listing all properties with upcoming reminders
   and expiring documents (next 30 days)
2. Document upload per property with category, tags, expiry date, search
3. Reminder engine: due-date + recurring reminders, in-app on the dashboard
   and optional email via SMTP (cron-scheduled check, `REMINDER_CHECK_CRON`)
4. Calendar view merging tasks + reminders per property
5. Home-office expense tracking with CSV export (`/expenses/property/:id/export.csv`)
6. Search/filter across documents (title, notes, tags, category)
7. Multi-property support with a property switcher in the header
8. "Export everything" — zip bundle of all documents + a summary text file
   per property (`/export/property/:id/bundle.zip`), useful for an
   estate-transfer style archive

Not yet built: barcode/receipt photo capture, push notifications (email is
wired up; browser push is a natural follow-up once the PWA service worker is
in place), Postgres backend.

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
empty, so it can't be used to re-seed a running instance.

## Running in Docker (NAS / homelab)

```bash
cp .env.example .env    # edit JWT_SECRET, HOST_PORT, SMTP if desired
docker compose up -d --build
```

The container listens on `4000` internally, published on `HOST_PORT`
(default `8080`). Mount `./data` onto your NAS volume for the SQLite
database, uploaded files, and scheduled backups — see `docker-compose.yml`.

Behind Traefik/Nginx: point your reverse proxy at the `homevault` service on
its published port; no path rewriting is needed since the API and frontend
share one origin.

### Backups

`BACKUP_CRON` (default: daily at 3am) writes a timestamped SQLite snapshot
to `BACKUP_DIR`. Point that at your NAS's own backup/snapshot tooling for a
second layer of protection.

## Roadmap / next phases

- Receipt photo capture + barcode scan on mobile (camera input already works
  via the existing file upload — a dedicated capture UI is the remaining
  piece)
- Push notifications via the PWA service worker, as an alternative to SMTP
- Optional Postgres backend behind the same `db/` interface
- Estate-transfer bundle: add a generated summary PDF alongside the current
  `summary.txt` in the export zip
