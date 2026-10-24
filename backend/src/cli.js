#!/usr/bin/env node
// Operations CLI. Run it on the host that has the data folder:
//
//   docker compose exec -u node homevault node src/cli.js <command>
//   (or simply: ./deploy.sh admin <command>)
//
// It talks to the database directly, so it works even when nobody can sign in
// (lost password, lost authenticator, locked-out admin).

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

// If started as root (e.g. `docker exec` without -u), act as the owner of the
// data folder instead. Otherwise SQLite would create root-owned -wal/-shm files
// next to the database and the unprivileged server could no longer write to it.
if (process.getuid?.() === 0) {
  const dir = path.dirname(path.resolve(process.env.DB_PATH || './data/homevault.sqlite'));
  if (fs.existsSync(dir)) {
    const { uid, gid } = fs.statSync(dir);
    if (uid !== 0) {
      process.setgid(gid);
      process.setuid(uid);
    }
  }
}

const { db, backupDatabase, closeDatabase } = await import('./db/index.js');
const { hashPassword } = await import('./utils/crypto.js');
const { passwordProblem } = await import('./utils/passwordPolicy.js');
const { revokeUserSessions } = await import('./utils/sessions.js');
const { generateTempPassword } = await import('./routes/users.js');
const { intEnv } = await import('./config.js');
const { looksLikeEmail, normalizeEmail, userByEmail } = await import('./utils/users.js');

const HELP = `HomeVault admin CLI

Usage: node src/cli.js <command> [options]

  create-admin <email> [--name "Full Name"] [--password <pw>]
        Create an administrator. Without --password a temporary one is generated
        and must be changed at first sign-in.
  reset-password <email> [--password <pw>]
        Set a new temporary password (signs the person out everywhere).
  disable-2fa <email>
        Turn off two-factor authentication for an account (lost authenticator).
  revoke-sessions <email>
        Sign the person out of every device.
  list-users
        Show all accounts.
  backup [directory]
        Write a verified snapshot of the database (default: BACKUP_DIR).
  check
        Database integrity check and record counts.
`;

function parse(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      options[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, options };
}

function requireUser(email) {
  if (!email) fail('An email address is required.');
  const user = userByEmail(email);
  if (!user) fail(`No account with the email ${normalizeEmail(email)}.`);
  return user;
}

function fail(message) {
  console.error(`Error: ${message}`);
  closeDatabase();
  process.exit(1);
}

function audit(action, target) {
  db.prepare('INSERT INTO audit_log (actor, action, target, detail) VALUES (?, ?, ?, ?)').run('cli', action, target, JSON.stringify({ via: 'cli' }));
}

const commands = {
  async 'create-admin'([email], options) {
    const clean = normalizeEmail(email);
    if (!looksLikeEmail(clean)) fail('Give a valid email address.');
    if (userByEmail(clean)) fail('An account with that email already exists.');
    const name = typeof options.name === 'string' ? options.name : clean.split('@')[0];
    const explicit = typeof options.password === 'string';
    const password = explicit ? options.password : generateTempPassword();
    const problem = passwordProblem(password, { email: clean, name });
    if (problem) fail(problem);
    db.prepare('INSERT INTO users (email, password_hash, name, is_admin, must_change_password) VALUES (?, ?, ?, 1, ?)').run(
      clean,
      await hashPassword(password),
      name,
      explicit ? 0 : 1
    );
    audit('user_created', clean);
    console.log(`Administrator created: ${clean}`);
    if (!explicit) console.log(`Temporary password (shown once): ${password}\nThey will be asked to choose a new one at first sign-in.`);
  },

  async 'reset-password'([email], options) {
    const user = requireUser(email);
    const explicit = typeof options.password === 'string';
    const password = explicit ? options.password : generateTempPassword();
    const problem = passwordProblem(password, { email: user.email, name: user.name });
    if (problem) fail(problem);
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(await hashPassword(password), user.id);
    revokeUserSessions(user.id);
    audit('user_password_reset', user.email);
    console.log(`Password reset for ${user.email}. They were signed out everywhere.`);
    if (!explicit) console.log(`Temporary password (shown once): ${password}`);
  },

  'disable-2fa'([email]) {
    const user = requireUser(email);
    db.transaction(() => {
      db.prepare('UPDATE users SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled_at = NULL, totp_last_step = 0 WHERE id = ?').run(user.id);
      db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(user.id);
    })();
    revokeUserSessions(user.id);
    audit('user_mfa_reset', user.email);
    console.log(`Two-factor authentication turned off for ${user.email}.`);
  },

  'revoke-sessions'([email]) {
    const user = requireUser(email);
    const count = revokeUserSessions(user.id);
    audit('sessions_revoked_all', user.email);
    console.log(`Signed ${user.email} out of ${count} session(s).`);
  },

  'list-users'() {
    const rows = db.prepare('SELECT * FROM users ORDER BY id').all();
    for (const u of rows) {
      const flags = [u.is_admin ? 'admin' : null, u.disabled_at ? 'DISABLED' : null, u.totp_enabled_at ? '2fa' : null, u.must_change_password ? 'must-change-password' : null].filter(Boolean);
      console.log(`${String(u.id).padStart(3)}  ${u.email.padEnd(36)} ${u.name.padEnd(24)} ${flags.join(', ')}`);
    }
    if (rows.length === 0) console.log('No accounts yet.');
  },

  async backup([dir]) {
    const dest = await backupDatabase(dir || process.env.BACKUP_DIR || './data/backups', { keep: intEnv('BACKUP_KEEP', 14) });
    console.log(`Backup written and verified: ${dest}`);
  },

  check() {
    const integrity = db.pragma('integrity_check', { simple: true });
    const count = (t) => db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
    console.log(`Integrity: ${integrity}`);
    for (const t of ['users', 'properties', 'documents', 'equipment', 'reminders', 'tasks', 'expenses']) console.log(`${t.padEnd(12)} ${count(t)}`);
    if (integrity !== 'ok') process.exitCode = 1;
  },
};

const [command, ...rest] = process.argv.slice(2);
if (!command || command === 'help' || command === '--help' || !(command in commands)) {
  console.log(HELP);
  if (command && command !== 'help' && command !== '--help') process.exitCode = 1;
} else {
  const { positional, options } = parse(rest);
  try {
    await commands[command](positional, options);
  } catch (err) {
    fail(err.message);
  }
}
closeDatabase();
