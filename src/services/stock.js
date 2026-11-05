'use strict';
// Monthly item stock count: Loan Officers count, the CRO signs off, the Admin reviews.
// Any missing item is reported to the Admin at once.
const db = require('../db');
const dates = require('../lib/dates');
const audit = require('../lib/audit');
const { rule, NotFound } = require('../lib/errors');
const { requireRole, checkBranch, today } = require('../lib/ctx');
const items = require('./items');
const notify = require('./notify');

function get(id) {
  const c = db.get().prepare('SELECT s.*, b.name AS branch_name FROM stock_counts s JOIN branches b ON b.id = s.branch_id WHERE s.id = ?').get(id);
  if (!c) throw new NotFound();
  return c;
}
function lines(id) {
  return db.get().prepare(`SELECT l.*, i.item_no, i.category, i.brand_name, i.model, i.custody_status, i.location FROM stock_count_lines l
    JOIN items i ON i.id = l.item_id WHERE count_id = ? ORDER BY i.location, i.item_no`).all(id);
}
function list(ctx) {
  const b = ctx.user.role === 'admin' ? null : ctx.user.branch_id;
  return db.get().prepare(`SELECT s.*, b.name AS branch_name FROM stock_counts s JOIN branches b ON b.id = s.branch_id
    ${b ? 'WHERE s.branch_id = ?' : ''} ORDER BY s.period DESC, s.id DESC`).all(...(b ? [b] : []));
}

function start(ctx) {
  requireRole(ctx, 'loan_officer');
  const period = dates.monthOf(today(ctx));
  const exists = db.get().prepare('SELECT id FROM stock_counts WHERE branch_id = ? AND period = ?').get(ctx.user.branch_id, period);
  if (exists) return exists.id;
  const d = db.get();
  return d.transaction(() => {
    const id = d.prepare('INSERT INTO stock_counts(branch_id, period, counted_by, started_at) VALUES (?,?,?,?)')
      .run(ctx.user.branch_id, period, ctx.user.id, dates.nowIso()).lastInsertRowid;
    const held = d.prepare("SELECT * FROM items WHERE branch_id = ? AND custody_status IN ('in_store','for_sale','missing')").all(ctx.user.branch_id);
    for (const it of held) d.prepare('INSERT INTO stock_count_lines(count_id, item_id, expected_location) VALUES (?,?,?)').run(id, it.id, it.location);
    audit.log(ctx, 'stock_count_start', 'stock_count', id, null, { period, items: held.length });
    return id;
  })();
}

function save(ctx, id, { found = [], notes = {}, scan }) {
  requireRole(ctx, 'loan_officer');
  const c = get(id);
  checkBranch(ctx, c.branch_id);
  rule(c.status === 'in_progress', 'This count has been submitted.');
  const foundIds = [].concat(found).map(Number);
  const d = db.get();
  for (const l of lines(id)) {
    let f = foundIds.includes(l.id) ? 1 : 0;
    if (scan && String(scan).trim().toUpperCase() === l.item_no) f = 1;
    d.prepare('UPDATE stock_count_lines SET found = ?, note = ? WHERE id = ?').run(f, notes[l.id] || l.note || null, l.id);
  }
}
function scan(ctx, id, tag) {
  requireRole(ctx, 'loan_officer');
  const c = get(id);
  rule(c.status === 'in_progress', 'This count has been submitted.');
  const line = lines(id).find((l) => l.item_no === String(tag || '').trim().toUpperCase());
  rule(line, `Tag ${tag} is not on this count (it may belong to another branch or not be held).`);
  db.get().prepare('UPDATE stock_count_lines SET found = 1 WHERE id = ?').run(line.id);
  return line;
}

