# Changelog

All notable changes to HomeVault. Versions follow [semantic versioning](https://semver.org/).

## [1.0.0] - 2026-10-24

The first stable release: much stronger security, faster, new features, and a one-command install that runs on Intel/AMD and Raspberry Pi.

### Install and update
- **Install wizard**: one command asks a few questions (how you reach it, where data lives, language, email, backups, your admin account) and sets everything up.
- **Runs on amd64 and arm64**, including Raspberry Pi 3/4/5 with a 64-bit OS. Ready-made images are published for both.
- **Update from inside the app**: when a new version is out, administrators see a notice and an *Update* button in Settings. A backup is made first and HomeVault rolls back by itself if the new version doesn't start.
- `./deploy.sh` for install, update, backup, restore, status, doctor and more; optional automatic HTTPS (Let's Encrypt) with your own domain.

### Security
- Two-factor authentication (authenticator app) with recovery codes.
- Sign-in sessions you can see and end per device; sessions end when the password or 2FA changes.
- Stronger password storage (scrypt), a password policy that rejects common and personal passwords, and per-account and per-address brute-force protection.
- Protection against cross-site request forgery, a strict content security policy, and an audit log of sign-ins and security changes.
- The first administrator needs a one-time setup token; accounts created by an admin must change their temporary password.
- The container runs unprivileged with a read-only filesystem and no extra capabilities.

### Features
- Find anything: Ctrl/Cmd+K searches documents, equipment, reminders, tasks and expenses.
- Home inventory: purchase prices, total value and a CSV export for insurance.
- One-click maintenance schedules for equipment, linked to calendar reminders.
- Calendar subscriptions (.ics) for Apple, Google and Outlook calendars, individually revocable.
- Household account management and a personal "recent security activity" feed.

### Performance
- Compressed responses, long-lived caching of web files, a faster database configuration with nightly maintenance, and web pages loaded on demand.

### Under the hood
- Updated to Express 5, React 19 and current versions of all other dependencies (no known vulnerabilities in the shipped packages).

### Upgrading from 0.x
- Everyone is signed out once because sign-in now uses secure cookies. Scripts that sent an `Authorization` header or a `?token=` must sign in with a cookie.
- `JWT_SECRET` is now `APP_SECRET` (the old name still works). `DATA_KEY` (encrypts 2FA secrets) and `SETUP_TOKEN` are new; `./deploy.sh` generates them.
