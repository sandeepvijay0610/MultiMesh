'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const User = require('../models/User');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');

const router = express.Router();

const SALT_ROUNDS = 12;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function signToken(user) {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not configured');
  }
  return jwt.sign(
    { sub: user._id.toString(), email: user.email },
    process.env.JWT_SECRET,
    {
      expiresIn: process.env.JWT_EXPIRES_IN || '7d',
      issuer: 'airlock',
    }
  );
}

function publicUser(user) {
  return { id: user._id.toString(), email: user.email };
}

/**
 * POST /api/auth/register
 * Body: { email, password }
 * -> 201 { token, user: { id, email } }
 */
router.post(
  '/register',
  asyncHandler(async (req, res) => {
    const { email, password } = req.body || {};

    if (!email || !EMAIL_RE.test(String(email))) {
      throw new ApiError(400, 'A valid email is required');
    }
    if (!password || String(password).length < 8) {
      throw new ApiError(400, 'Password must be at least 8 characters');
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const hashed = await bcrypt.hash(String(password), SALT_ROUNDS);

    // Duplicate email is caught by the unique index and mapped to 409
    // by the global error handler (Mongo E11000).
    const user = await User.create({ email: normalizedEmail, password: hashed });

    return res.status(201).json({
      token: signToken(user),
      user: publicUser(user),
    });
  })
);

/**
 * POST /api/auth/login
 * Body: { email, password }
 * -> 200 { token, user: { id, email } }
 */
router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { email, password } = req.body || {};

    if (!email || !password) {
      throw new ApiError(400, 'Email and password are required');
    }

    const user = await User.findOne({
      email: String(email).toLowerCase().trim(),
    }).select('+password');

    // Uniform error to avoid user enumeration.
    if (!user) {
      throw new ApiError(401, 'Invalid credentials');
    }

    const ok = await user.comparePassword(String(password));
    if (!ok) {
      throw new ApiError(401, 'Invalid credentials');
    }

    return res.json({
      token: signToken(user),
      user: publicUser(user),
    });
  })
);

module.exports = router;