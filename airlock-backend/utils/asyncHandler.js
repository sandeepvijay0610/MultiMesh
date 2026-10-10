'use strict';

/**
 * utils/asyncHandler.js
 * Wraps async route handlers so rejected promises reach the Express error
 * handler instead of becoming unhandled rejections.
 *
 * @param {Function} fn
 * @returns {import('express').RequestHandler}
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = asyncHandler;