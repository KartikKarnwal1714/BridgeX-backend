// Encrypts upstream credentials before they are stored in PostgreSQL (AES-256-GCM).
// Format: v1:<iv>:<auth tag>:<ciphertext>, each part base64. A fresh random IV is
// used for every value, and the auth tag makes tampering detectable on decrypt.
const crypto = require('crypto');
const env = require('../config/env');

const key = () => Buffer.from(env.GATEWAY_ENCRYPTION_KEY, 'hex');

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':');
}

function decrypt(stored) {
  const [version, iv, tag, ciphertext] = String(stored).split(':');
  if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('Unsupported credential format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
