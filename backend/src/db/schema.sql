-- HomeVault SQLite schema

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  locale TEXT NOT NULL DEFAULT 'en',
  must_change_password INTEGER NOT NULL DEFAULT 0, -- forced change after an admin reset
  disabled_at TEXT, -- set = cannot log in; kept (not deleted) so history stays attributable
  totp_secret_enc TEXT, -- AES-256-GCM encrypted base32 secret (confirmed)
  totp_pending_enc TEXT, -- secret awaiting its first valid code
  totp_enabled_at TEXT,
  totp_last_step INTEGER NOT NULL DEFAULT 0, -- last accepted time step (blocks replay)
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS properties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  address TEXT,
  type TEXT, -- house, condo, rental, cottage, etc.
  purchase_date TEXT,
  notes TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-property access for multi-user households.
CREATE TABLE IF NOT EXISTS property_access (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'viewer', -- owner | viewer
  UNIQUE(property_id, user_id)
);

-- Physical equipment/appliances tracked for inventory, warranty, and
-- maintenance history purposes (e.g. furnace, fridge, water heater).
CREATE TABLE IF NOT EXISTS equipment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other', -- appliance, hvac, plumbing, electrical, tool, electronics, vehicle, other
  brand TEXT,
  model_number TEXT,
  serial_number TEXT,
  location TEXT, -- e.g. "kitchen", "basement"
  purchase_date TEXT,
  warranty_expiry TEXT,
  purchase_price REAL, -- for the insurance inventory
  purchase_currency TEXT NOT NULL DEFAULT 'CAD',
  warranty_notified_for TEXT, -- warranty_expiry value an email notice was last sent for
  notes TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  equipment_id INTEGER REFERENCES equipment(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL, -- invoice, warranty, insurance, contract, photo, maintenance, tax, other
  file_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT,
  file_size INTEGER,
  document_date TEXT,
  expiry_date TEXT,
  expiry_notified_for TEXT, -- expiry_date value an email notice was last sent for
  notes TEXT,
  tags TEXT, -- comma-separated
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS equipment_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT,
  file_size INTEGER,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS maintenance_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  log_date TEXT NOT NULL,
  description TEXT NOT NULL,
  cost REAL,
  performed_by TEXT, -- e.g. "self" or a contractor's name
  document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL, -- optional receipt/invoice
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  equipment_id INTEGER REFERENCES equipment(id) ON DELETE SET NULL, -- maintenance for a specific item
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'maintenance', -- insurance_renewal, maintenance, payment, other
  due_date TEXT NOT NULL,
  recurrence TEXT NOT NULL DEFAULT 'none', -- none, monthly, yearly, custom
  recurrence_interval_days INTEGER, -- used when recurrence = custom
  lead_time_days INTEGER NOT NULL DEFAULT 7,
  notify_email INTEGER NOT NULL DEFAULT 1,
  notified_for_due_date TEXT, -- due_date value an email was last sent for (send once per due date)
  completed_at TEXT,
  notes TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  event_date TEXT NOT NULL,
  recurrence TEXT NOT NULL DEFAULT 'none', -- none, monthly, yearly, custom
  recurrence_interval_days INTEGER,
  notes TEXT,
  completed_at TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  category TEXT NOT NULL, -- maintenance, insurance, tax, utility, improvement, other
  is_home_office INTEGER NOT NULL DEFAULT 0,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CAD',
  expense_date TEXT NOT NULL,
  description TEXT,
  receipt_document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Server-side login sessions. The browser holds only a random token; we store
-- its SHA-256, so a leaked database cannot be replayed as logins.
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  user_agent TEXT,
  ip TEXT,
  used_mfa INTEGER NOT NULL DEFAULT 0
);

-- One-time 2FA recovery codes (stored hashed, burned on use).
CREATE TABLE IF NOT EXISTS recovery_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TEXT
);

-- Security-relevant events: who did what, when, from where.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor TEXT, -- email at the time (kept even if the user is later removed)
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  ip TEXT,
  user_agent TEXT
);

-- Subscribable calendar (ICS) feeds. The URL contains a secret token; only its
-- hash is stored, and each feed can be revoked independently.
CREATE TABLE IF NOT EXISTS calendar_feeds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  property_id INTEGER REFERENCES properties(id) ON DELETE CASCADE, -- NULL = every property the user can see
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);
