'use strict';
// Expiry and archiving: a loan is pulled out of the active system 30 days after it closes,
// kept in a locked, read-only archive for the retention period, then permanently deleted.
const db = require('../db');
const dates = require('../lib/dates');
const audit = require('../lib/audit');
const { decrypt } = require('../lib/crypto');
const { RuleError, NotFound, rule } = require('../lib/errors');
const { requireRole, today } = require('../lib/ctx');
const settings = require('./settings');
const files = require('./files');
const loans = require('./loans');
const customers = require('./customers');
const items = require('./items');
const notify = require('./notify');

const CLOSED = ['redeemed', 'item_sold', 'rejected', 'cancelled'];

// All four conditions in "When a loan counts as expired".
function eligibility(l, onDate, { early = false } = {}) {
  const reasons = [];
  if (l.archived) reasons.push('Already archived.');
  if (!CLOSED.includes(l.status) || !l.date_closed) reasons.push('Not closed: it must be paid with the item returned, sold, or rejected/cancelled with the item handed back.');
  if (l.status !== 'item_sold' && loans.total(l) !== 0) reasons.push('Balance is not K0.00.');
  if (!early && (!l.expiry_date || l.expiry_date > onDate)) reasons.push(`30 days have not passed since it closed${l.expiry_date ? ` (expiry date ${dates.fmt(l.expiry_date)})` : ''}.`);
  const held = loans.loanItems(l.id).filter((i) => items.HELD.includes(i.custody_status));
  if (held.length) reasons.push(`Item ${held.map((h) => h.item_no).join(', ')} is still held by the lender — never pulled out.`);
  const d = db.get();
  if (d.prepare("SELECT 1 FROM reversal_requests WHERE loan_id = ? AND status = 'pending'").get(l.id)) reasons.push('A payment reversal is open.');
  if (l.dispute_open) reasons.push('A dispute is open.');
  if (d.prepare("SELECT 1 FROM refunds WHERE loan_id = ? AND status = 'owed'").get(l.id)) reasons.push('Money is still owed to the pledger (refund or sale surplus).');
  if (d.prepare("SELECT 1 FROM waivers WHERE loan_id = ? AND status = 'pending'").get(l.id)) reasons.push('A waiver request is still pending.');
  return { eligible: reasons.length === 0, reasons };
}

function snapshot(l) {
  const d = db.get();
  const c = customers.get(l.customer_id);
  const lis = loans.loanItems(l.id);
  return {
    loan: l,
    customer: { id: c.id, customer_no: c.customer_no, name: customers.fullName(c), dob: c.dob, mobile: c.mobile },
    items: lis.map((i) => ({ ...i, device_password_enc: undefined, movements: items.movements(i.item_id), photos: files.list('item', i.item_id).map((f) => f.id) })),
    payments: loans.payments(l.id),
    interest: loans.interestEntries(l.id),
    waivers: d.prepare('SELECT * FROM waivers WHERE loan_id = ?').all(l.id),
    refunds: d.prepare('SELECT * FROM refunds WHERE loan_id = ?').all(l.id),
    reversals: d.prepare('SELECT * FROM reversal_requests WHERE loan_id = ?').all(l.id),
    sales: d.prepare('SELECT * FROM forfeiture_sales WHERE loan_id = ?').all(l.id),
    tickets: loans.tickets(l.id),
    history: loans.history(l.id),
    documents: files.list('loan', l.id).map((f) => ({ id: f.id, kind: f.kind, created_at: f.created_at })),
    taken_at: dates.nowIso(),
  };
}

function searchText(l) {
  const c = customers.get(l.customer_id);
  const parts = [l.loan_no, c.customer_no, customers.fullName(c).toUpperCase(), `${c.surname} ${c.given_names}`.toUpperCase()];
  for (const i of loans.loanItems(l.id)) parts.push(i.item_no, i.vin, i.plate, i.serial_no, i.imei, i.engine_no);
  for (const x of customers.ids(c.id)) parts.push('H:' + x.number_hash);
  return parts.filter(Boolean).join(' | ');
}

