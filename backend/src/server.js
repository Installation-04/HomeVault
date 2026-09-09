import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import cron from 'node-cron';
import { fileURLToPath } from 'node:url';

import './db/index.js'; // initializes schema on import
import { backupDatabase } from './db/index.js';
import { authRouter } from './routes/auth.js';
import { propertiesRouter } from './routes/properties.js';
import { documentsRouter } from './routes/documents.js';
import { equipmentRouter } from './routes/equipment.js';
import { remindersRouter } from './routes/reminders.js';
import { tasksRouter } from './routes/tasks.js';
import { expensesRouter } from './routes/expenses.js';
import { calendarRouter } from './routes/calendar.js';
import { exportRouter } from './routes/export.js';
import { dashboardRouter } from './routes/dashboard.js';
import { runReminderCheck } from './utils/reminderEngine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const corsOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173').split(',').map((s) => s.trim());
app.use(cors({ origin: corsOrigins }));
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.use('/api/auth', authRouter);
app.use('/api/properties', propertiesRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/equipment', equipmentRouter);
app.use('/api/reminders', remindersRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/expenses', expensesRouter);
app.use('/api/calendar', calendarRouter);
app.use('/api/export', exportRouter);
app.use('/api/dashboard', dashboardRouter);

// Serve the built frontend (single-container deploy).
const frontendDist = path.join(__dirname, '../../frontend/dist');
app.use(express.static(frontendDist));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(frontendDist, 'index.html'), (err) => {
    if (err) next();
  });
});

const reminderCron = process.env.REMINDER_CHECK_CRON || '0 8 * * *';
cron.schedule(reminderCron, () => {
  runReminderCheck().catch((err) => console.error('Reminder check failed:', err));
});

const backupCron = process.env.BACKUP_CRON || '0 3 * * *';
const backupDir = process.env.BACKUP_DIR || './data/backups';
cron.schedule(backupCron, () => {
  try {
    const dest = backupDatabase(backupDir);
    console.log('Backup written to', dest);
  } catch (err) {
    console.error('Backup failed:', err);
  }
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`HomeVault backend listening on port ${port}`));
