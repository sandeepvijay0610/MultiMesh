'use strict';

const express = require('express');
const mongoose = require('mongoose');

const Action = require('../models/Action');
const Environment = require('../models/Environment');
const requireAuth = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');

const router = express.Router();

const { PENDING_APPROVAL, APPROVED, REJECTED } = Action.STATUS;

router.use(requireAuth);

/**
 * Broadcast helper — TENANT-SCOPED.
 *
 * Socket.io is attached to the app in server.js via `app.set('io', io)` to
 * avoid a circular dependency between the socket layer and the route layer.
 *
 * Every authenticated socket joins a private room named after its verified
 * user id (see server.js `io.use(...)` + `socket.join(socket.userId)`).
 * Emitting with `io.to(userId)` therefore reaches ONLY the owning tenant's
 * sockets. `io.emit(...)` is never used here — that would broadcast every
 * action, tool invocation, and parameter string to every connected client.
 *
 * @param {import('express').Request} req
 * @param {import('mongoose').Document} action
 */
function emitActionStateChanged(req, action) {
  const io = req.app.get('io');
  if (!io) return;
  if (!req.user || !req.user._id) return;

  const room = req.user._id.toString();
  const payload = action.toJSON ? action.toJSON() : action;

  io.to(room).emit('actionStateChanged', payload);
}

/**
 * Loads an action and verifies the caller owns the parent environment.
 * Returns 404 for both "missing" and "not yours" so we never leak existence.
 */
async function loadOwnedAction(req) {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError(404, 'Action not found');
  }

  const action = await Action.findById(id);
  if (!action) {
    throw new ApiError(404, 'Action not found');
  }

  const owned = await Environment.exists({
    _id: action.environmentId,
    user: req.user._id,
  });

  if (!owned) {
    throw new ApiError(404, 'Action not found');
  }

  return action;
}

/**
 * POST /api/actions/propose
 * Body: { environmentId, toolName, parameters }
 * -> 201 { action: { id, status: 'PENDING_APPROVAL', ... } }
 *
 * SECURITY: the environment must belong to the authenticated user.
 */
router.post(
  '/propose',
  asyncHandler(async (req, res) => {
    const { environmentId, toolName, parameters } = req.body || {};

    if (!environmentId || !mongoose.Types.ObjectId.isValid(String(environmentId))) {
      throw new ApiError(400, 'A valid environmentId is required');
    }
    if (!toolName || !String(toolName).trim()) {
      throw new ApiError(400, 'toolName is required');
    }
    if (parameters !== undefined && parameters !== null) {
      const t = typeof parameters;
      if (t !== 'object' || Array.isArray(parameters)) {
        throw new ApiError(400, 'parameters must be an object');
      }
    }

    // ---- Ownership verification -------------------------------------------
    const environment = await Environment.findOne({
      _id: environmentId,
      user: req.user._id,
    });

    if (!environment) {
      // Distinguish "exists but not yours" (403) from "does not exist" (404).
      const exists = await Environment.exists({ _id: environmentId });
      if (exists) {
        throw new ApiError(403, 'You do not have access to this environment');
      }
      throw new ApiError(404, 'Environment not found');
    }
    // -----------------------------------------------------------------------

    const action = await Action.create({
      environmentId: environment._id,
      toolName: String(toolName).trim(),
      parameters: parameters || {},
      status: PENDING_APPROVAL,
    });

    emitActionStateChanged(req, action);

    return res.status(201).json({ action: action.toJSON() });
  })
);

/**
 * GET /api/actions/pending
 * -> 200 { actions: [ ...PENDING_APPROVAL ] }   (scoped to the caller)
 */
router.get(
  '/pending',
  asyncHandler(async (req, res) => {
    const environments = await Environment.find({ user: req.user._id })
      .select('_id')
      .lean();

    const environmentIds = environments.map((e) => e._id);

    const actions = await Action.find({
      environmentId: { $in: environmentIds },
      status: PENDING_APPROVAL,
    }).sort({ createdAt: -1 });

    return res.json({ actions });
  })
);

/**
 * POST /api/actions/:id/approve
 * -> 200 { action: { id, status: 'APPROVED', ... } }
 */
router.post(
  '/:id/approve',
  asyncHandler(async (req, res) => {
    const action = await loadOwnedAction(req);

    if (action.status === APPROVED) {
      // Idempotent — approving an already-approved action is a no-op.
      return res.json({ action: action.toJSON() });
    }

    if (action.status === REJECTED) {
      throw new ApiError(409, 'Action has already been rejected');
    }

    action.status = APPROVED;
    await action.save();

    emitActionStateChanged(req, action);

    return res.json({ action: action.toJSON() });
  })
);

/**
 * POST /api/actions/:id/reject
 * -> 200 { action: { id, status: 'REJECTED', ... } }
 * -> 400 if the action is already APPROVED
 */
router.post(
  '/:id/reject',
  asyncHandler(async (req, res) => {
    const action = await loadOwnedAction(req);

    if (action.status === APPROVED) {
      throw new ApiError(400, 'Cannot reject an action that has already been approved');
    }

    if (action.status === REJECTED) {
      // Idempotent — already rejected.
      return res.json({ action: action.toJSON() });
    }

    action.status = REJECTED;
    await action.save();

    emitActionStateChanged(req, action);

    return res.json({ action: action.toJSON() });
  })
);

module.exports = router;