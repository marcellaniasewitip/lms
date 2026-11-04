'use strict';
const db = require('../db');
const dates = require('../lib/dates');
const money = require('../lib/money');
const { decrypt, mask } = require('../lib/crypto');
const { Forbidden } = require('../lib/errors');
const loans = require('./loans');
const items = require('./items');
const aml = require('./aml');

const LIST = [
  { key: 'daily', title: 'Daily report', desc: 'Loans released, payments collected by channel, cash on hand, items in and out — by branch and Loan Officer.' },
  { key: 'portfolio', title: 'Portfolio', desc: 'Amount lent and outstanding, number of active loans, average loan, spread of weekly rates — by branch.' },
  { key: 'maturity', title: 'Maturity list', desc: 'Loans maturing this week and next, and loans now in grace.' },
  { key: 'stock', title: 'Item stock', desc: 'Every item held, by category, branch and store location, with assessed value against the amount owed.' },
  { key: 'forfeitures', title: 'Forfeitures and sales', desc: 'Items forfeited, sale prices, surplus or shortfall, days from forfeiture to sale.' },
  { key: 'risk', title: 'Risk (CRO)', desc: 'Share of loans redeemed against forfeited, by item category and brand, and by weekly rate.', roles: ['admin', 'cro'] },
  { key: 'customer', title: 'Customer statement', desc: 'Statement of account and loan history for one customer.' },
  { key: 'expiry', title: 'Expiry and archive', desc: 'Loans closed, archived and permanently deleted.' },
  { key: 'aml', title: 'Regulatory and AML', desc: 'Customer identity records and suspicious transactions flagged.', roles: ['admin', 'cro'] },
];

// Loan Officers see their own customers only; Admin and CRO see everything.
function scope(ctx, alias = 'l') {
  if (ctx.user.role === 'loan_officer') return { sql: ` AND ${alias}.loan_officer_id = ${Number(ctx.user.id)}`, own: true };
  return { sql: '', own: false };
}
function branchFilter(p, alias = 'l') { return p.branch_id ? ` AND ${alias}.branch_id = ${Number(p.branch_id)}` : ''; }
function range(p) {
  const t = dates.today();
  return { from: dates.parse(p.from) || dates.addDays(t, -30), to: dates.parse(p.to) || t };
}
const M = (key, label) => ({ key, label, type: 'money' });
const D = (key, label) => ({ key, label, type: 'date' });
const T = (key, label) => ({ key, label });

