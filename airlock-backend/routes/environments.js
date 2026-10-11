'use strict';

const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');

const Environment = require('../models/Environment');
const requireAuth = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');

const router = express.Router();

router.use(requireAuth);

/**
 * Constant-time string comparison. Returns false on type mismatch or
 * length mismatch without leaking timing information about prefix matches.
 */
function safeTokenEquals(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * POST /api/environments
 * Body: { provider, alias, accessKey, secretKey }
 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { provider, alias, accessKey, secretKey } = req.body || {};

    if (!provider || !String(provider).trim()) throw new ApiError(400, 'provider is required');
    if (!alias || !String(alias).trim()) throw new ApiError(400, 'alias is required');
    if (!accessKey || !String(accessKey).trim()) throw new ApiError(400, 'accessKey is required');
    if (!secretKey || !String(secretKey).trim()) throw new ApiError(400, 'secretKey is required');

    const environment = await Environment.create({
      user: req.user._id,
      provider: String(provider).trim(),
      alias: String(alias).trim(),
      accessKey: String(accessKey),
      secretKey: String(secretKey),
    });

    return res.status(201).json({ environment: environment.toJSON() });
  })
);

/**
 * GET /api/environments
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const environments = await Environment.find({ user: req.user._id }).sort({ createdAt: -1 });
    return res.json({ environments });
  })
);

/**
 * GET /api/environments/:id/credentials
 * -----------------------------------------------------------------------
 * INTERNAL USE ONLY — consumed exclusively by mcp-service.
 *
 * Returns DECRYPTED credentials for the owning user. The ONLY route in
 * the codebase that ever returns plaintext credentials, and only after:
 *   1. JWT auth (router.use above)
 *   2. X-Internal-Token gate (if INTERNAL_CREDENTIALS_TOKEN is configured)
 *   3. Ownership check (environment.user === req.user._id)
 * -----------------------------------------------------------------------
 */
router.get(
  '/:id/credentials',
  asyncHandler(async (req, res) => {
    // (1) Service-to-service shared secret gate.
    const expected = process.env.INTERNAL_CREDENTIALS_TOKEN;
    if (expected) {
      const presented = req.headers['x-internal-token'];
      if (!safeTokenEquals(presented, expected)) {
        // Same shape as an ownership failure so we don't leak the endpoint's
        // existence to unauthorized callers.
        throw new ApiError(403, 'You do not have access to this environment');
      }
    }

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new ApiError(404, 'Environment not found');
    }

    // (2) Ownership check + explicit credential load.
    const environment = await Environment.findById(id).select('+accessKey +secretKey');

    if (!environment) {
      throw new ApiError(404, 'Environment not found');
    }
    if (environment.user.toString() !== req.user._id.toString()) {
      throw new ApiError(403, 'You do not have access to this environment');
    }

    // (3) Just-in-time decryption. Never log the result.
    const { accessKey, secretKey } = environment.getDecryptedCredentials();

    return res.json({
      id: environment._id.toString(),
      provider: environment.provider,
      alias: environment.alias,
      accessKey,
      secretKey,
    });
  })
);

/**
 * GET /api/environments/:id
 */
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) throw new ApiError(404, 'Environment not found');

    const environment = await Environment.findOne({ _id: id, user: req.user._id });
    if (!environment) throw new ApiError(404, 'Environment not found');

    return res.json({ environment });
  })
);

module.exports = router;