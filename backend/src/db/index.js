import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const dbPath = process.env.DB_PATH || './data/homevault.sqlite';
fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });

export const db = new Database(dbPath);

// WAL + synchronous=NORMAL is the standard fast-and-safe pairing: commits are
// durable across an application crash, and only an OS crash / power loss can
// lose the last few transactions (never corrupt the file).
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('temp_store = MEMORY');
db.pragma('cache_size = -20000'); // 20 MB page cache
db.pragma('journal_size_limit = 67108864'); // keep the WAL file from growing unbounded

// The database file holds password hashes and encrypted 2FA secrets: make it
// readable by the app user only (no-op on filesystems without POSIX modes).
for (const suffix of ['', '-wal', '-shm']) {
  try {
    fs.chmodSync(dbPath + suffix, 0o600);
  } catch {
    /* file may not exist yet, or the mount ignores modes */
  }
}

db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

// `CREATE TABLE IF NOT EXISTS` won't add new columns to a table that
// already existed before this column was introduced, so patch those in.
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn('documents', 'equipment_id', 'INTEGER REFERENCES equipment(id) ON DELETE SET NULL');
ensureColumn('reminders', 'notified_for_due_date', 'TEXT');
ensureColumn('documents', 'expiry_notified_for', 'TEXT');
ensureColumn('equipment', 'warranty_notified_for', 'TEXT');
ensureColumn('equipment', 'purchase_price', 'REAL');
ensureColumn('equipment', 'purchase_currency', "TEXT NOT NULL DEFAULT 'CAD'");
ensureColumn('reminders', 'equipment_id', 'INTEGER REFERENCES equipment(id) ON DELETE SET NULL');
ensureColumn('users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'disabled_at', 'TEXT');
ensureColumn('users', 'totp_secret_enc', 'TEXT');
ensureColumn('users', 'totp_pending_enc', 'TEXT');
ensureColumn('users', 'totp_enabled_at', 'TEXT');
ensureColumn('users', 'totp_last_step', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'last_login_at', 'TEXT');

// Indexes last: they may reference columns added just above.
db.exec(fs.readFileSync(path.join(__dirname, 'indexes.sql'), 'utf8'));

// Housekeeping that keeps the file small and the query planner informed.
// Safe to call any time; the server runs it nightly and on shutdown.
export function maintainDatabase({ auditRetentionDays = 400 } = {}) {
  const expiredSessions = db
    .prepare("DELETE FROM sessions WHERE expires_at < datetime('now', '-7 days') OR revoked_at < datetime('now', '-7 days')")
    .run().changes;
  const oldAudit = db.prepare("DELETE FROM audit_log WHERE at < datetime('now', ?)").run(`-${auditRetentionDays} days`).changes;
  db.pragma('wal_checkpoint(PASSIVE)');
  db.pragma('optimize');
  return { expiredSessions, oldAudit };
}

// Writes a consistent snapshot using SQLite's online backup API (safe while the
// app is serving requests), checks that the copy is readable, and prunes old
// snapshots so the backup folder can't quietly fill the disk.
export async function backupDatabase(destDir, { keep = 14 } = {}) {
  fs.mkdirSync(destDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(destDir, `homevault-${stamp}.sqlite`);
  await db.backup(dest);

  // The copy inherits WAL mode from the live database, which would leave -wal and
  // -shm files beside it. Switch it to a plain rollback journal so the backup is
  // one self-contained file you can copy, mail to yourself or restore as-is.
  const copy = new Database(dest);
  try {
    copy.pragma('journal_mode = DELETE');
    const result = copy.pragma('quick_check', { simple: true });
    if (result !== 'ok') throw new Error(`Backup failed its integrity check: ${result}`);
  } catch (err) {
    copy.close();
    fs.rmSync(dest, { force: true });
    throw err;
  }
  copy.close();
  fs.chmodSync(dest, 0o600);

  const snapshots = fs
    .readdirSync(destDir)
    .filter((f) => /^homevault-.*\.sqlite$/.test(f))
    .sort();
  for (const old of snapshots.slice(0, Math.max(0, snapshots.length - keep))) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(path.join(destDir, old + suffix), { force: true });
  }
  return dest;
}

export function closeDatabase() {
  try {
    db.pragma('optimize');
    db.close();
  } catch {
    /* already closed */
  }
}
