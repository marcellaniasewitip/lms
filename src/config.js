'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.LMS_DATA_DIR || path.join(ROOT, 'data');
const UPLOADS = path.join(DATA, 'uploads');
const BACKUPS = process.env.LMS_BACKUP_DIR || path.join(DATA, 'backups');
// Second backup location (spec: daily encrypted backups kept in a second location).
const BACKUPS_2 = process.env.LMS_BACKUP_DIR2 || path.join(DATA, 'backups-offsite');
for (const d of [DATA, UPLOADS, BACKUPS, BACKUPS_2]) fs.mkdirSync(d, { recursive: true });

function loadKey(envName, file) {
  if (process.env[envName]) {
    const k = Buffer.from(process.env[envName], 'hex');
    if (k.length !== 32) throw new Error(`${envName} must be 64 hex characters`);
    return k;
  }
  const p = path.join(DATA, file);
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    console.warn(`[config] Generated ${file}. In production set ${envName} from a secrets manager instead.`);
  }
  return Buffer.from(fs.readFileSync(p, 'utf8').trim(), 'hex');
}

module.exports = {
  ROOT,
  DATA,
  UPLOADS,
  BACKUPS,
  BACKUPS_2,
  DB_FILE: process.env.LMS_DB_FILE || path.join(DATA, 'lms.db'),
  PORT: Number(process.env.PORT || 3000),
  // Demo/training only: show SMS sign-in codes on screen because no SMS gateway is configured.
  SHOW_CODES: process.env.LMS_SHOW_CODES !== '0',
  SMS_GATEWAY_URL: process.env.LMS_SMS_GATEWAY_URL || '',
  SMS_GATEWAY_TOKEN: process.env.LMS_SMS_GATEWAY_TOKEN || '',
  IDLE_MINUTES: 15,
  MAX_LOGIN_ATTEMPTS: 5,
  MASTER_KEY: loadKey('LMS_MASTER_KEY', 'master.key'),
  SESSION_SECRET: process.env.LMS_SESSION_SECRET || loadKey('LMS_SESSION_KEY', 'session.key').toString('hex'),
  COOKIE_SECURE: process.env.LMS_COOKIE_SECURE === '1',
};