function archive(ctx, loanId, { method = 'auto', reason = null } = {}) {
  const l = loans.get(loanId);
  const on = today(ctx);
  const early = method === 'early';
  if (early) { requireRole(ctx, 'admin'); rule(reason, 'Give a reason for pulling the loan out early.'); }
  const el = eligibility(l, on, { early });
  if (!el.eligible) throw new RuleError(`Loan ${l.loan_no} cannot be archived.`, el.reasons);
  const d = db.get();
  const keepYears = settings.get('retention_years');
  d.transaction(() => {
    const snap = snapshot(l);
    d.prepare(`INSERT INTO archive(loan_id, loan_no, snapshot, search_text, archived_at, archived_by, method, reason, delete_after)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(l.id, l.loan_no, JSON.stringify(snap), searchText(l), dates.nowIso(), ctx.user ? ctx.user.id : null,
      method, reason || (early ? null : 'Expiry date reached'), dates.addYears(on, keepYears));
    loans.event(ctx, l.id, 'status', { from: l.status, to: 'expired', note: 'Expired: all conditions met' });
    loans.setStatus(ctx, l, 'archived', `Pulled out to the archive (${early ? 'early, by Admin: ' + reason : 'nightly expiry check'})`, {
      archived: 1, archive_date: on, pre_archive_status: l.status,
    });
    audit.log(ctx, 'archive', 'loan', l.id, { status: l.status }, { method, reason, by: ctx.user ? ctx.user.username : 'nightly job' });
  })();
}

function restore(ctx, archiveId, reason) {
  requireRole(ctx, 'admin');
  const a = db.get().prepare('SELECT * FROM archive WHERE id = ?').get(archiveId);
  if (!a) throw new NotFound();
  rule(!a.restored_at, 'Already restored.');
  rule(reason, 'Give the reason for restoring (for example, the error to be fixed).');
  const l = loans.get(a.loan_id);
  db.get().transaction(() => {
    db.get().prepare('UPDATE archive SET restored_at = ?, restored_by = ?, restore_reason = ? WHERE id = ?').run(dates.nowIso(), ctx.user.id, reason, a.id);
    // archive_hold stops the nightly job re-archiving it until the Admin archives it again.
    db.get().prepare('UPDATE loans SET archived = 0, archive_hold = 1, status = ?, archive_date = NULL WHERE id = ?').run(l.pre_archive_status, l.id);
    loans.event(ctx, l.id, 'status', { from: 'archived', to: l.pre_archive_status, note: `Restored from archive: ${reason}` });
    audit.log(ctx, 'restore', 'loan', l.id, { status: 'archived' }, { status: l.pre_archive_status, reason });
  })();
}

function searchArchive(q) {
  const d = db.get();
  if (!q) return d.prepare('SELECT * FROM archive WHERE restored_at IS NULL ORDER BY id DESC LIMIT 100').all();
  const { hmac } = require('../lib/crypto');
  const s = String(q).trim().toUpperCase();
  return d.prepare(`SELECT * FROM archive WHERE restored_at IS NULL AND (search_text LIKE ? OR search_text LIKE ?) ORDER BY id DESC LIMIT 100`)
    .all(`%${s}%`, `%H:${hmac(q)}%`);
}

function expiringSoon(onDate, days = 7) {
  return db.get().prepare(`SELECT * FROM loans WHERE archived = 0 AND expiry_date IS NOT NULL AND expiry_date <= ? ORDER BY expiry_date`)
    .all(dates.addDays(onDate, days)).map((l) => ({ ...l, ...eligibility(l, l.expiry_date > onDate ? l.expiry_date : onDate) }));
}

// Nightly: archive every loan whose expiry date has arrived and that meets all conditions.
function runExpiry(ctx, onDate) {
  const due = db.get().prepare('SELECT * FROM loans WHERE archived = 0 AND archive_hold = 0 AND expiry_date IS NOT NULL AND expiry_date <= ?').all(onDate);
  let archived = 0; const blocked = [];
  for (const l of due) {
    const el = eligibility(l, onDate);
    if (el.eligible) { archive({ ...ctx, today: onDate }, l.id, { method: 'auto' }); archived++; } else blocked.push(`${l.loan_no}: ${el.reasons.join(' ')}`);
  }
  const soon = expiringSoon(onDate).filter((l) => l.expiry_date > onDate);
  if (soon.length) notify.inApp({ role: 'admin', title: `${soon.length} loan(s) expiring in the next 7 days`, body: soon.map((l) => l.loan_no).join(', '), link: '/archive/expiring' });
  return { archived, blocked };
}

// Retention: permanently delete archived loans after the retention period; keep only loan number and date.
function runRetention(ctx, onDate) {
  const d = db.get();
  const due = d.prepare('SELECT * FROM archive WHERE restored_at IS NULL AND delete_after <= ?').all(onDate);
  for (const a of due) {
    d.transaction(() => {
      const lid = a.loan_id;
      const itemIds = d.prepare('SELECT item_id FROM loan_items WHERE loan_id = ?').all(lid).map((r) => r.item_id);
      for (const t of ['interest_entries', 'waivers', 'refunds', 'reversal_requests', 'loan_events', 'tickets', 'forfeiture_sales']) d.prepare(`DELETE FROM ${t} WHERE loan_id = ?`).run(lid);
      d.prepare('DELETE FROM payments WHERE loan_id = ?').run(lid);
      d.prepare('DELETE FROM unmatched_payments WHERE matched_loan_id = ?').run(lid);
      d.prepare('DELETE FROM loan_items WHERE loan_id = ?').run(lid);
      d.prepare('UPDATE aml_flags SET loan_id = NULL WHERE loan_id = ?').run(lid);
      d.prepare('DELETE FROM tasks WHERE loan_id = ?').run(lid);
      d.prepare('DELETE FROM sms_outbox WHERE loan_id = ?').run(lid);
      files.removeOwner('loan', lid);
      for (const iid of itemIds) {
        const other = d.prepare('SELECT 1 FROM loan_items WHERE item_id = ?').get(iid);
        if (!other) {
          d.prepare('DELETE FROM item_movements WHERE item_id = ?').run(iid);
          d.prepare('DELETE FROM car_viewings WHERE item_id = ?').run(iid);
          d.prepare('DELETE FROM stock_count_lines WHERE item_id = ?').run(iid);
          files.removeOwner('item', iid);
          d.prepare('DELETE FROM items WHERE id = ?').run(iid);
        }
      }
      d.prepare('DELETE FROM loans WHERE id = ?').run(lid);
      d.prepare('DELETE FROM archive WHERE id = ?').run(a.id);
      d.prepare('INSERT INTO deletion_log(loan_no, deleted_on) VALUES (?, ?)').run(a.loan_no, onDate);
      audit.log(ctx, 'permanent_delete', 'loan', a.loan_no, null, { retention_ended: a.delete_after });
    })();
  }
  // Audit entries older than the retention period are removed too (the database trigger blocks anything younger).
  try { d.prepare("DELETE FROM audit_log WHERE ts <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)").run(`-${Math.max(7, settings.get('retention_years'))} years`); } catch { /* trigger guard */ }
  return due.length;
}

module.exports = { CLOSED, eligibility, snapshot, archive, restore, searchArchive, expiringSoon, runExpiry, runRetention, decrypt };
