'use strict';

const express = require('express');
const mongoose = require('mongoose');

const Environment = require('../models/Environment');
const requireAuth = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');

const router = express.Router();

// Every route in this file requires a valid JWT.
router.use(requireAuth);

/**
 * POST /api/environments
 * Body: { provider, alias, accessKey, secretKey }
 * -> 201 { environment: { id, provider, alias, ... } }   (no credentials, ever)
 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { provider, alias, accessKey, secretKey } = req.body || {};

    if (!provider || !String(provider).trim()) {
      throw new ApiError(400, 'provider is required');
    }
    if (!alias || !String(alias).trim()) {
      throw new ApiError(400, 'alias is required');
    }
    if (!accessKey || !String(accessKey).trim()) {
      throw new ApiError(400, 'accessKey is required');
    }
    if (!secretKey || !String(secretKey).trim()) {
      throw new ApiError(400, 'secretKey is required');
    }

    // Credentials are encrypted by the Environment pre('save') Vault hook.
    const environment = await Environment.create({
      user: req.user._id,
      provider: String(provider).trim(),
      alias: String(alias).trim(),
      accessKey: String(accessKey),
      secretKey: String(secretKey),
    });

    // toJSON transform strips accessKey/secretKey.
    return res.status(201).json({ environment: environment.toJSON() });
  })
);

/**
 * GET /api/environments
 * -> 200 { environments: [ { id, provider, alias, ... } ] }
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const environments = await Environment.find({ user: req.user._id }).sort({
      createdAt: -1,
    });

    return res.json({ environments });
  })
);

/**
 * GET /api/environments/:id
 * -> 200 { environment: { id, provider, alias, ... } }
 */
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new ApiError(404, 'Environment not found');
    }

    const environment = await Environment.findOne({
      _id: id,
      user: req.user._id,
    });

    if (!environment) {
      throw new ApiError(404, 'Environment not found');
    }

    return res.json({ environment });
  })
);

module.exports = router;