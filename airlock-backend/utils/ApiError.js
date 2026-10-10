'use strict';

/**
 * utils/ApiError.js
 * Operational (expected) HTTP error. Anything thrown that is NOT an ApiError
 * is treated as an unexpected 500 by the global error handler.
 */
class ApiError extends Error {
  /**
   * @param {number} statusCode
   * @param {string} message
   */
  constructor(statusCode, message) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = ApiError;