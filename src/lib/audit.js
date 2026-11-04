'use strict';
const db = require('../db');

const SENSITIVE = /password|_enc$|code_hash|number_hash/;
function scrub(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object') return JSON.stringify(v);
  const o = Array.isArray(v) ? v : { ...v };
  if (!Array.isArray(o)) for (const k of Object.keys(o)) if (SENSITIVE.test(k)) o[k] = o[k] ? '[encrypted]' : o[k];
  return JSON.stringify(o);
}

// ctx: { user, ip } — user may be null for system jobs.
function log(ctx, action, entity, entityId, oldValue, newValue) {
  const u = ctx && ctx.user;
  db.get().prepare(`INSERT INTO audit_log(ts, user_id, username, role, action, entity, entity_id, old_value, new_value, ip)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    new Date().toISOString(), u ? u.id : null, u ? u.username : 'system', u ? u.role : 'system', action,
    entity || null, entityId === undefined || entityId === null ? null : String(entityId),
    scrub(oldValue), scrub(newValue), (ctx && ctx.ip) || null);
}

// Returns only the fields that changed, for compact old/new audit values.
function diff(before, after) {
  const o = {}, n = {};
  for (const k of Object.keys(after)) {
    if (before[k] !== after[k] && !(before[k] == null && (after[k] === '' || after[k] == null))) { o[k] = before[k]; n[k] = after[k]; }
  }
  return [o, n];
}

module.exports = { log, diff };