function daily(ctx, p) {
  const d = db.get();
  const day = dates.parse(p.date) || dates.today();
  const sc = scope(ctx).sql + branchFilter(p);
  const released = d.prepare(`SELECT l.loan_no, b.name branch, u.full_name officer, l.amount_released, l.weekly_rate, l.release_channel
    FROM loans l JOIN branches b ON b.id = l.branch_id JOIN users u ON u.id = l.loan_officer_id WHERE l.release_date = ? ${sc} ORDER BY b.name, u.full_name`).all(day);
  // posted_at is UTC; keep payments whose PNG-local date is the day.
  const paysLocal = d.prepare(`SELECT p.*, b.name branch, u.full_name officer FROM payments p JOIN loans l ON l.id = p.loan_id JOIN branches b ON b.id = l.branch_id
    JOIN users u ON u.id = p.posted_by WHERE p.posted_at >= ? AND p.posted_at < ? ${sc}`).all(dates.addDays(day, -1) + 'T14:00:00', day + 'T14:00:00');
  const byChannel = {};
  for (const x of paysLocal) {
    const k = `${x.branch}|${x.officer}|${x.channel}`;
    byChannel[k] = byChannel[k] || { branch: x.branch, officer: x.officer, channel: loans.CHANNELS[x.channel], n: 0, total: 0 };
    byChannel[k].n++; byChannel[k].total += x.amount;
  }
  const cashIn = paysLocal.filter((x) => x.channel === 'cash').reduce((s, x) => s + x.amount, 0);
  const cashOut = released.filter((x) => x.release_channel === 'cash').reduce((s, x) => s + x.amount_released, 0);
  const refundsCash = d.prepare("SELECT COALESCE(SUM(r.amount),0) s FROM refunds r JOIN loans l ON l.id = r.loan_id WHERE r.channel = 'cash' AND r.paid_at >= ? AND r.paid_at < ?" + sc)
    .get(dates.addDays(day, -1) + 'T14:00:00', day + 'T14:00:00').s;
  const itemsIn = d.prepare(`SELECT i.item_no, i.category, i.brand_name || ' ' || i.model AS item, b.name branch, i.location FROM items i JOIN branches b ON b.id = i.branch_id
    WHERE i.date_in = ? ${p.branch_id ? 'AND i.branch_id = ' + Number(p.branch_id) : ''} ${ctx.user.role === 'loan_officer' ? 'AND i.received_by = ' + ctx.user.id : ''}`).all(day);
  const itemsOut = d.prepare(`SELECT i.item_no, i.category, i.brand_name || ' ' || i.model AS item, m.to_status, m.reason FROM item_movements m JOIN items i ON i.id = m.item_id
    WHERE m.to_status IN ('returned','sold','handed_back') AND m.moved_at >= ? AND m.moved_at < ? ${p.branch_id ? 'AND i.branch_id = ' + Number(p.branch_id) : ''}`)
    .all(dates.addDays(day, -1) + 'T14:00:00', day + 'T14:00:00');
  return {
    title: `Daily report — ${dates.fmt(day)}`,
    sections: [
      { title: 'Loans released', columns: [T('loan_no', 'Loan'), T('branch', 'Branch'), T('officer', 'Loan Officer'), M('amount_released', 'Amount'), { key: 'weekly_rate', label: 'Rate %' }, T('release_channel', 'Paid out by')], rows: released },
      { title: 'Payments collected by channel', columns: [T('branch', 'Branch'), T('officer', 'Loan Officer'), T('channel', 'Channel'), { key: 'n', label: 'Payments' }, M('total', 'Total')], rows: Object.values(byChannel) },
      { title: 'Cash on hand movement', columns: [T('what', 'Item'), M('amount', 'Amount')], rows: [
        { what: 'Cash payments received', amount: cashIn }, { what: 'Cash loans paid out', amount: -cashOut },
        { what: 'Cash refunds and surplus paid', amount: -refundsCash }, { what: 'Net cash movement for the day', amount: cashIn - cashOut - refundsCash }] },
      { title: 'Items in', columns: [T('item_no', 'Tag'), T('category', 'Category'), T('item', 'Item'), T('branch', 'Branch'), T('location', 'Location')], rows: itemsIn },
      { title: 'Items out', columns: [T('item_no', 'Tag'), T('category', 'Category'), T('item', 'Item'), T('to_status', 'Out as'), T('reason', 'Reason')], rows: itemsOut },
    ],
  };
}

function portfolio(ctx, p) {
  const d = db.get();
  const sc = scope(ctx).sql + branchFilter(p);
  const rows = d.prepare(`SELECT b.name branch, COUNT(CASE WHEN l.release_date IS NOT NULL THEN 1 END) loans_released,
    COALESCE(SUM(l.amount_released),0) lent,
    COALESCE(SUM(CASE WHEN l.status IN ('active','in_grace') THEN l.principal_owing + l.interest_owing + l.fees_owing ELSE 0 END),0) outstanding,
    COUNT(CASE WHEN l.status IN ('active','in_grace') THEN 1 END) active_loans,
    COALESCE(AVG(l.amount_released),0) avg_loan
    FROM loans l JOIN branches b ON b.id = l.branch_id WHERE l.release_date IS NOT NULL ${sc} GROUP BY b.name`).all();
  const rates = d.prepare(`SELECT b.name branch, l.weekly_rate rate, COUNT(*) n, SUM(l.amount_released) lent FROM loans l JOIN branches b ON b.id = l.branch_id
    WHERE l.release_date IS NOT NULL ${sc} GROUP BY b.name, l.weekly_rate ORDER BY b.name, l.weekly_rate`).all();
  return {
    title: 'Portfolio',
    sections: [
      { title: 'By branch', columns: [T('branch', 'Branch'), { key: 'loans_released', label: 'Loans released' }, M('lent', 'Amount lent'), M('outstanding', 'Outstanding'), { key: 'active_loans', label: 'Active loans' }, M('avg_loan', 'Average loan')], rows: rows.map((r) => ({ ...r, avg_loan: Math.round(r.avg_loan) })) },
      { title: 'Spread of weekly rates used', columns: [T('branch', 'Branch'), { key: 'rate', label: 'Weekly rate %' }, { key: 'n', label: 'Loans' }, M('lent', 'Amount lent')], rows: rates },
    ],
  };
}

