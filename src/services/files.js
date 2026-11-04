'use strict';
// Every uploaded file (ID scans, photos, signatures, ownership papers, signed tickets)
// is encrypted at rest with AES-256-GCM.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const { UPLOADS } = require('../config');
const { encryptBuffer, decryptBuffer } = require('../lib/crypto');

const ALLOWED = /^(image\/(jpeg|png|webp|gif|heic)|application\/pdf)$/;

function store({ ownerType, ownerId, kind, buffer, mime, originalName = '', caption = null, userId = null }) {
  if (!ALLOWED.test(mime)) throw new Error(`File type ${mime} is not allowed (images or PDF only).`);
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

module.exports = { store, storeDataUrl, storeUploads, list, getMeta, read, remove, removeOwner };
