'use strict';
// Every uploaded file (ID scans, photos, signatures, ownership papers, signed tickets)
// is encrypted at rest with AES-256-GCM.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const { UPLOADS } = require('../config');
const { encryptBuffer, decryptBuffer } = require('../lib/crypto');

const { RuleError } = require('../lib/errors');

// Files are recognised by their first bytes, not by the name or the type the browser reports
// (Windows often reports JPEG photos as image/jpg or application/octet-stream).
// Only formats every browser can show are kept, so staff can always open them later.
function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.slice(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.slice(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.slice(4, 8).toString('latin1') === 'ftyp' && /^(heic|heix|hevc|heim|heis|mif1|msf1|avif)/.test(buf.slice(8, 12).toString('latin1'))) return 'heic';
  return null;
}

// What is wrong with an uploaded file, or null when it can be stored.
function problem(name, buf) {
  const label = name ? `"${name}"` : 'The file';
  const type = sniff(buf);
  if (type === 'heic') return `${label} is an iPhone HEIC/HEIF photo, which browsers cannot display. Take the photo with the "Take photo" button, or on the iPhone set Settings → Camera → Formats → Most Compatible and take it again (it is then saved as JPEG).`;
  if (!type) return `${label} is not a photo or PDF. Attach a JPEG, PNG, WEBP or GIF photo, or a PDF scan (Word, Excel and other documents cannot be attached).`;
  return null;
}

function store({ ownerType, ownerId, kind, buffer, mime, originalName = '', caption = null, userId = null }) {
  const pr = problem(originalName, buffer);
  if (pr) throw new RuleError('This file cannot be attached.', [pr]);
  mime = sniff(buffer);
  const stored = crypto.randomBytes(16).toString('hex') + '.bin';
  fs.writeFileSync(path.join(UPLOADS, stored), encryptBuffer(buffer));
  const info = db.get().prepare(`INSERT INTO files(owner_type, owner_id, kind, original_name, mime, stored_name, size, caption, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(ownerType, ownerId, kind, originalName, mime, stored, buffer.length, caption, userId, new Date().toISOString());
  return info.lastInsertRowid;
}

// Stores a data URL (from the webcam capture or signature pad).
function storeDataUrl(opts) {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(opts.dataUrl || '');
  if (!m) return null;
  return store({ ...opts, mime: m[1], buffer: Buffer.from(m[2], 'base64'), originalName: opts.kind + '.' + m[1].split('/')[1] });
}

function storeUploads(files, opts) {
  const ids = [];
  for (const f of files || []) ids.push(store({ ...opts, buffer: f.buffer, mime: f.mimetype, originalName: f.originalname }));
  return ids;
}

function list(ownerType, ownerId, kind) {
  const q = kind
    ? db.get().prepare('SELECT * FROM files WHERE owner_type = ? AND owner_id = ? AND kind = ? ORDER BY id')
    : db.get().prepare('SELECT * FROM files WHERE owner_type = ? AND owner_id = ? ORDER BY id');
  return kind ? q.all(ownerType, ownerId, kind) : q.all(ownerType, ownerId);
}
function getMeta(id) { return db.get().prepare('SELECT * FROM files WHERE id = ?').get(id); }
function read(meta) { return decryptBuffer(fs.readFileSync(path.join(UPLOADS, meta.stored_name))); }
function remove(meta) {
  try { fs.unlinkSync(path.join(UPLOADS, meta.stored_name)); } catch { /* already gone */ }
  db.get().prepare('DELETE FROM files WHERE id = ?').run(meta.id);
}
function removeOwner(ownerType, ownerId) { for (const f of list(ownerType, ownerId)) remove(f); }

module.exports = { sniff, problem, store, storeDataUrl, storeUploads, list, getMeta, read, remove, removeOwner };
