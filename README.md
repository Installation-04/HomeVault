# HomeVault

A self-hosted web app for managing home ownership documents, equipment, and
maintenance — property vaults, expiring-document/warranty reminders, a
maintenance calendar, home-office expense tracking, and QR-labeled equipment
with a maintenance history. Built to run in a single Docker container on a
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

| QR code (printable label) | Mobile (bottom nav) |
| --- | --- |
| ![QR code modal](docs/screenshots/qr-code.png) | <img src="docs/screenshots/mobile-dashboard.png" width="280" alt="Mobile dashboard"> |

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
│   │   ├── routes/         # auth, properties, documents, equipment,
│   │   │                   #   reminders, tasks, expenses, calendar,
│   │   │                   #   export, dashboard
│   │   ├── utils/           # recurrence math, mailer, reminder engine
│   │   └── server.js        # express app, cron jobs, serves built frontend
│   └── uploads/              # (dev) local file storage
├── frontend/
│   └── src/
│       ├── api/              # fetch client
│       ├── auth/             # AuthContext (login/setup/logout)
│       ├── property/         # PropertyContext (multi-property switcher)
│       ├── components/       # Layout (top nav + mobile tab bar),
│       │                     #   PropertySwitcher, InstallPrompt, QrModal
│       ├── pages/            # Login, Dashboard, Documents, DocumentDetail,
│       │                     #   Equipment, EquipmentDetail, Calendar,
│       │                     #   Expenses
│       └── i18n/              # en.json / fr.json
├── docs/screenshots/           # README images
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
| `reminders`         | due date, `recurrence` (none/monthly/yearly/custom), lead time, optional link to a document |
| `tasks`             | calendar events per property, optionally linked to a document, with recurrence |
| `expenses`          | amount, category, `is_home_office` flag, optional receipt document link |

Full column definitions are in `backend/src/db/schema.sql`. The schema is
applied automatically on backend startup (`CREATE TABLE IF NOT EXISTS`, plus
a small `ensureColumn` migration in `db/index.js` for columns added after a
database already existed), so there's no separate migration step to run.

## Key features implemented

1. Property CRUD + dashboard listing all properties with upcoming reminders
   and expiring documents (next 30 days)
2. Document upload per property with category, tags, expiry date, search,
   and a shareable detail page at `/documents/:id`
3. **Equipment / inventory tracking**: brand, model, serial number, location,
   a photo gallery, and a maintenance log (date, description, cost, who did
   it) per item. "Find manual & pictures online" shows ready-to-click
   Google/Images/manufacturer-site search links for the entered brand +
   model — no automatic external calls, you pick the right result yourself.
4. **QR codes** for documents and equipment: scan to open the item directly,
   or print one sized for a thermal/label printer (25×25mm, 51×25mm "2×1in",
   102×152mm "4×6in", or a custom size) with the item's ID, name, and key
   details on the label. A QR on the login page also lets you scan to open
   the app on your phone and install it.
5. Reminder engine: due-date + recurring reminders, in-app on the dashboard
   and optional email via SMTP (cron-scheduled check, `REMINDER_CHECK_CRON`)
6. Calendar view merging tasks + reminders per property
7. Home-office expense tracking with CSV export (`/expenses/property/:id/export.csv`)
8. Search/filter across documents (title, notes, tags, category)
9. Multi-property support with a property switcher in the header
10. "Export everything" — zip bundle of all documents + a summary text file
    per property (`/export/property/:id/bundle.zip`), useful for an
    estate-transfer style archive
11. **Mobile / PWA**: installable on iOS and Android (proper meta tags,
    maskable icons, safe-area padding for notches), a bottom tab bar on
    phone-width screens, an install banner, and camera capture for document
    and equipment photos

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

- Push notifications via the PWA service worker, as an alternative to SMTP
- Optional Postgres backend behind the same `db/` interface
- Estate-transfer bundle: add a generated summary PDF alongside the current
  `summary.txt` in the export zip
- Barcode *scanning* (as opposed to the QR codes HomeVault already
  generates) to look up a product by its manufacturer barcode
