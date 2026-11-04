'use strict';
const db = require('../db');
const dates = require('../lib/dates');
const money = require('../lib/money');
const seq = require('../lib/seq');
const audit = require('../lib/audit');
const engine = require('../lib/engine');
const names = require('../lib/names');
const { hmac, mask } = require('../lib/crypto');
const { RuleError, NotFound, Forbidden, rule } = require('../lib/errors');
const { requireRole, checkBranch, today } = require('../lib/ctx');
const settings = require('./settings');
const customers = require('./customers');
const items = require('./items');
const files = require('./files');
const notify = require('./notify');
const aml = require('./aml');

const STATUS = {
  draft: 'Draft', submitted: 'Submitted', returned: 'Returned for changes', approved: 'Approved', rejected: 'Rejected',
  cancelled: 'Cancelled', active: 'Active', in_grace: 'In grace', paid: 'Paid – item awaiting collection',
  redeemed: 'Paid and item returned', forfeited: 'Forfeited', item_sold: 'Item sold', expired: 'Expired', archived: 'Archived',
};
const RELEASED = ['active', 'in_grace', 'paid', 'forfeited'];
const PAYABLE = ['active', 'in_grace'];
const CHANNELS = { cash: 'Cash at the branch', bank: 'Bank deposit', mobile: 'Mobile banking transfer' };

// ---------- basics ----------
function get(id) {
  const l = db.get().prepare('SELECT * FROM loans WHERE id = ?').get(id);
  if (!l) throw new NotFound('Loan not found.');
  return l;
}
function byNo(no) { return db.get().prepare('SELECT * FROM loans WHERE loan_no = ?').get(String(no || '').trim()); }
function terms(l) { return l.terms_snapshot ? JSON.parse(l.terms_snapshot) : null; }
function writable(l) { if (l.archived) throw new RuleError('This loan is archived and read-only. An Admin must restore it first.'); }
function total(l) { return l.principal_owing + l.interest_owing + l.fees_owing; }

function event(ctx, loanId, type, { from = null, to = null, note = null } = {}) {
  db.get().prepare('INSERT INTO loan_events(loan_id, type, from_status, to_status, note, user_id, at) VALUES (?,?,?,?,?,?,?)')
    .run(loanId, type, from, to, note, ctx && ctx.user ? ctx.user.id : null, dates.nowIso());
}
function setStatus(ctx, l, to, note, extra = {}) {
  const cols = Object.keys(extra);
  db.get().prepare(`UPDATE loans SET status = @to, updated_at = @ts ${cols.map((c) => `, ${c} = @${c}`).join('')} WHERE id = @id`)
    .run({ ...extra, to, ts: dates.nowIso(), id: l.id });
  event(ctx, l.id, 'status', { from: l.status, to, note });
  audit.log(ctx, 'loan_status', 'loan', l.id, { status: l.status }, { status: to, note, ...extra });
}

function loanItems(loanId) {
  return db.get().prepare(`SELECT li.*, i.*, li.id AS loan_item_id, i.id AS item_id, u.full_name AS valued_by_name
    FROM loan_items li JOIN items i ON i.id = li.item_id LEFT JOIN users u ON u.id = li.valued_by WHERE li.loan_id = ? ORDER BY li.id`).all(loanId);
}

function notifyCustomer(template, l, vars = {}) {
  const c = customers.get(l.customer_id);
  const branch = db.get().prepare('SELECT name FROM branches WHERE id = ?').get(l.branch_id);
  notify.sms(template, {
    to: c.mobile, language: c.sms_language, customerId: c.id, loanId: l.id,
    vars: { loan: l.loan_no, branch: branch ? branch.name : '', ...vars },
  });
}

function snapshotTerms() {
  const s = settings.all();
  return {
    term_months: s.term_months, grace_days: s.grace_days, expiry_days: s.expiry_days, min_loan: s.min_loan, rate_options: s.rate_options,
    grades: settings.grades(), ticket_terms: s.ticket_terms, pledger_confirmations: s.pledger_confirmations,
    rights_obligations: s.rights_obligations, disclosure_extra: s.disclosure_extra, lender_name: s.lender_name,
    lender_slogan: s.lender_slogan, surplus_payment_days: s.surplus_payment_days, taken_at: dates.nowIso(),
  };
}

// ---------- application ----------
function validateItems(ctx, customerId, itemIds, loanId = 0) {
  rule(itemIds.length > 0, 'Choose at least one item to secure the loan.');
  const avail = items.available(customerId).map((i) => i.id);
  const mine = loanId ? loanItems(loanId).map((i) => i.item_id) : [];
  for (const id of itemIds) {
    if (!avail.includes(id) && !mine.includes(id)) throw new RuleError('One of the chosen items is not in the store for this customer or is already pledged on another open loan (renewals are not allowed).');
  }
}

