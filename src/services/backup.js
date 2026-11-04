'use strict';
// Daily encrypted backups, copied to a second location, with a restore test.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const db = require('../db');
const dates = require('../lib/dates');
const { encryptBuffer, decryptBuffer } = require('../lib/crypto');
const { BACKUPS, BACKUPS_2, DATA } = require('../config');

async function run() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tmp = path.join(DATA, `backup-${stamp}.db`);
  await db.get().backup(tmp);
  const enc = encryptBuffer(fs.readFileSync(tmp));
  fs.unlinkSync(tmp);
  const name = `lms-${stamp}.db.enc`;
  const copies = [];
  for (const dir of [BACKUPS, BACKUPS_2]) { fs.writeFileSync(path.join(dir, name), enc); copies.push(dir); }
  const sha = crypto.createHash('sha256').update(enc).digest('hex');
  db.get().prepare('INSERT INTO backups(file, size, sha256, created_at, copies) VALUES (?,?,?,?,?)').run(name, enc.length, sha, dates.nowIso(), JSON.stringify(copies));
  prune();
  return name;
}

function prune(keep = 35) {
  for (const dir of [BACKUPS, BACKUPS_2]) {
    const all = fs.readdirSync(dir).filter((f) => f.endsWith('.db.enc')).sort();
    for (const f of all.slice(0, Math.max(0, all.length - keep))) fs.unlinkSync(path.join(dir, f));
  }
}

// Test restore: decrypt the backup from the second location into a scratch database and check it.
function testRestore(id) {
  const b = id ? db.get().prepare('SELECT * FROM backups WHERE id = ?').get(id) : db.get().prepare('SELECT * FROM backups ORDER BY id DESC LIMIT 1').get();
  if (!b) throw new Error('No backup to test.');
  const tmp = path.join(DATA, `restore-test-${Date.now()}.db`);
  let result;
  try {
    const enc = fs.readFileSync(path.join(BACKUPS_2, b.file));
    const sha = crypto.createHash('sha256').update(enc).digest('hex');
    if (sha !== b.sha256) throw new Error('Checksum does not match');
    fs.writeFileSync(tmp, decryptBuffer(enc));
    const t = new Database(tmp, { readonly: true });
    const ok = t.pragma('integrity_check', { simple: true });
    const loans = t.prepare('SELECT COUNT(*) n FROM loans').get().n;
    const customers = t.prepare('SELECT COUNT(*) n FROM customers').get().n;
    t.close();
    result = `${ok === 'ok' ? 'OK' : 'FAILED: ' + ok} — ${customers} customers, ${loans} loans restored from the second location`;
  } catch (e) { result = 'FAILED: ' + e.message; } finally { try { fs.unlinkSync(tmp); } catch { /* none */ } }
  db.get().prepare('UPDATE backups SET verified_at = ?, verify_result = ? WHERE id = ?').run(dates.nowIso(), result, b.id);
  return result;
}

function list() { return db.get().prepare('SELECT * FROM backups ORDER BY id DESC LIMIT 40').all(); }

module.exports = { run, testRestore, list };
