'use strict';
// Anti-money laundering checks (AML/CTF Act 2015): sanctions screening at onboarding,
// unusual-activity flags, and suspicious transaction reports to FASU (Bank of PNG).
const db = require('../db');
const dates = require('../lib/dates');
const money = require('../lib/money');
const audit = require('../lib/audit');
const names = require('../lib/names');
const { rule, NotFound } = require('../lib/errors');
const { requireRole } = require('../lib/ctx');
const settings = require('./settings');
const notify = require('./notify');

const TYPES = {
  sanctions_match: 'Sanctions list match',
  large_cash: 'Large cash transaction',
  repeat_high_value: 'Repeated high-value items',
  manual: 'Raised by staff',
};

function flag(ctx, { type, customerId = null, loanId = null, paymentId = null, details }) {
  const info = db.get().prepare('INSERT INTO aml_flags(type, customer_id, loan_id, payment_id, details, created_at) VALUES (?,?,?,?,?,?)')
    .run(type, customerId, loanId, paymentId, details, dates.nowIso());
  audit.log(ctx, 'aml_flag', 'aml_flag', info.lastInsertRowid, null, { type, details });
  notify.inApp({ role: 'cro', title: `AML flag: ${TYPES[type] || type}`, body: details, link: '/aml' });
  notify.inApp({ role: 'admin', title: `AML flag: ${TYPES[type] || type}`, body: details, link: '/aml' });
  return info.lastInsertRowid;
}

function checkCash(ctx, { amount, channel, customerId, loanId, paymentId, what }) {
  const limit = settings.get('aml_cash_threshold');
  if (channel === 'cash' && amount >= limit) {
    flag(ctx, { type: 'large_cash', customerId, loanId, paymentId, details: `${what} of ${money.fmt(amount)} in cash (threshold ${money.fmt(limit)}).` });
  }
}

function checkRepeatHighValue(ctx, customerId, loanId, onDate) {
  const hv = settings.get('aml_high_value'), n = settings.get('aml_repeat_count'), days = settings.get('aml_repeat_days');
  const since = dates.addDays(onDate, -days);
  const count = db.get().prepare(`SELECT COUNT(*) n FROM loan_items li JOIN loans l ON l.id = li.loan_id
    WHERE l.customer_id = ? AND li.assessed_value >= ? AND l.application_date >= ?`).get(customerId, hv, since).n;
  if (count >= n) {
    const open = db.get().prepare("SELECT 1 FROM aml_flags WHERE customer_id = ? AND type = 'repeat_high_value' AND status = 'open'").get(customerId);
    if (!open) flag(ctx, { type: 'repeat_high_value', customerId, loanId, details: `${count} items valued at ${money.fmt(hv)} or more pledged in the last ${days} days.` });
  }
}

function review(ctx, id, { status, note, fasu_ref }) {
  requireRole(ctx, 'cro', 'admin');
  const f = db.get().prepare('SELECT * FROM aml_flags WHERE id = ?').get(id);
  if (!f) throw new NotFound();
  rule(['cleared', 'reported'].includes(status), 'Choose cleared or reported to FASU.');
  rule(note, 'A review note is required.');
  if (status === 'reported') rule(fasu_ref, 'Enter the FASU suspicious transaction report reference.');
  db.get().prepare('UPDATE aml_flags SET status = ?, review_note = ?, fasu_ref = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?')
    .run(status, note, fasu_ref || null, ctx.user.id, dates.nowIso(), id);
  audit.log(ctx, 'aml_review', 'aml_flag', id, { status: f.status }, { status, note, fasu_ref });
}

function addSanction(ctx, { full_name, dob, source }) {
  requireRole(ctx, 'admin');
  rule(full_name, 'Name is required.');
  const info = db.get().prepare('INSERT INTO sanctions_list(full_name, name_norm, dob, source, added_by, created_at) VALUES (?,?,?,?,?,?)')
    .run(full_name.trim(), names.norm(full_name), dates.parse(dob), source || null, ctx.user.id, dates.nowIso());
  audit.log(ctx, 'sanctions_add', 'sanctions_list', info.lastInsertRowid, null, { full_name, source });
}
function removeSanction(ctx, id) {
  requireRole(ctx, 'admin');
  const r = db.get().prepare('SELECT * FROM sanctions_list WHERE id = ?').get(id);
  db.get().prepare('DELETE FROM sanctions_list WHERE id = ?').run(id);
  audit.log(ctx, 'sanctions_remove', 'sanctions_list', id, r, null);
}

module.exports = { TYPES, flag, checkCash, checkRepeatHighValue, review, addSanction, removeSanction };
