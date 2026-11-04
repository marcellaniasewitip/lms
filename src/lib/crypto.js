'use strict';
// AES-256-GCM encryption for sensitive fields (ID numbers, bank details, device passwords)
// and for every stored upload (ID scans, photos, documents). HMAC is used for lookups
// (duplicate checks) without decrypting.
const crypto = require('crypto');
const { MASTER_KEY } = require('../config');

const ENC_KEY = crypto.hkdfSync('sha256', MASTER_KEY, Buffer.alloc(0), Buffer.from('lms-enc'), 32);
const MAC_KEY = crypto.hkdfSync('sha256', MASTER_KEY, Buffer.alloc(0), Buffer.from('lms-mac'), 32);

function encryptBuffer(buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(ENC_KEY), iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([Buffer.from('LMS1'), iv, c.getAuthTag(), ct]);
}
function decryptBuffer(blob) {
  if (blob.slice(0, 4).toString() !== 'LMS1') throw new Error('Not an LMS encrypted blob');
  const iv = blob.slice(4, 16), tag = blob.slice(16, 32), ct = blob.slice(32);
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(ENC_KEY), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}
function encrypt(text) {
  if (text === null || text === undefined || text === '') return null;
  return encryptBuffer(Buffer.from(String(text), 'utf8')).toString('base64');
}
function decrypt(b64) {
  if (!b64) return '';
  try { return decryptBuffer(Buffer.from(b64, 'base64')).toString('utf8'); } catch { return '[unreadable]'; }
}
function normalizeNumber(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function hmac(s) { return crypto.createHmac('sha256', Buffer.from(MAC_KEY)).update(normalizeNumber(s)).digest('hex'); }
function mask(s) {
  const n = normalizeNumber(s);
  if (!n) return '';
  return '****' + n.slice(-4);
}
function randomCode(digits = 6) { return String(crypto.randomInt(0, 10 ** digits)).padStart(digits, '0'); }
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

module.exports = { encrypt, decrypt, encryptBuffer, decryptBuffer, hmac, mask, normalizeNumber, randomCode, sha256 };