function createApplication(ctx, { customer_id, item_ids, requested_amount }) {
  requireRole(ctx, 'loan_officer');
  const on = today(ctx);
  const c = customers.get(customer_id);
  checkBranch(ctx, c.branch_id);
  const ready = customers.loanReadiness(c.id, on);
  if (!ready.ok) throw new RuleError('A loan cannot be created for this customer yet.', ready.reasons);
  const ids = [].concat(item_ids || []).map(Number).filter(Boolean);
  validateItems(ctx, c.id, ids);
  const amount = money.parse(requested_amount);
  rule(amount !== null && amount >= settings.get('min_loan'), `The amount asked for must be at least ${money.fmt(settings.get('min_loan'))}.`);
  const d = db.get();
  return d.transaction(() => {
    const loanNo = seq.loanNo();
    const info = d.prepare(`INSERT INTO loans(loan_no, customer_id, branch_id, loan_officer_id, status, requested_amount, application_date, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(loanNo, c.id, c.branch_id, ctx.user.id, 'draft', amount, on, ctx.user.id, dates.nowIso(), dates.nowIso());
    const id = info.lastInsertRowid;
    setLoanItems(id, loanNo, ids);
    event(ctx, id, 'status', { to: 'draft', note: 'Application created' });
    audit.log(ctx, 'create', 'loan', id, null, { loan_no: loanNo, customer_id: c.id, items: ids, requested_amount: amount });
    return id;
  })();
}

function setLoanItems(loanId, loanNo, ids) {
  const d = db.get();
  const keep = d.prepare('SELECT item_id FROM loan_items WHERE loan_id = ?').all(loanId).map((r) => r.item_id);
  for (const k of keep) if (!ids.includes(k)) d.prepare('DELETE FROM loan_items WHERE loan_id = ? AND item_id = ?').run(loanId, k);
  for (const i of ids) if (!keep.includes(i)) d.prepare('INSERT INTO loan_items(loan_id, item_id) VALUES (?, ?)').run(loanId, i);
  // Schedule 1 item number = contract number (with /2, /3 ... when several items share one ticket).
  const rows = d.prepare('SELECT id FROM loan_items WHERE loan_id = ? ORDER BY id').all(loanId);
  rows.forEach((r, n) => d.prepare('UPDATE loan_items SET schedule_no = ? WHERE id = ?').run(rows.length === 1 || n === 0 ? loanNo : `${loanNo}/${n + 1}`, r.id));
}

function updateApplication(ctx, loanId, { item_ids, requested_amount }) {
  requireRole(ctx, 'loan_officer');
  const l = get(loanId);
  writable(l); checkBranch(ctx, l.branch_id);
  rule(['draft', 'returned'].includes(l.status), 'Only a draft or returned application can be changed.');
  const ids = [].concat(item_ids || []).map(Number).filter(Boolean);
  validateItems(ctx, l.customer_id, ids, l.id);
  const amount = money.parse(requested_amount);
  rule(amount !== null && amount >= settings.get('min_loan'), `The amount asked for must be at least ${money.fmt(settings.get('min_loan'))}.`);
  db.get().transaction(() => {
    db.get().prepare('UPDATE loans SET requested_amount = ?, updated_at = ? WHERE id = ?').run(amount, dates.nowIso(), l.id);
    setLoanItems(l.id, l.loan_no, ids);
    audit.log(ctx, 'update', 'loan', l.id, { requested_amount: l.requested_amount }, { requested_amount: amount, items: ids });
  })();
}

function submit(ctx, loanId) {
  requireRole(ctx, 'loan_officer');
  const l = get(loanId);
  writable(l); checkBranch(ctx, l.branch_id);
  rule(['draft', 'returned'].includes(l.status), 'Only a draft or returned application can be submitted.');
  const ready = customers.loanReadiness(l.customer_id, today(ctx));
  if (!ready.ok) throw new RuleError('The application cannot be submitted.', ready.reasons);
  rule(loanItems(l.id).length > 0, 'Add at least one item.');
  setStatus(ctx, l, 'submitted', 'Sent to the CRO for valuation and decision', { submitted_at: dates.nowIso() });
  notify.inApp({ role: 'cro', branchId: l.branch_id, title: `New application ${l.loan_no} waiting for valuation`, body: `Requested ${money.fmt(l.requested_amount)}`, link: `/loans/${l.id}` });
}

function cancel(ctx, loanId, reason) {
  requireRole(ctx, 'loan_officer');
  const l = get(loanId);
  writable(l); checkBranch(ctx, l.branch_id);
  rule(['draft', 'submitted', 'returned', 'approved'].includes(l.status), 'Only an application not yet released can be cancelled.');
  rule(reason, 'Give a reason for cancelling.');
  setStatus(ctx, l, 'cancelled', reason);
}

// ---------- CRO valuation and decision ----------
function valuate(ctx, loanId, itemId, data, faultPhotos = []) {
  requireRole(ctx, 'cro');
  const l = get(loanId);
  writable(l); checkBranch(ctx, l.branch_id);
  rule(l.status === 'submitted', 'Items are valued while the application is submitted.');
  const li = loanItems(l.id).find((x) => x.item_id === Number(itemId));
  if (!li) throw new NotFound('Item is not on this application.');
  const cat = items.CATEGORIES[li.category];
  const errs = [];
  const checklist = {};
  for (const [n, check] of cat.inspection.entries()) {
    const v = data[`check_${n}`];
    if (!['ok', 'fault'].includes(v)) errs.push(`Checklist: mark "${check}" as OK or fault.`);
    checklist[check] = { result: v, note: data[`note_${n}`] || '' };
    if (v === 'fault' && !data[`note_${n}`]) errs.push(`Describe the fault found for "${check}".`);
  }
  const hasFault = Object.values(checklist).some((x) => x.result === 'fault');
  if (hasFault && !faultPhotos.length && !files.list('item', li.item_id, 'fault_photo').length) errs.push('Every fault found must be photographed: add fault photos.');
  const g = settings.grade(data.grade);
  if (!g) errs.push('Choose a quality grade.');
  const market = money.parse(data.market_value), repair = money.parse(data.repair_cost || '0');
  if (market === null || market <= 0) errs.push('Market (resale) value is required.');
  if (repair === null || repair < 0) errs.push('Cost of fixing faults must be zero or more.');
  const c = customers.get(l.customer_id);
  const ownerCmp = names.compare(customers.fullName(c), li.owner_name);
  if (!data.ownership_verified) errs.push('Confirm you have checked the proof of ownership.');
  if (ownerCmp === 'mismatch') errs.push(`The owner on the proof of ownership ("${li.owner_name}") does not match the customer's IDs.`);
  if (ownerCmp === 'flagged' && !data.ownership_note) errs.push('The owner name differs slightly from the IDs: add a note explaining why you accept it.');
  if (errs.length) throw new RuleError('The valuation is not complete.', errs);
  const assessed = Math.max(0, market - repair);
  const share = g.accepted ? g.share_pct : 0;
  const maxLoan = Math.floor((assessed * share) / 100);
  db.get().transaction(() => {
    db.get().prepare(`UPDATE loan_items SET checklist = ?, inspection_faults = ?, grade = ?, market_value = ?, repair_cost = ?, assessed_value = ?,
      share_pct = ?, max_loan = ?, rate_min = ?, rate_max = ?, ownership_verified = 1, ownership_note = ?, valued_by = ?, valued_at = ? WHERE id = ?`)
      .run(JSON.stringify(checklist), hasFault ? 'yes' : 'no', g.grade, market, repair, assessed, share, maxLoan, g.rate_min, g.rate_max,
        data.ownership_note || null, ctx.user.id, dates.nowIso(), li.loan_item_id);
    files.storeUploads(faultPhotos, { ownerType: 'item', ownerId: li.item_id, kind: 'fault_photo', userId: ctx.user.id, caption: `Loan ${l.loan_no} inspection` });
    audit.log(ctx, 'valuation', 'loan_item', li.loan_item_id, { grade: li.grade, assessed_value: li.assessed_value },
      { grade: g.grade, market_value: market, repair_cost: repair, assessed_value: assessed, share_pct: share, max_loan: maxLoan });
  })();
  return { assessed, maxLoan, grade: g };
}

function limits(loanId) {
  const lis = loanItems(loanId);
  const valued = lis.every((x) => x.valued_at);
  const maxTotal = lis.reduce((s, x) => s + (x.max_loan || 0), 0);
  const assessedTotal = lis.reduce((s, x) => s + (x.assessed_value || 0), 0);
  // With several items the rate band of the lowest-graded item applies (the riskiest security).
  const worst = lis.filter((x) => x.grade).map((x) => x.grade).sort().at(-1) || null;
  const band = worst ? settings.grade(worst) : null;
  return { lis, valued, maxTotal, assessedTotal, worst, band };
}

function decide(ctx, loanId, { decision, amount, rate, note }) {
  requireRole(ctx, 'cro');
  const l = get(loanId);
  writable(l); checkBranch(ctx, l.branch_id);
  rule(l.status === 'submitted', 'Only a submitted application can be decided.');
  if (l.created_by === ctx.user.id) throw new Forbidden('No one can approve a loan they created.');
  const on = today(ctx);
  if (decision === 'return' || decision === 'reject') {
    rule(note, decision === 'return' ? 'Say what needs to be fixed.' : 'Give the reason for rejecting.');
    const to = decision === 'return' ? 'returned' : 'rejected';
    setStatus(ctx, l, to, note, { cro_id: ctx.user.id, decision_note: note });
    notifyCustomer(decision === 'return' ? 'app_returned' : 'app_rejected', l);
    notify.inApp({ userId: l.created_by, title: `Application ${l.loan_no} ${to}`, body: note, link: `/loans/${l.id}` });
    return;
  }
  rule(decision === 'approve', 'Unknown decision.');
  const errs = [];
  const ready = customers.loanReadiness(l.customer_id, on);
  errs.push(...ready.reasons);
  // An ID that had expired on the application date is rejected.
  const idsOk = customers.twoIdRule(l.customer_id, l.application_date);
  if (!idsOk.ok) errs.push(...idsOk.reasons.map((r) => `On the application date: ${r}`));
  const lim = limits(l.id);
  if (!lim.valued) errs.push('Every item must be inspected and valued first.');
  if (lim.lis.some((x) => x.grade && !settings.grade(x.grade).accepted)) errs.push('A grade D item cannot be accepted. Return the application so the item can be removed, or reject it.');
  if (lim.lis.some((x) => !x.ownership_verified)) errs.push('Proof of ownership must be verified for every item.');
  const amt = money.parse(amount);
  const r = Number(rate);
  const minLoan = settings.get('min_loan');
  if (amt === null) errs.push('Enter the loan amount.');
  else {
    if (amt < minLoan) errs.push(`The loan must be at least ${money.fmt(minLoan)}.`);
    if (amt > lim.maxTotal) errs.push(`The loan cannot exceed ${money.fmt(lim.maxTotal)}, the allowed share of the assessed value.`);
    if (amt > l.requested_amount) errs.push(`The customer asked for ${money.fmt(l.requested_amount)}; the loan cannot be more than that.`);
  }
  if (!settings.get('rate_options').includes(r)) errs.push('Choose one of the weekly rate options (10% to 20%).');
  else if (lim.band && (r < lim.band.rate_min || r > lim.band.rate_max)) errs.push(`Grade ${lim.worst} allows a weekly rate of ${lim.band.rate_min}% to ${lim.band.rate_max}% only.`);
  if (errs.length) throw new RuleError('The loan cannot be approved.', [...new Set(errs)]);
  const cats = [...new Set(lim.lis.map((x) => x.category))];
  const feeLines = db.get().prepare(`SELECT * FROM fees WHERE active = 1 AND category IN (${cats.map(() => '?').join(',')})`).all(...cats)
    .map((f) => ({ name: f.name, amount: f.amount }));
  const feesTotal = feeLines.reduce((s, f) => s + f.amount, 0);
  setStatus(ctx, l, 'approved', note || `Approved ${money.fmt(amt)} at ${r}% a week (grade ${lim.worst})`, {
    cro_id: ctx.user.id, approved_amount: amt, weekly_rate: r, rate_grade: lim.worst, approval_date: on,
    assessed_value_total: lim.assessedTotal, max_loan_total: lim.maxTotal, ltv_pct: Math.round((amt / lim.assessedTotal) * 1000) / 10,
    fee_lines: JSON.stringify(feeLines), fees_total: feesTotal, terms_snapshot: JSON.stringify(snapshotTerms()), decision_note: note || null,
  });
  audit.log(ctx, 'rate_choice', 'loan', l.id, null, { rate: r, grade: lim.worst, band: lim.band && `${lim.band.rate_min}-${lim.band.rate_max}` });
  notifyCustomer('app_approved', l, { amount: money.fmt(amt), rate: r });
  notify.inApp({ userId: l.created_by, title: `Application ${l.loan_no} approved`, body: `${money.fmt(amt)} at ${r}% a week — ready to release`, link: `/loans/${l.id}` });
  aml.checkRepeatHighValue(ctx, l.customer_id, l.id, on);
}

// ---------- release ----------
function release(ctx, loanId, { channel, reference, agreement_signed }) {
  requireRole(ctx, 'loan_officer');
  const l = get(loanId);
  writable(l); checkBranch(ctx, l.branch_id);
  rule(l.status === 'approved', 'Money can be released only after approval.');
  const on = today(ctx);
  const ready = customers.loanReadiness(l.customer_id, on);
  if (!ready.ok) throw new RuleError('The loan cannot be released.', ready.reasons);
  rule(CHANNELS[channel], 'Choose how the money is paid out.');
  rule(channel === 'cash' || reference, 'A transfer reference is required for bank or mobile payouts.');
  rule(agreement_signed, 'The customer must sign the pledge ticket and Disclosure Statement (showing any fees) before money is released.');
  const t = terms(l);
  const kd = engine.keyDates(on, { termMonths: t.term_months, graceDays: t.grace_days });
  db.get().transaction(() => {
    setStatus(ctx, l, 'active', `Released ${money.fmt(l.approved_amount)} by ${CHANNELS[channel]}`, {
      release_date: on, release_channel: channel, release_ref: reference || null, amount_released: l.approved_amount,
      principal_owing: l.approved_amount, maturity_date: kd.maturity, grace_end_date: kd.graceEnd,
    });
    for (const li of loanItems(l.id)) db.get().prepare('UPDATE items SET current_loan_id = ? WHERE id = ?').run(l.id, li.item_id);
    db.get().prepare("INSERT INTO tickets(loan_id, ticket_no, version, kind, status, printed_by, printed_at) VALUES (?,?,1,'original','active',?,?)")
      .run(l.id, l.loan_no, ctx.user.id, dates.nowIso());
    sync(ctx, l.id, { upTo: on, silent: true });
  })();
  const after = get(l.id);
  notifyCustomer('released', after, { amount: money.fmt(after.amount_released), rate: after.weekly_rate, maturity: dates.fmt(after.maturity_date) });
  aml.checkCash(ctx, { amount: after.amount_released, channel, customerId: l.customer_id, loanId: l.id, what: 'Loan payout' });
}

// ---------- the ledger ----------
function ledgerEvents(loanId) {
  const pays = db.get().prepare("SELECT * FROM payments WHERE loan_id = ? AND kind = 'payment' AND status = 'posted'").all(loanId)
    .map((p) => ({ type: 'payment', id: 'p' + p.id, date: p.date_received, order: Date.parse(p.posted_at) + p.id / 1000, amount: p.amount }));
  const ws = db.get().prepare("SELECT * FROM waivers WHERE loan_id = ? AND status = 'approved'").all(loanId)
    .map((w) => ({ type: 'waiver', id: 'w' + w.id, kind: w.kind, date: w.effective_date, order: Date.parse(w.decided_at) + w.id / 1000, amount: w.amount }));
  return [...pays, ...ws];
}

/**
 * Brings a released loan up to date: adds any weekly interest due up to `upTo`, re-applies
 * payments and waivers in date order (so a reversal or a back-dated deposit is handled
 * correctly) and records any correction as an adjustment entry — nothing is ever deleted.
 */
function sync(ctx, loanId, { upTo, silent = false } = {}) {
  const d = db.get();
  let l = get(loanId);
  if (!RELEASED.includes(l.status) && !['redeemed', 'item_sold'].includes(l.status)) return null;
  upTo = upTo || today(ctx);
  const stop = l.forfeited_at || (['redeemed', 'item_sold'].includes(l.status) ? l.date_closed : null);
  const r = engine.replay({
    principal: l.amount_released, rate: l.weekly_rate, releaseDate: l.release_date,
    fees: JSON.parse(l.fee_lines || '[]'), events: ledgerEvents(l.id), upTo, stopDate: stop,
  });
  const newWeekly = [];
  const stored = {};
  for (const e of d.prepare('SELECT * FROM interest_entries WHERE loan_id = ?').all(l.id)) stored[e.entry_date] = (stored[e.entry_date] || 0) + e.amount;
  const ts = dates.nowIso();
  const ins = d.prepare('INSERT INTO interest_entries(loan_id, entry_date, principal_owed, rate, amount, kind, note, created_at) VALUES (?,?,?,?,?,?,?,?)');
  const seen = new Set();
  for (const ch of r.charges) {
    seen.add(ch.date);
    if (stored[ch.date] === undefined) { ins.run(l.id, ch.date, ch.principal, ch.rate, ch.amount, 'weekly', null, ts); newWeekly.push(ch); }
    else if (stored[ch.date] !== ch.amount) ins.run(l.id, ch.date, ch.principal, ch.rate, ch.amount - stored[ch.date], 'adjustment', 'Recalculated after a reversal or back-dated payment', ts);
  }
  for (const [date, amt] of Object.entries(stored)) {
    if (!seen.has(date) && amt !== 0 && date <= upTo) ins.run(l.id, date, 0, l.weekly_rate, -amt, 'adjustment', 'Interest not due after recalculation', ts);
  }
  for (const p of d.prepare("SELECT * FROM payments WHERE loan_id = ? AND kind = 'payment' AND status = 'posted'").all(l.id)) {
    const a = r.allocations['p' + p.id];
    if (a && (a.fees !== p.applied_fees || a.interest !== p.applied_interest || a.principal !== p.applied_principal || a.over !== p.overpayment)) {
      d.prepare('UPDATE payments SET applied_fees = ?, applied_interest = ?, applied_principal = ?, overpayment = ?, balance_after = COALESCE(balance_after, ?) WHERE id = ?')
        .run(a.fees, a.interest, a.principal, a.over, a.balanceAfter, p.id);
    }
  }
  for (const [wid, amt] of Object.entries(r.waiversApplied)) d.prepare('UPDATE waivers SET applied_amount = ? WHERE id = ?').run(amt, wid.slice(1));
  d.prepare(`UPDATE loans SET principal_owing = ?, interest_owing = ?, fees_owing = ?, interest_added = ?, fees_added = ?, total_paid = ?,
    waived_total = ?, next_interest_date = ? WHERE id = ?`).run(r.principal, r.interest, r.fees, r.interestTotal, r.feesTotal, r.paidTotal,
    r.waivedTotal, PAYABLE.includes(l.status) ? r.nextInterest : null, l.id);
  for (const ch of newWeekly) event(ctx, l.id, 'interest', { note: `Week interest ${money.fmt(ch.amount)} on ${money.fmt(ch.principal)} at ${ch.rate}%` });
  l = get(l.id);
  // Status follows the balance.
  if (r.total === 0 && PAYABLE.includes(l.status)) {
    setStatus(ctx, l, 'paid', 'Balance is K0.00 — item ready to collect');
    if (!silent) notifyCustomer('paid_in_full', l);
    notify.inApp({ userId: l.loan_officer_id, title: `Item to return: loan ${l.loan_no}`, body: 'Paid in full — the item can be collected.', link: `/loans/${l.id}` });
  } else if (r.total > 0 && l.status === 'paid') {
    setStatus(ctx, l, upTo >= l.maturity_date ? 'in_grace' : 'active', 'Balance owing again after a reversal');
  }
  l = get(l.id);
  if (!silent && PAYABLE.includes(l.status)) {
    for (const ch of newWeekly.filter((x) => x.date === upTo)) notifyCustomer('interest_added', l, { interest: money.fmt(ch.amount), total: money.fmt(total(l)) });
  }
  return { newWeekly, replay: r };
}

// ---------- payments ----------
function postPayment(ctx, loanId, { amount, channel, reference, date_received, unmatched_id = null }) {
  requireRole(ctx, 'loan_officer');
  const l0 = get(loanId);
  writable(l0); checkBranch(ctx, l0.branch_id);
  rule(PAYABLE.includes(l0.status), `Payments can only be taken on an active or in-grace loan (this loan is ${STATUS[l0.status]}).`);
  const on = today(ctx);
  const amt = money.parse(amount);
  rule(amt !== null && amt > 0, 'Enter the amount received.');
  rule(CHANNELS[channel], 'Choose the payment channel.');
  rule(channel === 'cash' || reference, 'A reference number is required for bank deposits and mobile transfers.');
  const received = date_received ? dates.parse(date_received) : on;
  rule(received, 'Date received must be DD/MM/YYYY.');
  rule(received <= on, 'Date received cannot be in the future.');
  rule(received >= l0.release_date, 'Date received cannot be before the release date.');
  if (reference) {
    const dup = db.get().prepare("SELECT receipt_no FROM payments WHERE reference = ? AND channel = ? AND kind = 'payment' AND status = 'posted'").get(reference, channel);
    rule(!dup, `Reference ${reference} was already posted on receipt ${dup && dup.receipt_no}.`);
  }
  const d = db.get();
  const pid = d.transaction(() => {
    sync(ctx, l0.id, { upTo: on });
    const receipt = seq.receiptNo();
    const info = d.prepare(`INSERT INTO payments(receipt_no, loan_id, amount, channel, reference, date_received, posted_by, posted_at, unmatched_id)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(receipt, l0.id, amt, channel, reference || null, received, ctx.user.id, dates.nowIso(), unmatched_id);
    const id = info.lastInsertRowid;
    sync(ctx, l0.id, { upTo: on, silent: true });
    const l = get(l0.id);
    d.prepare('UPDATE payments SET balance_after = ? WHERE id = ?').run(total(l), id);
    const p = d.prepare('SELECT * FROM payments WHERE id = ?').get(id);
    if (p.overpayment > 0) d.prepare("INSERT INTO refunds(loan_id, payment_id, kind, amount, created_at) VALUES (?,?,'overpayment',?,?)").run(l.id, id, p.overpayment, dates.nowIso());
    event(ctx, l.id, 'payment', { note: `Receipt ${receipt}: ${money.fmt(amt)} by ${CHANNELS[channel]} (fees ${money.fmt(p.applied_fees)}, interest ${money.fmt(p.applied_interest)}, principal ${money.fmt(p.applied_principal)}${p.overpayment ? `, overpaid ${money.fmt(p.overpayment)} to refund` : ''})` });
    audit.log(ctx, 'payment', 'payment', id, null, { receipt, loan_no: l.loan_no, amount: amt, channel, reference, date_received: received });
    notifyCustomer('payment_received', l, { amount: money.fmt(amt), receipt, total: money.fmt(total(l)) });
    if (l.status === 'paid') notifyCustomer('paid_in_full', l);
    aml.checkCash(ctx, { amount: amt, channel, customerId: l.customer_id, loanId: l.id, paymentId: id, what: 'Loan repayment' });
    return id;
  })();
  return pid;
}

function payments(loanId) {
  return db.get().prepare('SELECT p.*, u.full_name AS posted_by_name FROM payments p LEFT JOIN users u ON u.id = p.posted_by WHERE loan_id = ? ORDER BY p.id').all(loanId);
}
function payment(id) {
  const p = db.get().prepare('SELECT * FROM payments WHERE id = ?').get(id);
  if (!p) throw new NotFound('Payment not found.');
  return p;
}

// Reversals: Loan Officer requests, Admin approves; a reversal is a new entry, never a deletion.
function requestReversal(ctx, paymentId, reason) {
  requireRole(ctx, 'loan_officer');
  const p = payment(paymentId);
  const l = get(p.loan_id);
  writable(l); checkBranch(ctx, l.branch_id);
  rule(p.kind === 'payment' && p.status === 'posted', 'Only a posted payment can be reversed.');
  rule(!['redeemed', 'item_sold'].includes(l.status), 'The item has already left the store; this payment cannot be reversed here.');
  rule(reason, 'Give a reason for the reversal.');
  const pending = db.get().prepare("SELECT 1 FROM reversal_requests WHERE payment_id = ? AND status = 'pending'").get(p.id);
  rule(!pending, 'A reversal for this payment is already waiting for approval.');
  const info = db.get().prepare('INSERT INTO reversal_requests(payment_id, loan_id, reason, requested_by, requested_at) VALUES (?,?,?,?,?)')
    .run(p.id, l.id, reason, ctx.user.id, dates.nowIso());
  event(ctx, l.id, 'reversal_requested', { note: `Receipt ${p.receipt_no}: ${reason}` });
  audit.log(ctx, 'reversal_request', 'payment', p.id, null, { reason });
  notify.inApp({ role: 'admin', title: `Reversal to approve: receipt ${p.receipt_no}`, body: `${money.fmt(p.amount)} on loan ${l.loan_no}: ${reason}`, link: '/payments/reversals' });
  return info.lastInsertRowid;
}

function decideReversal(ctx, requestId, { approve, note }) {
  requireRole(ctx, 'admin');
  const rq = db.get().prepare('SELECT * FROM reversal_requests WHERE id = ?').get(requestId);
  if (!rq) throw new NotFound();
  rule(rq.status === 'pending', 'This request has already been decided.');
  rule(rq.requested_by !== ctx.user.id, 'The person who requested a reversal cannot approve it.');
  const p = payment(rq.payment_id);
  const l = get(p.loan_id);
  writable(l);
  const d = db.get();
  d.transaction(() => {
    d.prepare('UPDATE reversal_requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?')
      .run(approve ? 'approved' : 'rejected', ctx.user.id, dates.nowIso(), note || null, rq.id);
    if (approve) {
      rule(!['redeemed', 'item_sold'].includes(l.status), 'The item has already left the store; this payment cannot be reversed.');
      d.prepare("UPDATE payments SET status = 'reversed' WHERE id = ?").run(p.id);
      d.prepare(`INSERT INTO payments(receipt_no, loan_id, amount, channel, reference, date_received, posted_by, posted_at, kind, reversal_of)
        VALUES (?,?,?,?,?,?,?,?, 'reversal', ?)`).run(seq.receiptNo(), l.id, -p.amount, p.channel, `Reversal of ${p.receipt_no}`, today(ctx), ctx.user.id, dates.nowIso(), p.id);
      d.prepare("UPDATE refunds SET status = 'paid', channel = 'n/a', reference = 'Cancelled — payment reversed', paid_by = ?, paid_at = ? WHERE payment_id = ? AND status = 'owed'")
        .run(ctx.user.id, dates.nowIso(), p.id);
      sync(ctx, l.id, { upTo: today(ctx), silent: true });
      event(ctx, l.id, 'reversal', { note: `Receipt ${p.receipt_no} (${money.fmt(p.amount)}) reversed: ${rq.reason}` });
    }
    audit.log(ctx, approve ? 'reversal_approved' : 'reversal_rejected', 'payment', p.id, { status: p.status }, { status: approve ? 'reversed' : p.status, note });
    notify.inApp({ userId: rq.requested_by, title: `Reversal ${approve ? 'approved' : 'rejected'}: receipt ${p.receipt_no}`, body: note || '', link: `/loans/${l.id}` });
  })();
}

// Waivers: Loan Officer requests, CRO approves, with a written reason.
function requestWaiver(ctx, loanId, { kind, amount, reason }) {
  requireRole(ctx, 'loan_officer', 'cro');
  const l = get(loanId);
  writable(l); checkBranch(ctx, l.branch_id);
  rule(PAYABLE.includes(l.status), 'Waivers apply to active or in-grace loans.');
  rule(['interest', 'fees'].includes(kind), 'Choose interest or fees.');
  const amt = money.parse(amount);
  const owing = kind === 'fees' ? l.fees_owing : l.interest_owing;
  rule(amt !== null && amt > 0, 'Enter the amount to waive.');
  rule(amt <= owing, `Only ${money.fmt(owing)} of ${kind} is owing.`);
  rule(reason, 'A written reason is required.');
  const info = db.get().prepare('INSERT INTO waivers(loan_id, kind, amount, reason, requested_by, requested_at) VALUES (?,?,?,?,?,?)')
    .run(l.id, kind, amt, reason, ctx.user.id, dates.nowIso());
  event(ctx, l.id, 'waiver_requested', { note: `${money.fmt(amt)} of ${kind}: ${reason}` });
  audit.log(ctx, 'waiver_request', 'loan', l.id, null, { kind, amount: amt, reason });
  notify.inApp({ role: 'cro', branchId: l.branch_id, title: `Waiver to approve on loan ${l.loan_no}`, body: `${money.fmt(amt)} of ${kind}: ${reason}`, link: `/loans/${l.id}` });
  return info.lastInsertRowid;
}

function decideWaiver(ctx, waiverId, { approve, note }) {
  requireRole(ctx, 'cro');
  const w = db.get().prepare('SELECT * FROM waivers WHERE id = ?').get(waiverId);
  if (!w) throw new NotFound();
  rule(w.status === 'pending', 'This waiver has already been decided.');
  rule(w.requested_by !== ctx.user.id, 'The person who requested a waiver cannot approve it.');
  const l = get(w.loan_id);
  writable(l); checkBranch(ctx, l.branch_id);
  rule(!approve || PAYABLE.includes(l.status), 'The loan is no longer active.');
  db.get().transaction(() => {
    db.get().prepare('UPDATE waivers SET status = ?, decided_by = ?, decided_at = ?, effective_date = ?, decision_note = ? WHERE id = ?')
      .run(approve ? 'approved' : 'rejected', ctx.user.id, dates.nowIso(), today(ctx), note || null, w.id);
    if (approve) { sync(ctx, l.id, { upTo: today(ctx), silent: true }); event(ctx, l.id, 'waiver', { note: `${money.fmt(w.amount)} of ${w.kind} waived: ${w.reason}` }); }
    audit.log(ctx, approve ? 'waiver_approved' : 'waiver_rejected', 'waiver', w.id, { status: 'pending' }, { status: approve ? 'approved' : 'rejected', note });
  })();
  const after = get(l.id);
  if (approve && after.status === 'paid') notifyCustomer('paid_in_full', after);
}

// ---------- identity at the counter ----------
function checkIdShown(customerId, idRecordId, numberShown, { photoOnly = false, onDate } = {}) {
  const list = customers.ids(customerId);
  const rec = list.find((x) => x.id === Number(idRecordId));
  rule(rec && rec.status === 'accepted', 'Choose one of the IDs the customer registered.');
  if (photoOnly) rule(rec.is_photo_id && rec.type_photo === 'yes', 'A replacement ticket needs a passport, driver\'s licence or other photo ID.');
  if (onDate && rec.expiry_date) rule(rec.expiry_date >= onDate, `The ${rec.type_name} shown expired on ${dates.fmt(rec.expiry_date)}.`);
  rule(hmac(numberShown) === rec.number_hash, 'The ID number shown does not match the ID on file.');
  return rec;
}

// ---------- item return ----------
function returnItems(ctx, loanId, data, uploads = {}) {
  requireRole(ctx, 'loan_officer');
  const l = get(loanId);
  writable(l); checkBranch(ctx, l.branch_id);
  rule(l.status === 'paid', 'An item is returned only when the balance is K0.00.');
  const on = today(ctx);
  sync(ctx, l.id, { upTo: on, silent: true });
  rule(total(get(l.id)) === 0, 'The balance is not K0.00.');
  const errs = [];
  const ticket = currentTicket(l.id);
  if (!data.ticket_presented) errs.push('The pledger must bring the pledge ticket (or get a replacement first).');
  if (data.ticket_no && ticket && String(data.ticket_no).trim() !== ticket.ticket_no) errs.push('The scanned ticket does not match this loan.');
  if (data.collector === 'authorised') {
    if (!data.authorised_name) errs.push('Name of the person collecting is required.');
    if (!uploads.authority || !uploads.authority.length) errs.push('Scan the customer\'s written authority naming the person collecting.');
  }
  if (!data.condition_checked) errs.push('Check the item against the intake photos with the customer.');
  if (!data.signatureDataUrl) errs.push('The person collecting must sign for the item.');
  const lis = loanItems(l.id);
  const tol = settings.get('car_mileage_tolerance_km');
  for (const li of lis.filter((x) => x.category === 'car')) {
    const m = Number(data[`mileage_${li.item_id}`]);
    if (!m && m !== 0) errs.push(`Odometer reading at return is required for ${li.plate}.`);
    else if (m > li.mileage_intake + tol && !data.mileage_note) errs.push(`${li.plate}: odometer shows ${m} km against ${li.mileage_intake} km at intake — explain the difference.`);
  }
  if (errs.length) throw new RuleError('The item cannot be returned yet.', errs);
  const rec = checkIdShown(l.customer_id, data.id_record_id, data.id_number_shown);
  const c = customers.get(l.customer_id);
  const collector = data.collector === 'authorised' ? `${data.authorised_name} (authorised in writing by ${customers.fullName(c)})` : customers.fullName(c);
  const d = db.get();
  d.transaction(() => {
    for (const li of lis) {
      const it = items.get(li.item_id);
      d.prepare(`UPDATE items SET returned_at = ?, returned_to = ?, return_id_shown = ?, return_mileage = ?, return_note = ?, current_loan_id = NULL WHERE id = ?`)
        .run(dates.nowIso(), collector, `${rec.type_name} ${mask(rec.number_last4)}`, li.category === 'car' ? Number(data[`mileage_${li.item_id}`]) : null, data.mileage_note || null, it.id);
      items.recordMovement(ctx, it, { to_location: 'Collected by customer', to_status: 'returned', reason: `Loan ${l.loan_no} paid in full; collected by ${collector}` });
      items.deletePassword(ctx, it, 'Item returned to customer');
    }
    files.storeDataUrl({ ownerType: 'loan', ownerId: l.id, kind: 'return_signature', dataUrl: data.signatureDataUrl, userId: ctx.user.id });
    if (uploads.authority) files.storeUploads(uploads.authority, { ownerType: 'loan', ownerId: l.id, kind: 'collection_authority', userId: ctx.user.id });
    const exp = dates.addDays(on, (terms(l) || {}).expiry_days || settings.get('expiry_days'));
    setStatus(ctx, l, 'redeemed', `Item returned to ${collector}`, { date_closed: on, expiry_date: exp });
    d.prepare("UPDATE tickets SET status = 'redeemed' WHERE loan_id = ? AND status IN ('active','expired')").run(l.id);
  })();
}

// Rejected or cancelled applications: the item goes back to the customer before the loan can close.
function handBack(ctx, loanId, data) {
  requireRole(ctx, 'loan_officer');
  const l = get(loanId);
  writable(l); checkBranch(ctx, l.branch_id);
  rule(['rejected', 'cancelled'].includes(l.status), 'Items are handed back on rejected or cancelled applications.');
  rule(!l.date_closed, 'The items were already handed back.');
  rule(data.signatureDataUrl, 'The customer must sign for the items.');
  const rec = checkIdShown(l.customer_id, data.id_record_id, data.id_number_shown);
  const c = customers.get(l.customer_id);
  const on = today(ctx);
  db.get().transaction(() => {
    for (const li of loanItems(l.id)) {
      const it = items.get(li.item_id);
      if (!['in_store'].includes(it.custody_status)) continue;
      db.get().prepare('UPDATE items SET returned_at = ?, returned_to = ?, return_id_shown = ? WHERE id = ?').run(dates.nowIso(), customers.fullName(c), `${rec.type_name} ${mask(rec.number_last4)}`, it.id);
      items.recordMovement(ctx, it, { to_location: 'Handed back to customer', to_status: 'handed_back', reason: `Application ${l.loan_no} ${l.status}` });
      items.deletePassword(ctx, it, 'Item handed back');
    }
    files.storeDataUrl({ ownerType: 'loan', ownerId: l.id, kind: 'return_signature', dataUrl: data.signatureDataUrl, userId: ctx.user.id });
    const exp = dates.addDays(on, settings.get('expiry_days'));
    db.get().prepare('UPDATE loans SET date_closed = ?, expiry_date = ?, updated_at = ? WHERE id = ?').run(on, exp, dates.nowIso(), l.id);
    event(ctx, l.id, 'items_handed_back', { note: `Handed back to ${customers.fullName(c)}` });
    audit.log(ctx, 'items_handed_back', 'loan', l.id, null, { date_closed: on });
  })();
}

// ---------- tickets ----------
function tickets(loanId) { return db.get().prepare('SELECT * FROM tickets WHERE loan_id = ? ORDER BY version').all(loanId); }
function currentTicket(loanId) {
  return db.get().prepare("SELECT * FROM tickets WHERE loan_id = ? AND status != 'cancelled' ORDER BY version DESC LIMIT 1").get(loanId);
}
function replaceTicket(ctx, loanId, { id_record_id, id_number_shown, reason }) {
  requireRole(ctx, 'loan_officer');
  const l = get(loanId);
  writable(l); checkBranch(ctx, l.branch_id);
  rule([...PAYABLE, 'paid'].includes(l.status), 'A replacement ticket is issued only while the goods are held under the loan.');
  rule(reason, 'Give the reason (for example: ticket lost).');
  const rec = checkIdShown(l.customer_id, id_record_id, id_number_shown, { photoOnly: true, onDate: today(ctx) });
  const cur = currentTicket(l.id);
  db.get().transaction(() => {
    if (cur) db.get().prepare("UPDATE tickets SET status = 'cancelled', cancelled_at = ? WHERE id = ?").run(dates.nowIso(), cur.id);
    db.get().prepare(`INSERT INTO tickets(loan_id, ticket_no, version, kind, status, id_shown, reason, printed_by, printed_at)
      VALUES (?,?,?,'replacement',?,?,?,?,?)`).run(l.id, l.loan_no, (cur ? cur.version : 1) + 1, cur && cur.status === 'expired' ? 'expired' : 'active',
      `${rec.type_name} ${mask(rec.number_last4)}`, reason, ctx.user.id, dates.nowIso());
    event(ctx, l.id, 'ticket_replaced', { note: `Replacement ticket issued (${reason}); old ticket cancelled` });
    audit.log(ctx, 'ticket_replaced', 'loan', l.id, { version: cur && cur.version }, { version: (cur ? cur.version : 1) + 1, reason });
  })();
}
function uploadSignedTicket(ctx, loanId, uploads) {
  requireRole(ctx, 'loan_officer');
  const l = get(loanId);
  writable(l); checkBranch(ctx, l.branch_id);
  rule(uploads && uploads.length, 'Choose the scanned signed ticket.');
  files.storeUploads(uploads, { ownerType: 'loan', ownerId: l.id, kind: 'signed_ticket', userId: ctx.user.id });
  event(ctx, l.id, 'document', { note: 'Signed pledge ticket and Disclosure Statement scanned into the loan' });
  audit.log(ctx, 'upload_signed_ticket', 'loan', l.id);
}

// ---------- forfeiture and sale ----------
function declareForfeit(ctx, loanId, note) {
  requireRole(ctx, 'cro');
  const l0 = get(loanId);
  writable(l0); checkBranch(ctx, l0.branch_id);
  const on = today(ctx);
  rule(l0.status === 'in_grace', 'Only a loan in its grace period can be forfeited.');
  rule(on >= l0.grace_end_date, `The grace period ends on ${dates.fmt(l0.grace_end_date)}; the item cannot be forfeited before then.`);
  const d = db.get();
  d.transaction(() => {
    sync(ctx, l0.id, { upTo: on, silent: true });
    const l = get(l0.id);
    rule(total(l) > 0, 'The loan is fully paid; it cannot be forfeited.');
    setStatus(ctx, l, 'forfeited', note || `Not paid by the grace end date; ${money.fmt(total(l))} owing`, {
      forfeited_at: on, forfeited_by: ctx.user.id, owing_at_forfeiture: total(l), next_interest_date: null,
    });
    for (const li of loanItems(l.id)) {
      const it = items.get(li.item_id);
      items.recordMovement(ctx, it, { to_status: 'for_sale', reason: `Forfeited under loan ${l.loan_no}; reset for sale` });
      items.deletePassword(ctx, it, 'Reset for sale');
      d.prepare('INSERT INTO forfeiture_sales(loan_id, item_id, forfeited_on) VALUES (?,?,?)').run(l.id, it.id, on);
    }
    d.prepare("UPDATE tickets SET status = 'expired' WHERE loan_id = ? AND status = 'active'").run(l.id);
  })();
  notify.inApp({ role: 'admin', title: `Item forfeited, ready for sale: loan ${l0.loan_no}`, body: 'Approve the reserve price to list it at auction.', link: '/sales' });
}

function sale(id) {
  const s = db.get().prepare('SELECT * FROM forfeiture_sales WHERE id = ?').get(id);
  if (!s) throw new NotFound('Sale record not found.');
  return s;
}
function approveReserve(ctx, saleId, { reserve_price }) {
  requireRole(ctx, 'admin');
  const s = sale(saleId);
  rule(['awaiting_reserve', 'approved'].includes(s.status), 'The reserve can only be set before listing.');
  const p = money.parse(reserve_price);
  rule(p !== null && p > 0, 'Enter the reserve price.');
  db.get().prepare("UPDATE forfeiture_sales SET status = 'approved', reserve_price = ?, reserve_approved_by = ?, reserve_approved_at = ? WHERE id = ?")
    .run(p, ctx.user.id, dates.nowIso(), s.id);
  event(ctx, s.loan_id, 'sale', { note: `Reserve price ${money.fmt(p)} approved` });
  audit.log(ctx, 'reserve_approved', 'forfeiture_sale', s.id, { reserve_price: s.reserve_price }, { reserve_price: p });
}
function recordListing(ctx, saleId, { auction_platform, listing_ref, listed_at }) {
  requireRole(ctx, 'admin');
  const s = sale(saleId);
  rule(s.status === 'approved', 'Approve the reserve price before listing.');
  rule(auction_platform && listing_ref, 'Enter the auction website and listing reference.');
  const on = dates.parse(listed_at) || today(ctx);
  db.get().prepare("UPDATE forfeiture_sales SET status = 'listed', auction_platform = ?, listing_ref = ?, listed_at = ? WHERE id = ?").run(auction_platform, listing_ref, on, s.id);
  event(ctx, s.loan_id, 'sale', { note: `Listed at public internet auction: ${auction_platform} (${listing_ref})` });
  audit.log(ctx, 'auction_listed', 'forfeiture_sale', s.id, null, { auction_platform, listing_ref, listed_at: on });
}
function recordAuctionUnsold(ctx, saleId, note) {
  requireRole(ctx, 'admin');
  const s = sale(saleId);
  rule(s.status === 'listed', 'Only a listed item can be marked as not sold at auction.');
  db.get().prepare("UPDATE forfeiture_sales SET auction_result = 'not sold' WHERE id = ?").run(s.id);
  event(ctx, s.loan_id, 'sale', { note: `Did not sell at auction${note ? ': ' + note : ''}; may be sold by other reasonable means` });
  audit.log(ctx, 'auction_unsold', 'forfeiture_sale', s.id, null, { note });
}
function recordSale(ctx, saleId, data) {
  requireRole(ctx, 'admin');
  const s = sale(saleId);
  rule(s.status === 'listed', 'The item must be offered at a public internet auction first.');
  const method = data.sale_method === 'other' ? 'other' : 'auction';
  if (method === 'other') rule(s.auction_result === 'not sold', 'Other means of sale are allowed only after the item did not sell at auction.');
  const price = money.parse(data.sale_price);
  const sd = dates.parse(data.sale_date) || today(ctx);
  const errs = [];
  if (price === null || price <= 0) errs.push('Enter the sale price.');
  if (method === 'auction' && price !== null && price < s.reserve_price) errs.push(`The auction price is below the approved reserve of ${money.fmt(s.reserve_price)}.`);
  if (!data.buyer_name) errs.push('Buyer name is required.');
  if (!data.sale_receipt_no) errs.push('Sale receipt number is required.');
  if (errs.length) throw new RuleError('The sale cannot be recorded.', errs);
  const d = db.get();
  d.transaction(() => {
    d.prepare(`UPDATE forfeiture_sales SET status = 'sold', sale_method = ?, sale_date = ?, sale_price = ?, buyer_name = ?, buyer_contact = ?,
      sale_receipt_no = ?, recorded_by = ?, recorded_at = ? WHERE id = ?`).run(method, sd, price, data.buyer_name, data.buyer_contact || null,
      data.sale_receipt_no, ctx.user.id, dates.nowIso(), s.id);
    const it = items.get(s.item_id);
    items.recordMovement(ctx, it, { to_location: `Sold to ${data.buyer_name}`, to_status: 'sold', reason: `Sale receipt ${data.sale_receipt_no}` });
    const l = get(s.loan_id);
    event(ctx, l.id, 'sale', { note: `${it.item_no} sold for ${money.fmt(price)} to ${data.buyer_name} (${method === 'auction' ? 'auction' : 'other reasonable means'})` });
    audit.log(ctx, 'item_sold', 'forfeiture_sale', s.id, null, { sale_price: price, buyer_name: data.buyer_name, sale_date: sd, method });
    const all = d.prepare('SELECT * FROM forfeiture_sales WHERE loan_id = ?').all(l.id);
    if (all.every((x) => x.status === 'sold')) {
      const saleTotal = all.reduce((a, x) => a + x.sale_price, 0);
      const owed = l.owing_at_forfeiture;
      const surplus = Math.max(0, saleTotal - owed), shortfall = Math.max(0, owed - saleTotal);
      const lastDate = all.map((x) => x.sale_date).sort().at(-1);
      const t = terms(l) || {};
      setStatus(ctx, l, 'item_sold', `Sold for ${money.fmt(saleTotal)} against ${money.fmt(owed)} owed: ${surplus ? 'surplus ' + money.fmt(surplus) : 'shortfall ' + money.fmt(shortfall)}`, {
        sale_total: saleTotal, surplus, shortfall, date_closed: lastDate, expiry_date: dates.addDays(lastDate, t.expiry_days || settings.get('expiry_days')),
      });
      if (surplus > 0) {
        d.prepare("INSERT INTO refunds(loan_id, kind, amount, due_date, created_at) VALUES (?, 'surplus', ?, ?, ?)")
          .run(l.id, surplus, dates.addDays(lastDate, t.surplus_payment_days || settings.get('surplus_payment_days')), dates.nowIso());
        notify.inApp({ role: 'loan_officer', branchId: l.branch_id, title: `Surplus owed to pledger: loan ${l.loan_no}`, body: `${money.fmt(surplus)} must be paid to the pledger (s.19 Pawnbrokers Act 1951).`, link: '/payments/refunds' });
      }
      d.prepare("UPDATE tickets SET status = 'closed' WHERE loan_id = ? AND status IN ('active','expired')").run(l.id);
    }
  })();
}

function payRefund(ctx, refundId, { channel, reference }) {
  requireRole(ctx, 'loan_officer', 'admin');
  const r = db.get().prepare('SELECT * FROM refunds WHERE id = ?').get(refundId);
  if (!r) throw new NotFound();
  rule(r.status === 'owed', 'This refund has already been paid.');
  rule(['cash', 'bank', 'mobile'].includes(channel), 'Choose cash or a transfer to the customer\'s bank account.');
  rule(channel === 'cash' || reference, 'Enter the transfer reference.');
  db.get().prepare("UPDATE refunds SET status = 'paid', channel = ?, reference = ?, paid_by = ?, paid_at = ? WHERE id = ?")
    .run(channel, reference || null, ctx.user.id, dates.nowIso(), r.id);
  event(ctx, r.loan_id, 'refund', { note: `${r.kind === 'surplus' ? 'Sale surplus' : 'Overpayment'} of ${money.fmt(r.amount)} paid to the customer by ${CHANNELS[channel]}` });
  audit.log(ctx, 'refund_paid', 'refund', r.id, { status: 'owed' }, { status: 'paid', channel, reference });
}

// ---------- notes & disputes ----------
function addNote(ctx, loanId, note) {
  const l = get(loanId);
  checkBranch(ctx, l.branch_id); writable(l);
  rule(note, 'Write a note.');
  event(ctx, l.id, 'note', { note });
  audit.log(ctx, 'note', 'loan', l.id, null, { note });
}
function setDispute(ctx, loanId, { open, note }) {
  requireRole(ctx, 'loan_officer', 'cro', 'admin');
  const l = get(loanId);
  writable(l);
  rule(note, 'Describe the dispute or how it was resolved.');
  db.get().prepare('UPDATE loans SET dispute_open = ?, dispute_note = ? WHERE id = ?').run(open ? 1 : 0, note, l.id);
  event(ctx, l.id, open ? 'dispute_opened' : 'dispute_closed', { note });
  audit.log(ctx, open ? 'dispute_opened' : 'dispute_closed', 'loan', l.id, { dispute_open: l.dispute_open }, { dispute_open: open ? 1 : 0, note });
}

function history(loanId) {
  return db.get().prepare('SELECT e.*, u.full_name AS user_name FROM loan_events e LEFT JOIN users u ON u.id = e.user_id WHERE loan_id = ? ORDER BY e.id').all(loanId);
}
function interestEntries(loanId) { return db.get().prepare('SELECT * FROM interest_entries WHERE loan_id = ? ORDER BY entry_date, id').all(loanId); }

// Figures printed on the pledge ticket and Disclosure Statement.
function ticketFigures(l) {
  const amount = l.amount_released || l.approved_amount;
  const release = l.release_date || today();
  const t = terms(l) || snapshotTerms();
  const redemptionDate = l.maturity_date || engine.keyDates(release, { termMonths: t.term_months, graceDays: t.grace_days }).maturity;
  const rp = engine.redemptionPrice({ principal: amount, rate: l.weekly_rate, releaseDate: release, redemptionDate, fees: l.fees_total });
  return { ...rp, amount, release, redemptionDate, graceEnd: l.grace_end_date || dates.addDays(redemptionDate, t.grace_days), terms: t };
}

module.exports = {
  STATUS, RELEASED, PAYABLE, CHANNELS, get, byNo, terms, total, loanItems, limits, createApplication, updateApplication, submit, cancel,
  valuate, decide, release, sync, postPayment, payments, payment, requestReversal, decideReversal, requestWaiver, decideWaiver,
  returnItems, handBack, tickets, currentTicket, replaceTicket, uploadSignedTicket, declareForfeit, sale, approveReserve, recordListing,
  recordAuctionUnsold, recordSale, payRefund, addNote, setDispute, history, interestEntries, ticketFigures, event, setStatus, writable,
  checkIdShown, notifyCustomer,
};
