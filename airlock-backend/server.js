'use strict';

require('dotenv').config();

const http = require('http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
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

/**
 * Extracts a bearer token from a socket.io handshake.
 *
 * Priority:
 *   1. socket.handshake.auth.token   (preferred — never logged in URLs)
 *   2. Authorization: Bearer <token> (Node / server-side clients)
 *   3. ?token= query param           (last-resort fallback, e.g. browsers
 *                                     that cannot set handshake auth)
 *
 * @param {import('socket.io').Socket} socket
 * @returns {string|null}
 */
function extractHandshakeToken(socket) {
  const auth = socket.handshake.auth || {};
  if (typeof auth.token === 'string' && auth.token.trim()) {
    return auth.token.trim();
  }

  const header =
    socket.handshake.headers?.authorization ||
    socket.handshake.headers?.Authorization ||
    '';
  const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  if (match) return match[1].trim();

  const queryToken = socket.handshake.query?.token;
  if (typeof queryToken === 'string' && queryToken.trim()) {
    return queryToken.trim();
  }

  return null;
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

  // ---- Socket authentication (MULTI-TENANT ISOLATION) --------------------
  // Reject the handshake before a connection is ever established unless the
  // client presents a valid JWT. The verified user id becomes the socket's
  // private room, so no tenant can ever observe another tenant's events.
  io.use((socket, next) => {
    try {
      if (!process.env.JWT_SECRET) {
        return next(new Error('Authentication error'));
      }

      const token = extractHandshakeToken(socket);
      if (!token) {
        return next(new Error('Authentication error'));
      }

      let payload;
      try {
        payload = jwt.verify(token, process.env.JWT_SECRET);
      } catch (err) {
        const reason = err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token';
        return next(new Error(`Authentication error: ${reason}`));
      }

      const userId = payload.sub || payload.id;
      if (!userId) {
        return next(new Error('Authentication error'));
      }

      // Stash the identity on the socket for room assignment + logging.
      socket.userId = String(userId);
      socket.tokenExp = payload.exp || null;

      return next();
    } catch (err) {
      return next(new Error('Authentication error'));
    }
  });

  io.on('connection', (socket) => {
    // Join a private room unique to this user. Every subsequent
    // `io.to(userId).emit(...)` reaches ONLY this user's sockets.
    socket.join(socket.userId);

    console.log(
      `[airlock] socket connected: ${socket.id} for user ${socket.userId}`
    );

    socket.emit('connected', {
      socketId: socket.id,
      userId: socket.userId,
      ts: Date.now(),
    });

    socket.on('disconnect', (reason) => {
      console.log(
        `[airlock] socket disconnected: ${socket.id} for user ${socket.userId} (${reason})`
      );
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