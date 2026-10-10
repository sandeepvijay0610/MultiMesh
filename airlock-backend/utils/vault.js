'use strict';

/**
 * utils/vault.js
 * ---------------------------------------------------------------------------
 * AES-256-GCM encryption vault implemented as a lazy Singleton.
 *
 * Ciphertext wire format:
 *      <ivHex>:<authTagHex>:<ciphertextHex>
 *
 *  - A fresh, cryptographically random 16-byte IV is generated per encryption.
 *  - The GCM auth tag (16 bytes) is persisted alongside the payload so that
 *    tampering is detected at decrypt time (decipher.final() throws).
 *  - The key is derived once from MASTER_KEY and never leaves this module.
 * ---------------------------------------------------------------------------
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16; // 128-bit IV, as required
const AUTH_TAG_LENGTH = 16; // 128-bit GCM auth tag
const KEY_LENGTH = 32; // 256-bit key

// iv(32 hex) : authTag(32 hex) : ciphertext(hex)
const CIPHERTEXT_PATTERN = /^[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]+$/i;

let instance = null;

/**
 * Normalises MASTER_KEY into a 32-byte Buffer.
 * @param {string} masterKey
 * @returns {Buffer}
 */
function deriveKey(masterKey) {
  if (!masterKey || typeof masterKey !== 'string' || masterKey.trim() === '') {
    throw new Error('Vault: MASTER_KEY is not configured');
  }

  const raw = masterKey.trim();

  // 64 hex characters -> raw 32 bytes
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    return Buffer.from(raw, 'hex');
  }

  // base64 that decodes to exactly 32 bytes
  if (/^[A-Za-z0-9+/]{43}=?$/.test(raw)) {
    const buf = Buffer.from(raw, 'base64');
    if (buf.length === KEY_LENGTH) return buf;
  }

  // Fallback: deterministic KDF for passphrase-style keys
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

class Vault {
  /**
   * @param {string} [masterKey] defaults to process.env.MASTER_KEY
   */
  constructor(masterKey) {
    // Singleton guard: return the existing instance instead of creating a new one.
    if (instance) return instance;

    this._key = deriveKey(masterKey || process.env.MASTER_KEY);
    this._algorithm = ALGORITHM;
    this._ivLength = IV_LENGTH;

    instance = this;
  }

  /**
   * @param {string} [masterKey]
   * @returns {Vault}
   */
  static getInstance(masterKey) {
    if (!instance) {
      instance = new Vault(masterKey);
    }
    return instance;
  }

  /**
   * Test/DI helper — drops the singleton so it can be rebuilt with a new key.
   */
  static resetInstance() {
    instance = null;
  }

  /**
   * @param {*} value
   * @returns {boolean} true if `value` already looks like vault ciphertext.
   */
  static isEncrypted(value) {
    return typeof value === 'string' && CIPHERTEXT_PATTERN.test(value);
  }

  /**
   * Encrypts a UTF-8 string.
   * @param {string} plaintext
   * @returns {string} `iv:authTag:ciphertext` (all hex)
   */
  encrypt(plaintext) {
    if (plaintext === null || plaintext === undefined) return plaintext;

    const value = String(plaintext);
    const iv = crypto.randomBytes(this._ivLength); // NEW IV PER ENCRYPTION

    const cipher = crypto.createCipheriv(this._algorithm, this._key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
  }

  /**
   * Decrypts `iv:authTag:ciphertext`.
   * @param {string} payload
   * @returns {string} plaintext
   */
  decrypt(payload) {
    if (payload === null || payload === undefined) return payload;

    const value = String(payload);
    const parts = value.split(':');

    if (parts.length !== 3) {
      throw new Error('Vault: malformed ciphertext (expected iv:authTag:data)');
    }

    const [ivHex, authTagHex, dataHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const data = Buffer.from(dataHex, 'hex');

    if (iv.length !== IV_LENGTH) {
      throw new Error('Vault: invalid IV length');
    }
    if (authTag.length !== AUTH_TAG_LENGTH) {
      throw new Error('Vault: invalid auth tag length');
    }

    const decipher = crypto.createDecipheriv(this._algorithm, this._key, iv);
    decipher.setAuthTag(authTag);

    // decipher.final() throws if the auth tag does not verify.
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }
}

module.exports = Vault;
module.exports.ALGORITHM = ALGORITHM;