function maturity(ctx, p) {
  const d = db.get();
  const t = dates.today();
  const sc = scope(ctx).sql + branchFilter(p);
  const q = (where, args) => d.prepare(`SELECT l.loan_no, c.given_names || ' ' || c.surname customer, c.mobile, b.name branch, l.maturity_date, l.grace_end_date,
    l.principal_owing + l.interest_owing + l.fees_owing owing, l.status FROM loans l JOIN customers c ON c.id = l.customer_id JOIN branches b ON b.id = l.branch_id
    WHERE l.archived = 0 AND ${where} ${sc} ORDER BY l.maturity_date`).all(...args).map((r) => ({ ...r, status: loans.STATUS[r.status] }));
  const cols = [T('loan_no', 'Loan'), T('customer', 'Customer'), T('mobile', 'Mobile'), T('branch', 'Branch'), D('maturity_date', 'Maturity'), D('grace_end_date', 'Grace end'), M('owing', 'Owing today'), T('status', 'Status')];
  return {
    title: 'Maturity list',
    sections: [
      { title: `Maturing this week (${dates.fmt(t)} – ${dates.fmt(dates.addDays(t, 6))})`, columns: cols, rows: q("l.status = 'active' AND l.maturity_date BETWEEN ? AND ?", [t, dates.addDays(t, 6)]) },
      { title: `Maturing next week (${dates.fmt(dates.addDays(t, 7))} – ${dates.fmt(dates.addDays(t, 13))})`, columns: cols, rows: q("l.status = 'active' AND l.maturity_date BETWEEN ? AND ?", [dates.addDays(t, 7), dates.addDays(t, 13)]) },
      { title: 'Now in grace', columns: cols, rows: q("l.status = 'in_grace'", []) },
    ],
  };
}

function stock(ctx, p) {
  const d = db.get();
  const own = ctx.user.role === 'loan_officer' ? ` AND (l.loan_officer_id = ${ctx.user.id} OR i.received_by = ${ctx.user.id})` : '';
  const rows = d.prepare(`SELECT i.item_no, i.category, i.brand_name || ' ' || i.model item, b.name branch, i.location, i.custody_status,
    l.loan_no, li.assessed_value, CASE WHEN l.status = 'forfeited' THEN l.owing_at_forfeiture ELSE l.principal_owing + l.interest_owing + l.fees_owing END owing
    FROM items i JOIN branches b ON b.id = i.branch_id
    LEFT JOIN loan_items li ON li.item_id = i.id AND li.loan_id = (SELECT MAX(loan_id) FROM loan_items x WHERE x.item_id = i.id)
    LEFT JOIN loans l ON l.id = li.loan_id
    WHERE i.custody_status IN ('in_store','for_sale','missing') ${p.branch_id ? 'AND i.branch_id = ' + Number(p.branch_id) : ''} ${p.category ? `AND i.category = '${p.category.replace(/[^a-z]/g, '')}'` : ''} ${own}
    ORDER BY b.name, i.category, i.location`).all().map((r) => ({ ...r, custody_status: items.CUSTODY_LABEL[r.custody_status], cover: r.owing ? Math.round((r.assessed_value / r.owing) * 100) + '%' : '' }));
  const tot = rows.reduce((a, r) => ({ v: a.v + (r.assessed_value || 0), o: a.o + (r.owing || 0) }), { v: 0, o: 0 });
  return {
    title: 'Item stock',
    sections: [{ title: `${rows.length} items held — assessed ${money.fmt(tot.v)} against ${money.fmt(tot.o)} owed`, columns: [T('item_no', 'Tag'), T('category', 'Category'), T('item', 'Item'), T('branch', 'Branch'),
      T('location', 'Location'), T('custody_status', 'Status'), T('loan_no', 'Loan'), M('assessed_value', 'Assessed value'), M('owing', 'Owed'), T('cover', 'Value / owed')], rows }],
  };
}

