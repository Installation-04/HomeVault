import express from 'express';
import compression from 'compression';
import helmet from 'helmet';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { db } from './db/index.js';
import { trustProxySetting } from './config.js';
import { csrfGuard } from './middleware/csrf.js';
import { requireAuth } from './middleware/auth.js';
import { currentVersion } from './utils/version.js';
import { authRouter } from './routes/auth.js';
import { adminRouter } from './routes/admin.js';
import { propertiesRouter } from './routes/properties.js';
import { documentsRouter } from './routes/documents.js';
import { equipmentRouter } from './routes/equipment.js';
import { remindersRouter } from './routes/reminders.js';
import { tasksRouter } from './routes/tasks.js';
import { expensesRouter } from './routes/expenses.js';
import { calendarRouter } from './routes/calendar.js';
import { feedsRouter, publicFeedRouter } from './routes/feeds.js';
import { searchRouter } from './routes/search.js';
import { exportRouter } from './routes/export.js';
import { dashboardRouter } from './routes/dashboard.js';
import { integrationsRouter } from './routes/integrations.js';

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
  if (err.status && err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
}

// Vite fingerprints everything under /assets, so those files can be cached
// forever; the entry points that reference them must always be revalidated or
// an update would never reach installed PWAs.
function staticHeaders(res, filePath) {
  if (filePath.includes(`${path.sep}assets${path.sep}`)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  } else {
    res.setHeader('Cache-Control', 'no-cache');
  }
}

// Builds the express app without binding a port or starting cron jobs, so it
// can be exercised directly by tests. server.js is the process entrypoint.
export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  // Behind Traefik/Nginx/Caddy set TRUST_PROXY (e.g. 1) so rate limiting and
  // audit entries see the real client address and `req.secure` reflects TLS.
  app.set('trust proxy', trustProxySetting());

  // The frontend is served by this same server, so nothing needs CORS: no
  // cross-origin page can call the API with a visitor's cookies.
  app.use(
    helmet({
      // Browsers ignore HSTS over plain http, but a cached policy would lock you out
      // of an http-only LAN install if you ever go back, so it is opt-in.
      hsts: process.env.FORCE_HTTPS === 'true' ? { maxAge: 15552000, includeSubDomains: false } : false,
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
      crossOriginEmbedderPolicy: false,
    })
  );
  app.use((req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
    next();
  });

  app.use(compression());
  app.use(express.json({ limit: '256kb' }));

  // --- API ---------------------------------------------------------------
  // Responses contain personal records: never let a browser or proxy keep them.
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.get('/api/health', (req, res) => {
    try {
      db.prepare('SELECT 1').get();
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });
  // Calendar subscriptions authenticate with a secret in the URL (calendar apps
  // can't hold a cookie), so they sit outside the cookie/CSRF machinery.
  app.use('/api/calendar-feed', publicFeedRouter);

  app.use('/api', csrfGuard);
  app.use('/api/auth', authRouter);
  app.get('/api/about', requireAuth, (req, res) => res.json({ version: currentVersion() }));
  app.use('/api/admin', adminRouter);
  app.use('/api/properties', propertiesRouter);
  app.use('/api/documents', documentsRouter);
  app.use('/api/equipment', equipmentRouter);
  app.use('/api/reminders', remindersRouter);
  app.use('/api/tasks', tasksRouter);
  app.use('/api/expenses', expensesRouter);
  app.use('/api/calendar/feeds', feedsRouter);
  app.use('/api/calendar', calendarRouter);
  app.use('/api/search', searchRouter);
  app.use('/api/export', exportRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/integrations', integrationsRouter);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // --- Frontend (single-container deploy) --------------------------------
  const frontendDist = process.env.FRONTEND_DIST || path.join(__dirname, '../../frontend/dist');
  app.use(express.static(frontendDist, { index: false, setHeaders: staticHeaders }));
  // Express 5 wildcard syntax: any other GET is the single-page app.
  app.get('/{*splat}', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(frontendDist, 'index.html'), (err) => {
      if (err) next();
    });
  });

  app.use(errorHandler);
  return app;
}
