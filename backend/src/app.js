import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import './db/index.js'; // initializes schema on import
import { trustProxySetting } from './config.js';
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// JSON error responses for everything that bubbles up from a route.
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
  if (err instanceof multer.MulterError) {
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    return res.status(tooBig ? 413 : 400).json({ error: tooBig ? 'File is too large' : err.message });
  }
  if (err.status && err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
}

// Builds the express app without binding a port or starting cron jobs, so it
// can be exercised directly by tests. server.js is the process entrypoint.
export function createApp() {
  const app = express();

  // Behind Traefik/Nginx set TRUST_PROXY (e.g. 1) so rate limiting sees the
  // real client address instead of the proxy's.
  app.set('trust proxy', trustProxySetting());

  // HSTS and upgrade-insecure-requests are left to the reverse proxy: the app
  // is commonly reached over plain http on a LAN, where either would break it.
  app.use(
    helmet({
      hsts: false,
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          // React/Tailwind use inline style attributes and the label printer
          // injects an inline @page rule.
          'style-src': ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:', 'blob:'],
          'connect-src': ["'self'"],
          'manifest-src': ["'self'"],
          'worker-src': ["'self'"],
          'object-src': ["'none'"],
          'base-uri': ["'self'"],
          'form-action': ["'self'"],
          'frame-ancestors': ["'none'"],
        },
      },
    })
  );

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
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // Serve the built frontend (single-container deploy).
  const frontendDist = path.join(__dirname, '../../frontend/dist');
  app.use(express.static(frontendDist));
  app.get('*', (req, res, next) => {
    res.sendFile(path.join(frontendDist, 'index.html'), (err) => {
      if (err) next();
    });
  });

  app.use(errorHandler);
  return app;
}
