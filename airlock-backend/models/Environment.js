'use strict';

const mongoose = require('mongoose');
const Vault = require('../utils/vault');

function baseTransform(doc, ret) {
  if (ret._id !== undefined && ret._id !== null) {
    ret.id = ret._id.toString();
  }
  delete ret._id;
  delete ret.__v;
  return ret;
}

const environmentSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    provider: {
      type: String,
      required: [true, 'provider is required'],
      trim: true,
    },
    alias: {
      type: String,
      required: [true, 'alias is required'],
      trim: true,
    },
    accessKey: {
      type: String,
      required: [true, 'accessKey is required'],
      // Credentials are never loaded unless explicitly requested.
      select: false,
    },
    secretKey: {
      type: String,
      required: [true, 'secretKey is required'],
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
        // HARD RULE: never leak credentials — not plaintext, not ciphertext.
        delete ret.accessKey;
        delete ret.secretKey;
        return ret;
      },
    },
    toObject: {
      virtuals: true,
      versionKey: false,
      transform(doc, ret) {
        baseTransform(doc, ret);
        delete ret.accessKey;
        delete ret.secretKey;
        return ret;
      },
    },
  }
);

/**
 * Encrypt credentials with the AES-256-GCM Vault before persistence.
 * Idempotent: already-encrypted values are not re-encrypted.
 */
environmentSchema.pre('save', function encryptCredentials(next) {
  try {
    const vault = Vault.getInstance();

    if (this.isModified('accessKey') && this.accessKey && !Vault.isEncrypted(this.accessKey)) {
      this.accessKey = vault.encrypt(this.accessKey);
    }

    if (this.isModified('secretKey') && this.secretKey && !Vault.isEncrypted(this.secretKey)) {
      this.secretKey = vault.encrypt(this.secretKey);
    }

    return next();
  } catch (err) {
    return next(err);
  }
});

/**
 * Decrypts credentials for internal use ONLY (e.g. a future execution worker).
 * Requires the document to have been loaded with .select('+accessKey +secretKey').
 * @returns {{ accessKey: string|null, secretKey: string|null }}
 */
environmentSchema.methods.getDecryptedCredentials = function getDecryptedCredentials() {
  const vault = Vault.getInstance();
  return {
    accessKey: this.accessKey ? vault.decrypt(this.accessKey) : null,
    secretKey: this.secretKey ? vault.decrypt(this.secretKey) : null,
  };
};

environmentSchema.index({ user: 1, alias: 1 }, { unique: true });

module.exports =
  mongoose.models.Environment || mongoose.model('Environment', environmentSchema);