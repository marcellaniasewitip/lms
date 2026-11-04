'use strict';
// Incoming bank deposits and mobile transfers that are not yet matched to a loan wait
// in a holding list until the Loan Officer matches them (by the loan number quoted).
const db = require('../db');
const dates = require('../lib/dates');
const money = require('../lib/money');
const audit = require('../lib/audit');
const { rule, NotFound } = require('../lib/errors');
const { requireRole, today } = require('../lib/ctx');
const loans = require('./loans');

function addUnmatched(ctx, { amount, channel, reference, date_received, payer_name, note }) {
  requireRole(ctx, 'loan_officer');
  const amt = money.parse(amount);
  rule(amt && amt > 0, 'Enter the amount.');
  rule(['bank', 'mobile'].includes(channel), 'Unmatched payments are bank deposits or mobile transfers.');
  rule(reference, 'Enter the bank or transfer reference.');
  const dr = dates.parse(date_received) || today(ctx);
  rule(dr <= today(ctx), 'Date received cannot be in the future.');
  const info = db.get().prepare(`INSERT INTO unmatched_payments(branch_id, amount, channel, reference, date_received, payer_name, note, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(ctx.user.branch_id, amt, channel, reference.trim(), dr, payer_name || null, note || null, ctx.user.id, dates.nowIso());
  audit.log(ctx, 'unmatched_payment', 'unmatched_payment', info.lastInsertRowid, null, { amount: amt, channel, reference, date_received: dr });
  // Customers quote their loan number as the reference: suggest the match.
  return info.lastInsertRowid;
}

function suggestions(u) {
  const words = String(`${u.reference} ${u.note || ''}`).match(/\d{4,}/g) || [];
  return words.map((w) => loans.byNo(w)).filter((l) => l && loans.PAYABLE.includes(l.status));
}

function match(ctx, unmatchedId, loanNo) {
  requireRole(ctx, 'loan_officer');
  const u = db.get().prepare('SELECT * FROM unmatched_payments WHERE id = ?').get(unmatchedId);
  if (!u) throw new NotFound();
  rule(u.status === 'unmatched', 'Already matched.');
  const l = loans.byNo(loanNo);
  rule(l, `Loan ${loanNo} not found.`);
  const pid = loans.postPayment(ctx, l.id, {
    amount: money.fmt(u.amount), channel: u.channel, reference: u.reference, date_received: u.date_received, unmatched_id: u.id,
  });
  db.get().prepare("UPDATE unmatched_payments SET status = 'matched', matched_loan_id = ?, matched_payment_id = ?, matched_by = ?, matched_at = ? WHERE id = ?")
    .run(l.id, pid, ctx.user.id, dates.nowIso(), u.id);
  audit.log(ctx, 'payment_matched', 'unmatched_payment', u.id, { status: 'unmatched' }, { status: 'matched', loan_no: l.loan_no });
  return pid;
}

function holdingList(ctx) {
  const branch = ctx.user.role === 'admin' ? null : ctx.user.branch_id;
  return db.get().prepare(`SELECT * FROM unmatched_payments WHERE status = 'unmatched' ${branch ? 'AND (branch_id = ? OR branch_id IS NULL)' : ''} ORDER BY date_received`)
    .all(...(branch ? [branch] : [])).map((u) => ({ ...u, suggestions: suggestions(u) }));
}

module.exports = { addUnmatched, match, holdingList };
