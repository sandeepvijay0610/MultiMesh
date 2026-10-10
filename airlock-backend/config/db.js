'use strict';

const mongoose = require('mongoose');

// Fail fast rather than buffering commands forever.
mongoose.set('strictQuery', true);
mongoose.set('bufferCommands', false);
mongoose.set('runValidators', true);

/**
 * Connects to MongoDB. Resolves once the connection is ready.
 * @param {string} uri
 * @returns {Promise<typeof mongoose>}
 */
async function connectDB(uri) {
  if (!uri) {
    throw new Error('connectDB: MONGO_URI is not configured');
  }

  mongoose.connection.on('connected', () => {
    console.log('[airlock] MongoDB connected');
  });
  mongoose.connection.on('disconnected', () => {
    console.warn('[airlock] MongoDB disconnected');
  });
  mongoose.connection.on('error', (err) => {
    console.error('[airlock] MongoDB error:', err.message);
  });

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10000,
    maxPoolSize: 20,
  });

  return mongoose;
}

module.exports = connectDB;