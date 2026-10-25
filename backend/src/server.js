import 'dotenv/config';
import cron from 'node-cron';

import { assertConfig, intEnv } from './config.js';

try {
  assertConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

// Imported after the config check so a bad configuration fails with a clear
// message before the database or upload folders are touched.
const { backupDatabase, closeDatabase, maintainDatabase } = await import('./db/index.js');
const { createApp } = await import('./app.js');
const { runReminderCheck } = await import('./utils/reminderEngine.js');
const { ensureUpdateDir } = await import('./utils/updates.js');
const { runDueIntegrations } = await import('./integrations/service.js');

ensureUpdateDir();
const app = createApp();

const reminderCron = process.env.REMINDER_CHECK_CRON || '0 8 * * *';
const reminderTask = cron.schedule(reminderCron, () => {
  runReminderCheck()
    .then((r) => r.items && console.log(`Reminder check: ${r.items} item(s), ${r.emailsSent} email(s) sent`))
    .catch((err) => console.error('Reminder check failed:', err));
});

const backupCron = process.env.BACKUP_CRON || '0 3 * * *';
const backupDir = process.env.BACKUP_DIR || './data/backups';
const backupTask = cron.schedule(backupCron, async () => {
  try {
    const dest = await backupDatabase(backupDir, { keep: intEnv('BACKUP_KEEP', 14) });
    console.log('Backup written to', dest);
  } catch (err) {
    console.error('Backup failed:', err);
  }
});

// Connected calendars (and banks) are refreshed when they come due; each has its own interval, and a
// failing one backs off. Every few minutes is only how often we look at what is due.
let integrationsRunning = false;
const syncDue = () => {
  if (integrationsRunning) return;
  integrationsRunning = true;
  runDueIntegrations()
    .then((r) => r.failed && console.log(`Integrations: ${r.ran} synced, ${r.failed} failed (see Settings > Integrations)`))
    .catch((err) => console.error('Integration sync failed:', err))
    .finally(() => {
      integrationsRunning = false;
    });
};
const integrationsTask = cron.schedule('*/5 * * * *', syncDue);
setTimeout(syncDue, 30_000).unref(); // catch up after a restart

// Expired sessions and old audit entries are pruned, then SQLite refreshes its statistics.
const maintenanceTask = cron.schedule('30 3 * * *', () => {
  try {
    const result = maintainDatabase({ auditRetentionDays: intEnv('AUDIT_RETENTION_DAYS', 400) });
    console.log(`Maintenance: ${result.expiredSessions} expired session(s), ${result.oldAudit} old audit entr(ies) removed`);
  } catch (err) {
    console.error('Maintenance failed:', err);
  }
});
try {
  maintainDatabase({ auditRetentionDays: intEnv('AUDIT_RETENTION_DAYS', 400) });
} catch (err) {
  console.error('Startup maintenance failed:', err);
}

const port = process.env.PORT || 4000;
const server = app.listen(port, () => console.log(`HomeVault backend listening on port ${port}`));
// Slow-loris protection and a bound on idle keep-alive sockets.
server.headersTimeout = 20_000;
server.requestTimeout = 5 * 60_000; // large uploads on slow links still fit
server.keepAliveTimeout = 65_000; // longer than common proxy idle timeouts (60 s)

// `docker stop` sends SIGTERM; as PID 1 node would otherwise ignore it and get
// SIGKILLed after 10s, skipping the SQLite WAL checkpoint on close.
function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  reminderTask.stop();
  backupTask.stop();
  maintenanceTask.stop();
  integrationsTask.stop();
  server.close(() => {
    closeDatabase();
    process.exit(0);
  });
  server.closeIdleConnections?.();
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