function submit(ctx, id) {
  requireRole(ctx, 'loan_officer');
  const c = get(id);
  checkBranch(ctx, c.branch_id);
  rule(c.status === 'in_progress', 'Already submitted.');
  const missing = lines(id).filter((l) => !l.found);
  const d = db.get();
  d.transaction(() => {
    d.prepare("UPDATE stock_counts SET status = 'submitted', submitted_at = ?, missing_count = ? WHERE id = ?").run(dates.nowIso(), missing.length, id);
    for (const m of missing) {
      const it = items.get(m.item_id);
      if (it.custody_status !== 'missing') items.recordMovement(ctx, it, { to_status: 'missing', reason: `Not found at stock count ${c.period}` });
    }
    audit.log(ctx, 'stock_count_submit', 'stock_count', id, null, { missing: missing.map((m) => m.item_no) });
  })();
  notify.inApp({ role: 'cro', branchId: c.branch_id, title: `Stock count ${c.period} ready to sign off`, body: `${missing.length} missing`, link: `/stock/${id}` });
  if (missing.length) {
    notify.inApp({ role: 'admin', title: `MISSING ITEMS at ${c.branch_name}`, body: `${missing.map((m) => m.item_no).join(', ')} not found at the ${c.period} stock count.`, link: `/stock/${id}` });
  }
}

function signOff(ctx, id, note) {
  requireRole(ctx, 'cro');
  const c = get(id);
  checkBranch(ctx, c.branch_id);
  rule(c.status === 'submitted', 'The count must be submitted by the Loan Officer first.');
  db.get().prepare("UPDATE stock_counts SET status = 'signed_off', cro_id = ?, signed_at = ?, cro_note = ? WHERE id = ?").run(ctx.user.id, dates.nowIso(), note || null, id);
  audit.log(ctx, 'stock_count_signoff', 'stock_count', id, null, { note });
  notify.inApp({ role: 'admin', title: `Stock count ${c.period} signed off at ${c.branch_name}`, body: `${c.missing_count} missing`, link: `/stock/${id}` });
}
function review(ctx, id, note) {
  requireRole(ctx, 'admin');
  const c = get(id);
  rule(c.status === 'signed_off', 'The CRO must sign off first.');
  db.get().prepare("UPDATE stock_counts SET status = 'reviewed', admin_id = ?, reviewed_at = ?, admin_note = ? WHERE id = ?").run(ctx.user.id, dates.nowIso(), note || null, id);
  audit.log(ctx, 'stock_count_review', 'stock_count', id, null, { note });
}
// An item marked missing that is later found goes back into the store.
function markFound(ctx, itemId, binNo) {
  requireRole(ctx, 'cro');
  const it = items.get(itemId);
  rule(it.custody_status === 'missing', 'The item is not marked missing.');
  const loan = it.current_loan_id ? db.get().prepare('SELECT status FROM loans WHERE id = ?').get(it.current_loan_id) : null;
  const bin = String(binNo || '').trim() ? require('./bins').resolve(ctx, binNo, { branchId: it.branch_id, kind: it.category === 'car' ? 'yard' : 'store', itemId: it.id }) : null;
  items.recordMovement(ctx, it, { to_bin_id: bin ? bin.id : null, to_status: loan && loan.status === 'forfeited' ? 'for_sale' : 'in_store', reason: 'Found after being reported missing' });
}

function storeAccess(ctx, { area, action, note }) {
  requireRole(ctx, 'loan_officer', 'cro');
  rule(['store', 'yard', 'safe'].includes(area), 'Choose the store, yard or safe.');
  rule(['open', 'close'].includes(action), 'Choose open or close.');
  db.get().prepare('INSERT INTO store_access(branch_id, area, action, user_id, at, note) VALUES (?,?,?,?,?,?)').run(ctx.user.branch_id, area, action, ctx.user.id, dates.nowIso(), note || null);
  audit.log(ctx, 'store_' + action, 'store_access', area, null, { note });
}
function accessLog(ctx) {
  const b = ctx.user.role === 'admin' ? null : ctx.user.branch_id;
  return db.get().prepare(`SELECT s.*, u.full_name, b.name AS branch_name FROM store_access s JOIN users u ON u.id = s.user_id JOIN branches b ON b.id = s.branch_id
    ${b ? 'WHERE s.branch_id = ?' : ''} ORDER BY s.id DESC LIMIT 200`).all(...(b ? [b] : []));
}

module.exports = { get, lines, list, start, save, scan, submit, signOff, review, markFound, storeAccess, accessLog };
