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

CREATE INDEX IF NOT EXISTS idx_documents_property ON documents(property_id);
CREATE INDEX IF NOT EXISTS idx_documents_expiry ON documents(expiry_date);
CREATE INDEX IF NOT EXISTS idx_documents_equipment ON documents(equipment_id);
CREATE INDEX IF NOT EXISTS idx_equipment_property ON equipment(property_id);
CREATE INDEX IF NOT EXISTS idx_equipment_photos_equipment ON equipment_photos(equipment_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_logs_equipment ON maintenance_logs(equipment_id);
CREATE INDEX IF NOT EXISTS idx_reminders_property ON reminders(property_id);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_property ON tasks(property_id);
CREATE INDEX IF NOT EXISTS idx_tasks_date ON tasks(event_date);
CREATE INDEX IF NOT EXISTS idx_expenses_property ON expenses(property_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);
