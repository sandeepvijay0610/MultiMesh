'use strict';

require('dotenv').config();

const http = require('http');
const mongoose = require('mongoose');
const { Server } = require('socket.io');

const createApp = require('./app');
const connectDB = require('./config/db');
const Vault = require('./utils/vault');

const PORT = Number.parseInt(process.env.PORT, 10) || 4000;

const REQUIRED_ENV = ['MONGO_URI', 'JWT_SECRET', 'MASTER_KEY'];

function assertConfig() {
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  if (process.env.JWT_SECRET.length < 32) {
    console.warn(
      '[airlock] WARNING: JWT_SECRET is shorter than 32 characters. Use a strong secret in production.'
    );
  }

  // Instantiate the vault now so a bad MASTER_KEY fails fast at boot.
  Vault.getInstance();
}

async function bootstrap() {
  assertConfig();

  await connectDB(process.env.MONGO_URI);

  const app = createApp();
  const server = http.createServer(app);

  // ---- Socket.io ---------------------------------------------------------
  // CORS is configured explicitly on the socket.io instance as required.
  const io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      credentials: false,
    },
    path: '/socket.io',
    pingTimeout: 20000,
    pingInterval: 25000,
  });

  // Decouple socket.io from the route layer: controllers read it via
  // `req.app.get('io')`, which avoids any circular dependency.
  app.set('io', io);

  io.on('connection', (socket) => {
    console.log(`[airlock] socket connected: ${socket.id}`);

    socket.emit('connected', { socketId: socket.id, ts: Date.now() });

    socket.on('disconnect', (reason) => {
      console.log(`[airlock] socket disconnected: ${socket.id} (${reason})`);
    });
  });
  // ------------------------------------------------------------------------

  server.listen(PORT, () => {
    console.log(`[airlock] HTTP + WebSocket server listening on port ${PORT}`);
    console.log(`[airlock] env=${process.env.NODE_ENV || 'development'}`);
  });

  // ---- Graceful shutdown -------------------------------------------------
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[airlock] ${signal} received — shutting down...`);

    const force = setTimeout(() => {
      console.error('[airlock] Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
    force.unref();

    try {
      await new Promise((resolve) => io.close(resolve));
      await new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
      await mongoose.connection.close(false);
      clearTimeout(force);
      console.log('[airlock] Shutdown complete');
      process.exit(0);
    } catch (err) {
      console.error('[airlock] Error during shutdown:', err);
      process.exit(1);
    }
  }

  ['SIGINT', 'SIGTERM'].forEach((signal) => {
    process.on(signal, () => shutdown(signal));
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[airlock] Unhandled promise rejection:', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[airlock] Uncaught exception:', err);
    shutdown('uncaughtException');
  });
  // ------------------------------------------------------------------------
}

bootstrap().catch((err) => {
  console.error('[airlock] Fatal startup error:', err);
  process.exit(1);
});