function forfeitures(ctx, p) {
  const { from, to } = range(p);
  const sc = scope(ctx).sql + branchFilter(p);
  const rows = db.get().prepare(`SELECT l.loan_no, i.item_no, i.category, i.brand_name || ' ' || i.model item, s.forfeited_on, s.reserve_price, s.sale_date, s.sale_price,
    s.sale_method, s.buyer_name, l.owing_at_forfeiture, l.surplus, l.shortfall, s.status FROM forfeiture_sales s JOIN loans l ON l.id = s.loan_id JOIN items i ON i.id = s.item_id
    WHERE s.forfeited_on BETWEEN ? AND ? ${sc} ORDER BY s.forfeited_on`).all(from, to)
    .map((r) => ({ ...r, days: r.sale_date ? dates.diffDays(r.forfeited_on, r.sale_date) : '' }));
  return {
    title: `Forfeitures and sales — ${dates.fmt(from)} to ${dates.fmt(to)}`,
    sections: [{ title: 'Forfeited items', columns: [T('loan_no', 'Loan'), T('item_no', 'Tag'), T('item', 'Item'), D('forfeited_on', 'Forfeited'), M('owing_at_forfeiture', 'Owed'),
      M('reserve_price', 'Reserve'), D('sale_date', 'Sold'), M('sale_price', 'Sale price'), T('sale_method', 'Method'), T('buyer_name', 'Buyer'), M('surplus', 'Surplus'), M('shortfall', 'Shortfall'), { key: 'days', label: 'Days to sale' }, T('status', 'Status')], rows }],
  };
}

function risk(ctx, p) {
  if (ctx.user.role === 'loan_officer') throw new Forbidden();
  const d = db.get();
  const bf = branchFilter(p);
  const outcome = `SUM(CASE WHEN l.status IN ('redeemed','paid') OR (l.status='archived' AND l.pre_archive_status='redeemed') THEN 1 ELSE 0 END) redeemed,
    SUM(CASE WHEN l.status IN ('forfeited','item_sold') OR (l.status='archived' AND l.pre_archive_status='item_sold') THEN 1 ELSE 0 END) forfeited`;
  const add = (r) => ({ ...r, redeemed_share: r.redeemed + r.forfeited ? Math.round((r.redeemed / (r.redeemed + r.forfeited)) * 100) + '%' : '—' });
  const byBrand = d.prepare(`SELECT i.category, i.brand_name brand, ${outcome} FROM loans l JOIN loan_items li ON li.loan_id = l.id JOIN items i ON i.id = li.item_id
    WHERE l.release_date IS NOT NULL ${bf} GROUP BY i.category, i.brand_name ORDER BY i.category, i.brand_name`).all().map(add);
  const byCat = d.prepare(`SELECT i.category, ${outcome} FROM loans l JOIN loan_items li ON li.loan_id = l.id JOIN items i ON i.id = li.item_id
    WHERE l.release_date IS NOT NULL ${bf} GROUP BY i.category`).all().map(add);
  const byRate = d.prepare(`SELECT l.weekly_rate rate, l.rate_grade grade, ${outcome} FROM loans l WHERE l.release_date IS NOT NULL ${bf} GROUP BY l.weekly_rate, l.rate_grade ORDER BY l.weekly_rate`).all().map(add);
  const cols = [{ key: 'redeemed', label: 'Redeemed' }, { key: 'forfeited', label: 'Forfeited' }, T('redeemed_share', 'Redeemed share')];
  return {
    title: 'Risk — redeemed against forfeited',
    sections: [
      { title: 'By item category', columns: [T('category', 'Category'), ...cols], rows: byCat },
      { title: 'By category and brand', columns: [T('category', 'Category'), T('brand', 'Brand'), ...cols], rows: byBrand },
      { title: 'By weekly rate', columns: [{ key: 'rate', label: 'Weekly rate %' }, T('grade', 'Grade'), ...cols], rows: byRate },
    ],
  };
}

