-- HomeVault SQLite schema

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  locale TEXT NOT NULL DEFAULT 'en',
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

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  category TEXT NOT NULL, -- invoice, warranty, insurance, contract, photo, maintenance, tax, other
  file_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT,
  file_size INTEGER,
  document_date TEXT,
  expiry_date TEXT,
  notes TEXT,
  tags TEXT, -- comma-separated
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'maintenance', -- insurance_renewal, maintenance, payment, other
  due_date TEXT NOT NULL,
  recurrence TEXT NOT NULL DEFAULT 'none', -- none, monthly, yearly, custom
  recurrence_interval_days INTEGER, -- used when recurrence = custom
  lead_time_days INTEGER NOT NULL DEFAULT 7,
  notify_email INTEGER NOT NULL DEFAULT 1,
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

CREATE INDEX IF NOT EXISTS idx_documents_property ON documents(property_id);
CREATE INDEX IF NOT EXISTS idx_documents_expiry ON documents(expiry_date);
CREATE INDEX IF NOT EXISTS idx_reminders_property ON reminders(property_id);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_property ON tasks(property_id);
CREATE INDEX IF NOT EXISTS idx_tasks_date ON tasks(event_date);
CREATE INDEX IF NOT EXISTS idx_expenses_property ON expenses(property_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);
