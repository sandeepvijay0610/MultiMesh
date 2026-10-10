'use strict';

const jwt = require('jsonwebtoken');
const User = require('../models/User');

/**
 * Bearer-token authentication middleware.
 * Verifies the JWT, loads the owning user, and attaches it as `req.user`.
 */
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || req.headers.Authorization || '';

    const [scheme, token] = String(header).split(/\s+/);

    if (!scheme || !/^Bearer$/i.test(scheme) || !token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!process.env.JWT_SECRET) {
      return next(new Error('JWT_SECRET is not configured'));
    }

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      const message =
        err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token';
      return res.status(401).json({ error: message });
    }

    const userId = payload.sub || payload.id;
    if (!userId) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    req.user = user;
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = requireAuth;