'use strict';

/**
 * 404 handler — mounted after all routes.
 */
function notFound(req, res) {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
}

/**
 * Global Express error handler.
 * Always responds with `{ error: "message" }`.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // If the response already started streaming, defer to the default handler.
  if (res.headersSent) {
    return next(err);
  }

  // --- Malformed JSON body (express.json) ---
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Malformed JSON body' });
  }

  // --- Mongoose: invalid ObjectId / cast failure ---
  if (err.name === 'CastError') {
    const path = err.path ? ` for field "${err.path}"` : '';
    return res.status(400).json({ error: `Invalid value${path}` });
  }

  // --- MongoDB: duplicate key (E11000) -> 409 Conflict ---
  if (err.code === 11000) {
    const keyValue = err.keyValue || {};
    const field =
      Object.keys(keyValue)[0] ||
      Object.keys(err.keyPattern || {})[0] ||
      'field';
    return res.status(409).json({ error: `An account or record with that ${field} already exists` });
  }

  // --- Mongoose: schema validation ---
  if (err.name === 'ValidationError') {
    const details = Object.values(err.errors || {})
      .map((e) => e.message)
      .filter(Boolean);
    return res
      .status(400)
      .json({ error: details.length ? details.join('; ') : 'Validation failed' });
  }

  // --- JWT errors that escaped the auth middleware ---
  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // --- Known / operational errors ---
  const status = Number(err.statusCode || err.status) || 500;

  if (status >= 500) {
    console.error('[airlock] Unhandled error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }

  return res.status(status).json({ error: err.message || 'Request failed' });
}

module.exports = { notFound, errorHandler };