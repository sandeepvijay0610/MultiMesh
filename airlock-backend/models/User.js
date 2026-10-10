'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const SALT_ROUNDS = 12;

/**
 * Shared JSON transform:
 *  - `_id`  -> `id`
 *  - removes `__v`
 *  - removes secrets
 */
function baseTransform(doc, ret) {
  if (ret._id !== undefined && ret._id !== null) {
    ret.id = ret._id.toString();
  }
  delete ret._id;
  delete ret.__v;
  return ret;
}

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      // Never loaded unless explicitly requested with .select('+password')
      select: false,
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      versionKey: false,
      transform(doc, ret) {
        baseTransform(doc, ret);
        // HARD RULE: password / password hash must never be serialized.
        delete ret.password;
        return ret;
      },
    },
    toObject: {
      virtuals: true,
      versionKey: false,
      transform(doc, ret) {
        baseTransform(doc, ret);
        delete ret.password;
        return ret;
      },
    },
  }
);

/**
 * Defensive hashing hook — the route layer may pass a plaintext password,
 * but this guarantees the stored value is always a bcrypt hash.
 */
userSchema.pre('save', async function hashPassword(next) {
  try {
    if (!this.isModified('password')) return next();

    const value = this.password;
    if (typeof value !== 'string' || value.length === 0) return next();

    // Already a bcrypt hash (e.g. re-save of a hashed doc) — leave it alone.
    if (/^\$2[aby]?\$\d{2}\$/.test(value)) return next();

    this.password = await bcrypt.hash(value, SALT_ROUNDS);
    return next();
  } catch (err) {
    return next(err);
  }
});

/**
 * Constant-time password comparison.
 * @param {string} candidate
 * @returns {Promise<boolean>}
 */
userSchema.methods.comparePassword = function comparePassword(candidate) {
  if (!this.password || typeof candidate !== 'string') {
    return Promise.resolve(false);
  }
  return bcrypt.compare(candidate, this.password);
};

userSchema.statics.SALT_ROUNDS = SALT_ROUNDS;

module.exports = mongoose.models.User || mongoose.model('User', userSchema);