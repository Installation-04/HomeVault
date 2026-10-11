import 'dotenv/config';
import cron from 'node-cron';

import { assertConfig } from './config.js';

try {
  assertConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

// Imported after the config check so a bad configuration fails with a clear
// message before the database or upload folders are touched.
const { db, backupDatabase } = await import('./db/index.js');
const { createApp } = await import('./app.js');
const { runReminderCheck } = await import('./utils/reminderEngine.js');

const app = createApp();

const reminderCron = process.env.REMINDER_CHECK_CRON || '0 8 * * *';
const reminderTask = cron.schedule(reminderCron, () => {
  runReminderCheck()
    .then((r) => r.items && console.log(`Reminder check: ${r.items} item(s), ${r.emailsSent} email(s) sent`))
    .catch((err) => console.error('Reminder check failed:', err));
});

const backupCron = process.env.BACKUP_CRON || '0 3 * * *';
const backupDir = process.env.BACKUP_DIR || './data/backups';
const backupTask = cron.schedule(backupCron, () => {
  try {
    const dest = backupDatabase(backupDir);
    console.log('Backup written to', dest);
  } catch (err) {
    console.error('Backup failed:', err);
  }
});

const port = process.env.PORT || 4000;
const server = app.listen(port, () => console.log(`HomeVault backend listening on port ${port}`));

// `docker stop` sends SIGTERM; as PID 1 node would otherwise ignore it and get
// SIGKILLed after 10s, skipping the SQLite WAL checkpoint on close.
function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  reminderTask.stop();
  backupTask.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  server.closeIdleConnections?.();
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
