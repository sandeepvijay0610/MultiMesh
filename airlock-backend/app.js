'use strict';

const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const environmentRoutes = require('./routes/environments');
const actionRoutes = require('./routes/actions');
const { notFound, errorHandler } = require('./middleware/errorHandler');

/**
 * Builds and returns the Express application.
 * NOTE: socket.io is intentionally NOT created here — it is created in
 * server.js and injected with `app.set('io', io)` to avoid circular imports.
 *
 * @returns {import('express').Express}
 */
function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // ---- CORS (HTTP layer) -------------------------------------------------
  const origin = process.env.CORS_ORIGIN || '*';
  app.use(
    cors({
      origin: origin === '*' ? '*' : origin.split(',').map((s) => s.trim()),
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      exposedHeaders: ['Content-Length'],
      credentials: false,
      optionsSuccessStatus: 204,
    })
  );
  // ------------------------------------------------------------------------

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // ---- Health check ------------------------------------------------------
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'airlock', ts: new Date().toISOString() });
  });
  // ------------------------------------------------------------------------

  // ---- API routes --------------------------------------------------------
  app.use('/api/auth', authRoutes);
  app.use('/api/environments', environmentRoutes);
  app.use('/api/actions', actionRoutes);
  // ------------------------------------------------------------------------

  // ---- Error handling (must be last) -------------------------------------
  app.use(notFound);
  app.use(errorHandler);
  // ------------------------------------------------------------------------

  return app;
}

module.exports = createApp;