function customer(ctx, p) {
  const d = db.get();
  const c = p.customer_id ? d.prepare('SELECT * FROM customers WHERE id = ?').get(p.customer_id) : null;
  if (!c) return { title: 'Customer statement', needsCustomer: true, sections: [] };
  if (ctx.user.role === 'loan_officer') {
    const mine = d.prepare('SELECT 1 FROM loans WHERE customer_id = ? AND loan_officer_id = ?').get(c.id, ctx.user.id) || c.created_by === ctx.user.id;
    if (!mine) throw new Forbidden('Loan Officers can report on their own customers only.');
  }
  const ls = d.prepare('SELECT * FROM loans WHERE customer_id = ? ORDER BY id').all(c.id);
  const history = ls.map((l) => {
    const its = loans.loanItems(l.id).map((i) => `${i.brand_name} ${i.model}`).join(', ');
    const outcome = { redeemed: 'Redeemed', item_sold: 'Forfeited and sold', forfeited: 'Forfeited', rejected: 'Rejected', cancelled: 'Cancelled' }[l.status === 'archived' ? l.pre_archive_status : l.status] || loans.STATUS[l.status];
    return { loan_no: l.loan_no, amount: l.amount_released || l.requested_amount, release_date: l.release_date, maturity_date: l.maturity_date, date_closed: l.date_closed, item: its, outcome, archived: l.archived ? 'Archived' : '' };
  });
  const tx = [];
  for (const l of ls.filter((x) => x.release_date)) {
    tx.push({ date: l.release_date, loan_no: l.loan_no, what: 'Loan released', debit: l.amount_released, credit: null });
    for (const f of JSON.parse(l.fee_lines || '[]')) tx.push({ date: l.release_date, loan_no: l.loan_no, what: f.name, debit: f.amount, credit: null });
    for (const e of loans.interestEntries(l.id)) tx.push({ date: e.entry_date, loan_no: l.loan_no, what: e.kind === 'weekly' ? `Weekly interest ${e.rate}% on ${money.fmt(e.principal_owed)}` : 'Interest adjustment', debit: e.amount, credit: null });
    for (const pm of loans.payments(l.id)) tx.push({ date: pm.date_received, loan_no: l.loan_no, what: pm.kind === 'reversal' ? pm.reference : `Payment ${pm.receipt_no} (${loans.CHANNELS[pm.channel]})${pm.status === 'reversed' ? ' — reversed' : ''}`, debit: null, credit: pm.amount });
    for (const w of d.prepare("SELECT * FROM waivers WHERE loan_id = ? AND status = 'approved'").all(l.id)) tx.push({ date: w.effective_date, loan_no: l.loan_no, what: `Waiver of ${w.kind}`, debit: null, credit: w.applied_amount ?? w.amount });
  }
  tx.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return {
    title: `Customer statement — ${c.given_names} ${c.surname} (${c.customer_no})`,
    sections: [
      { title: 'Loan history', columns: [T('loan_no', 'Loan'), M('amount', 'Amount'), D('release_date', 'Released'), D('maturity_date', 'Maturity'), D('date_closed', 'Closed'), T('item', 'Item'), T('outcome', 'Outcome'), T('archived', '')], rows: history },
      { title: 'Statement of account', columns: [D('date', 'Date'), T('loan_no', 'Loan'), T('what', 'Details'), M('debit', 'Charged'), M('credit', 'Paid / credited')], rows: tx },
    ],
  };
}

