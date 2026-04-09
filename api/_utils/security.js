const crypto = require('crypto');

const ENCRYPTION_ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;

/**
 * Encrypts a string using AES-256-CBC
 */
function encrypt(text, secret) {
  if (!secret) throw new Error('ENCRYPTION_SECRET is missing');
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, crypto.scryptSync(secret, 'salt', 32), iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

/**
 * Decrypts a string using AES-256-CBC
 */
function decrypt(text, secret) {
  if (!secret) throw new Error('ENCRYPTION_SECRET is missing');
  const textParts = text.split(':');
  const iv = Buffer.from(textParts.shift(), 'hex');
  const encryptedText = Buffer.from(textParts.join(':'), 'hex');
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, crypto.scryptSync(secret, 'salt', 32), iv);
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
}

/**
 * Validates a GAS token by calling the GAS Endpoint
 */
async function validateToken(token, gasUrl) {
  if (!token || !gasUrl) return null;
  try {
    const res = await fetch(gasUrl, {
      method: 'POST',
      body: JSON.stringify({ action: 'validate_token', token })
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.ok ? data : null;
  } catch (e) {
    console.error('Token validation error:', e);
    return null;
  }
}

module.exports = { encrypt, decrypt, validateToken };