function expiry(ctx, p) {
  const d = db.get();
  const { from, to } = range(p);
  const sc = scope(ctx).sql + branchFilter(p);
  const closed = d.prepare(`SELECT l.loan_no, l.status, l.pre_archive_status, l.date_closed, l.expiry_date, l.archive_date FROM loans l WHERE l.date_closed BETWEEN ? AND ? ${sc} ORDER BY l.date_closed`).all(from, to)
    .map((r) => ({ ...r, status: loans.STATUS[r.status === 'archived' ? r.pre_archive_status : r.status] }));
  const archivedRows = ctx.user.role === 'loan_officer' ? [] : d.prepare(`SELECT a.loan_no, a.archived_at, a.method, a.reason, u.full_name by_name, a.delete_after, a.restored_at FROM archive a LEFT JOIN users u ON u.id = a.archived_by
    WHERE substr(a.archived_at,1,10) BETWEEN ? AND ? ORDER BY a.archived_at`).all(dates.addDays(from, -1), to).map((r) => ({ ...r, by_name: r.by_name || 'Nightly job', archived_at: r.archived_at.slice(0, 10) }));
  const deleted = ctx.user.role === 'loan_officer' ? [] : d.prepare('SELECT * FROM deletion_log WHERE deleted_on BETWEEN ? AND ? ORDER BY deleted_on').all(from, to);
  return {
    title: `Expiry and archive — ${dates.fmt(from)} to ${dates.fmt(to)}`,
    sections: [
      { title: 'Loans closed', columns: [T('loan_no', 'Loan'), T('status', 'Outcome'), D('date_closed', 'Closed'), D('expiry_date', 'Expiry date'), D('archive_date', 'Archived')], rows: closed },
      { title: 'Loans archived', columns: [T('loan_no', 'Loan'), D('archived_at', 'Archived'), T('method', 'How'), T('by_name', 'By'), T('reason', 'Reason'), D('delete_after', 'Delete after'), D('restored_at', 'Restored')], rows: archivedRows },
      { title: 'Permanently deleted (deletion log)', columns: [T('loan_no', 'Loan'), D('deleted_on', 'Deleted')], rows: deleted },
    ],
  };
}

function amlReport(ctx, p) {
  if (ctx.user.role === 'loan_officer') throw new Forbidden();
  const d = db.get();
  const { from, to } = range(p);
  const idRows = d.prepare(`SELECT c.customer_no, c.given_names || ' ' || c.surname name, c.dob, c.citizenship, c.verification_status, t.name id_type, ci.number_enc,
    ci.expiry_date, ci.status, u.full_name checked_by, ci.checked_at FROM customers c JOIN customer_ids ci ON ci.customer_id = c.id JOIN id_types t ON t.id = ci.id_type_id
    LEFT JOIN users u ON u.id = ci.checked_by WHERE substr(c.created_at,1,10) BETWEEN ? AND ? ${p.branch_id ? 'AND c.branch_id = ' + Number(p.branch_id) : ''} ORDER BY c.customer_no`)
    .all(dates.addDays(from, -1), to).map((r) => ({ ...r, id_number: decrypt(r.number_enc), number_enc: undefined, checked_at: r.checked_at ? r.checked_at.slice(0, 10) : '' }));
  const flags = d.prepare(`SELECT f.*, c.customer_no, c.given_names || ' ' || c.surname name, l.loan_no FROM aml_flags f LEFT JOIN customers c ON c.id = f.customer_id
    LEFT JOIN loans l ON l.id = f.loan_id WHERE substr(f.created_at,1,10) BETWEEN ? AND ? ORDER BY f.id`).all(dates.addDays(from, -1), to)
    .map((f) => ({ ...f, type: aml.TYPES[f.type] || f.type, created_at: f.created_at.slice(0, 10) }));
  return {
    title: `Regulatory and AML — ${dates.fmt(from)} to ${dates.fmt(to)}`,
    sections: [
      { title: 'Customer identity records', columns: [T('customer_no', 'Customer'), T('name', 'Name'), D('dob', 'Born'), T('citizenship', 'Citizenship'), T('id_type', 'ID type'), T('id_number', 'ID number'),
        D('expiry_date', 'Expires'), T('status', 'ID check'), T('checked_by', 'Checked by'), D('checked_at', 'Checked'), T('verification_status', 'Profile')], rows: idRows },
      { title: 'Flagged and suspicious transactions', columns: [D('created_at', 'Flagged'), T('type', 'Type'), T('customer_no', 'Customer'), T('name', 'Name'), T('loan_no', 'Loan'),
        T('details', 'Details'), T('status', 'Status'), T('fasu_ref', 'FASU ref'), T('review_note', 'Review note')], rows: flags },
    ],
  };
}

const BUILDERS = { daily, portfolio, maturity, stock, forfeitures, risk, customer, expiry, aml: amlReport };
function build(ctx, key, params) {
  const def = LIST.find((r) => r.key === key);
  if (!def) return null;
  if (def.roles && !def.roles.includes(ctx.user.role)) throw new Forbidden();
  const r = BUILDERS[key](ctx, params);
  r.scopeNote = ctx.user.role === 'loan_officer' ? 'Showing your own customers only.' : '';
  return r;
}

module.exports = { LIST, build, mask };
