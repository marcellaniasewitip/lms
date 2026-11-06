'use strict';
const express = require('express');
const bwipjs = require('bwip-js');
const db = require('../db');
const dates = require('../lib/dates');
const loans = require('../services/loans');
const customers = require('../services/customers');
const items = require('../services/items');
const files = require('../services/files');
const settings = require('../services/settings');
const archive = require('../services/archive');
const { checkBranch } = require('../lib/ctx');
const { Forbidden } = require('../lib/errors');

const r = express.Router();
const only = (...roles) => (req, res, next) => (roles.includes(req.user.role) ? next() : next(new Forbidden()));
const back = (req, res, msg) => { res.flash('success', msg); res.redirect(`/loans/${req.params.id}`); };

r.get('/', (req, res) => {
  const u = req.user;
  const where = ['l.archived = 0'];
  const args = {};
  if (u.role !== 'admin') { where.push('l.branch_id = @b'); args.b = u.branch_id; }
  const st = req.query.status;
  if (st === 'open') where.push("l.status IN ('active','in_grace','paid','forfeited')");
  else if (st === 'applications') where.push("l.status IN ('draft','submitted','returned','approved')");
  else if (loans.STATUS[st]) { where.push('l.status = @st'); args.st = st; }
  if (req.query.mine) { where.push('l.loan_officer_id = @me'); args.me = u.id; }
  if (req.query.q) { where.push("(l.loan_no LIKE @q OR UPPER(c.surname || ' ' || c.given_names) LIKE @q OR UPPER(c.given_names || ' ' || c.surname) LIKE @q OR c.customer_no LIKE @q)"); args.q = `%${String(req.query.q).toUpperCase()}%`; }
  const list = db.get().prepare(`SELECT l.*, c.given_names || ' ' || c.surname AS customer_name, c.customer_no, u.full_name AS officer,
    (l.principal_owing + l.interest_owing + l.fees_owing) AS owing FROM loans l JOIN customers c ON c.id = l.customer_id JOIN users u ON u.id = l.loan_officer_id
    WHERE ${where.join(' AND ')} ORDER BY l.id DESC LIMIT 500`).all(args);
  res.render('loans/list', { title: 'Loans', list, st: st || '' });
});

// Redemption counter: scan the barcode on the pledge ticket to see today's amount.
// Redemption counter: scan or type the pawn ticket number (or search by customer name or
// mobile) to see the payoff today, which bin to pull the item from, and take the payment.
r.get('/redeem', (req, res) => {
  const q = String(req.query.ticket || '').trim();
  let loan = null, notFound = false, matches = [];
  if (q) {
    const byTicket = loans.byNo(q.split('/')[0]);
    if (byTicket && !byTicket.archived) {
      checkBranch(req.ctx(), byTicket.branch_id);
      if (loans.PAYABLE.includes(byTicket.status)) loans.sync(req.ctx(), byTicket.id, { upTo: dates.today() });
      loan = loans.get(byTicket.id);
    } else {
      // Not a ticket number: list the open tickets of matching customers.
      const ids = customers.search(req.ctx(), q).map((c) => c.id);
      matches = ids.length ? db.get().prepare(`SELECT l.*, c.given_names || ' ' || c.surname AS customer_name, c.customer_no,
        (l.principal_owing + l.interest_owing + l.fees_owing) AS owing FROM loans l JOIN customers c ON c.id = l.customer_id
        WHERE l.archived = 0 AND l.status IN ('active','in_grace','paid') AND l.customer_id IN (${ids.join(',')}) ORDER BY l.maturity_date`).all() : [];
      notFound = !matches.length;
    }
  }
  res.render('loans/redeem', {
    title: 'Redemption', loan, notFound, matches, q,
    ticket: loan && loans.currentTicket(loan.id), c: loan && customers.get(loan.customer_id),
    lis: loan ? loans.loanItems(loan.id) : [], photo: loan && files.list('customer_photo', loan.customer_id)[0],
    ids: loan ? customers.ids(loan.customer_id).filter((x) => x.status === 'accepted') : [],
  });
});

r.get('/new', only('loan_officer'), (req, res) => {
  const c = customers.get(req.query.customer_id);
  checkBranch(req.ctx(), c.branch_id);
  res.render('loans/new', { title: 'New loan application', c, available: items.available(c.id), readiness: customers.loanReadiness(c.id, dates.today()), loan: null, selected: [] });
});
r.post('/', only('loan_officer'), (req, res) => {
  const id = loans.createApplication(req.ctx(), req.body);
  if (req.body.submit_now) loans.submit(req.ctx(), id);
  res.flash('success', req.body.submit_now ? 'Application submitted to the CRO.' : 'Application saved as draft.');
  res.redirect(`/loans/${id}`);
});

function load(req) {
  const l = loans.get(req.params.id);
  if (l.archived) {
    if (req.user.role === 'loan_officer') throw new Forbidden('This loan is archived. Loan Officers cannot see the archive.');
  }
  checkBranch(req.ctx(), l.branch_id);
  return l;
}

r.get('/:id', (req, res) => {
  let l = load(req);
  if (l.archived) return res.redirect(`/archive/loan/${l.id}`);
  if (loans.PAYABLE.includes(l.status)) { loans.sync(req.ctx(), l.id, { upTo: dates.today() }); l = loans.get(l.id); }
  const d = db.get();
  const c = customers.get(l.customer_id);
  const lim = loans.limits(l.id);
  const user = (id) => (id ? (d.prepare('SELECT full_name FROM users WHERE id = ?').get(id) || {}).full_name : '');
  res.render('loans/view', {
    title: `Loan ${l.loan_no}`, l, c, lim, owing: loans.total(l), terms: loans.terms(l),
    officer: user(l.loan_officer_id), croName: user(l.cro_id),
    payments: loans.payments(l.id), interest: loans.interestEntries(l.id), history: loans.history(l.id), tickets: loans.tickets(l.id),
    waivers: d.prepare('SELECT w.*, u.full_name AS by_name FROM waivers w JOIN users u ON u.id = w.requested_by WHERE loan_id = ? ORDER BY id DESC').all(l.id),
    reversals: d.prepare('SELECT * FROM reversal_requests WHERE loan_id = ?').all(l.id),
    refunds: d.prepare('SELECT * FROM refunds WHERE loan_id = ?').all(l.id),
    sales: d.prepare('SELECT s.*, i.item_no FROM forfeiture_sales s JOIN items i ON i.id = s.item_id WHERE loan_id = ?').all(l.id),
    docs: files.list('loan', l.id), ids: customers.ids(c.id).filter((x) => x.status === 'accepted'),
    readiness: customers.loanReadiness(c.id, dates.today()), available: items.available(c.id),
    eligibility: archive.CLOSED.includes(l.status) ? archive.eligibility(l, dates.today(), { early: true }) : null,
    rateOptions: settings.get('rate_options'), figures: l.weekly_rate ? loans.ticketFigures(l) : null,
    tolerance: settings.get('car_mileage_tolerance_km'),
  });
});

r.post('/:id/update', only('loan_officer'), (req, res) => { loans.updateApplication(req.ctx(), Number(req.params.id), req.body); back(req, res, 'Application updated.'); });
r.post('/:id/submit', only('loan_officer'), (req, res) => { loans.submit(req.ctx(), Number(req.params.id)); back(req, res, 'Submitted to the CRO.'); });
r.post('/:id/cancel', only('loan_officer'), (req, res) => { loans.cancel(req.ctx(), Number(req.params.id), req.body.reason); back(req, res, 'Application cancelled. Hand the items back to the customer.'); });

r.get('/:id/value/:itemId', only('cro'), (req, res) => {
  const l = load(req);
  const li = loans.loanItems(l.id).find((x) => x.item_id === Number(req.params.itemId));
  if (!li) throw new Forbidden('Item is not on this loan.');
  res.render('loans/valuate', {
    title: `Inspect ${li.item_no}`, l, li, cat: items.CATEGORIES[li.category], c: customers.get(l.customer_id), grades: settings.grades(),
    photos: files.list('item', li.item_id), prior: li.checklist ? JSON.parse(li.checklist) : null,
    ownerCheck: require('../lib/names').compare(customers.fullName(customers.get(l.customer_id)), li.owner_name),
  });
});
r.post('/:id/value/:itemId', only('cro'), (req, res) => {
  const v = loans.valuate(req.ctx(), Number(req.params.id), Number(req.params.itemId), req.body, req.filesOf('fault_photos'));
  back(req, res, `Valued: grade ${v.grade.grade}, maximum loan ${require('../lib/money').fmt(v.maxLoan)}.`);
});
r.post('/:id/decide', only('cro'), (req, res) => {
  loans.decide(req.ctx(), Number(req.params.id), req.body);
  back(req, res, { approve: 'Approved.', return: 'Returned to the Loan Officer.', reject: 'Rejected.' }[req.body.decision] || 'Saved.');
});
r.post('/:id/release', only('loan_officer'), (req, res) => {
  loans.release(req.ctx(), Number(req.params.id), req.body);
  res.flash('success', 'Money released. Give the customer their signed copy, and scan the lender\'s signed copy into the loan.');
  res.redirect(`/loans/${req.params.id}`);
});

// Everything printed on the pledge ticket: the company parts come from Settings and Branches
// (always the same); the customer, amounts, signatures and goods come from this loan.
function ticketData(req, l) {
  const ready = l.approved_amount && l.weekly_rate;
  if (!ready) throw new Forbidden('The pledge ticket is available once the loan is approved.');
  const t = loans.currentTicket(l.id);
  const c = customers.get(l.customer_id);
  const branch = db.get().prepare('SELECT * FROM branches WHERE id = ?').get(l.branch_id);
  const officer = db.get().prepare('SELECT full_name FROM users WHERE id = ?').get(l.loan_officer_id);
  const ids = customers.ids(c.id).filter((x) => x.status === 'accepted');
  const primary = ids.find((x) => x.type_use === 'primary') || ids[0];
  const ordered = primary ? [primary, ...ids.filter((x) => x !== primary)].slice(0, 2) : [];
  const lis = loans.loanItems(l.id).map((li) => ({ ...li, password: li.device_password_enc ? (req.user.role === 'cro' ? require('../lib/crypto').decrypt(li.device_password_enc) : 'held on file (shown to the CRO only)') : '—' }));
  return {
    l, c, t, branch, officer: officer && officer.full_name, lis, fig: loans.ticketFigures(l),
    idText: ordered.every((x) => x.number_enc) ? 'ID #: ' + ordered.map((x) => customers.idNumberFor({ user: { role: 'cro' } }, x)).join(' / ')
      : ordered.map((x) => (x.number_enc ? `${x.type_name} ${customers.idNumberFor({ user: { role: 'cro' } }, x)}` : x.type_name)).join(' / '),
    bank: require('../services/settings').companyBank(), current: settings.all(),
  };
}
// Printing or downloading the ticket from an approved loan counts as printing it for signing.
function markForSigning(req, l) {
  if (req.query.print && l.status === 'approved' && ['loan_officer', 'cro'].includes(req.user.role)) loans.markTicketPrinted(req.ctx(), l.id);
}

r.get('/:id/ticket', (req, res) => {
  const l = load(req);
  const data = ticketData(req, l);
  markForSigning(req, l);
  require('../lib/audit').log(req.ctx(), 'print_ticket', 'loan', l.id, null, { version: data.t && data.t.version });
  res.render('print/ticket', { title: `Pledge ticket ${l.loan_no}`, ...data, preview: !l.release_date, autoPrint: !!req.query.print });
});
// The same ticket as a PDF file (to print, email or keep).
r.get('/:id/ticket/pdf', async (req, res) => {
  const l = load(req);
  const data = ticketData(req, l);
  markForSigning(req, l);
  require('../lib/audit').log(req.ctx(), 'download_ticket_pdf', 'loan', l.id, null, { version: data.t && data.t.version });
  const pdf = await require('../lib/ticketPdf').build({ ...data, fd: require('../lib/dates').fmt, K: require('../lib/money').fmt, fmtPhone: (x) => require('../lib/phone').format(x) });
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `${req.query.inline ? 'inline' : 'attachment'}; filename="pledge-ticket-${l.loan_no}.pdf"`);
  res.send(pdf);
});
r.get('/:id/barcode.png', (req, res) => {
  const l = loans.get(req.params.id);
  bwipjs.toBuffer({ bcid: 'code128', text: l.loan_no, scale: 2, height: 10, includetext: true, textxalign: 'center' }, (err, png) => {
    if (err) return res.status(500).end();
    res.set('Content-Type', 'image/png'); res.send(png);
  });
});

r.post('/:id/payments', only('loan_officer'), (req, res) => {
  const pid = loans.postPayment(req.ctx(), Number(req.params.id), req.body);
  const l = loans.get(req.params.id);
  // From the redemption counter: once paid in full, go straight on to pulling the item from its bin.
  if (req.body.redeem && l.status === 'paid') {
    req.session.flash = { success: `Paid in full — receipt ${loans.payment(pid).receipt_no}. Now pull the item from its bin and hand it over.`, receiptUrl: `/loans/${l.id}/receipt/${pid}` };
    return res.redirect(`/loans/${l.id}/return`);
  }
  res.flash('success', l.status === 'paid' ? 'Payment posted — paid in full. The item can now be returned.' : 'Payment posted.');
  res.redirect(`/loans/${req.params.id}/receipt/${pid}`);
});
r.get('/:id/receipt/:pid', (req, res) => {
  const l = load(req);
  const p = loans.payment(req.params.pid);
  if (p.loan_id !== l.id) throw new Forbidden();
  res.render('print/receipt', { title: `Receipt ${p.receipt_no}`, bank: require('../services/settings').companyBank(), l, p, c: customers.get(l.customer_id), branch: db.get().prepare('SELECT * FROM branches WHERE id = ?').get(l.branch_id), postedBy: db.get().prepare('SELECT full_name FROM users WHERE id = ?').get(p.posted_by).full_name, owing: loans.total(l) });
});
r.post('/:id/payments/:pid/reverse', only('loan_officer'), (req, res) => { loans.requestReversal(req.ctx(), Number(req.params.pid), req.body.reason); back(req, res, 'Reversal requested. The Admin must approve it.'); });
r.post('/:id/waivers', only('loan_officer', 'cro'), (req, res) => { loans.requestWaiver(req.ctx(), Number(req.params.id), req.body); back(req, res, 'Waiver requested. A CRO must approve it.'); });
r.post('/:id/waivers/:wid', only('cro'), (req, res) => { loans.decideWaiver(req.ctx(), Number(req.params.wid), { approve: req.body.approve === '1', note: req.body.note }); back(req, res, 'Waiver decided.'); });

r.get('/:id/return', only('loan_officer'), (req, res) => {
  const l = load(req);
  res.render('loans/return', {
    title: `Return item — loan ${l.loan_no}`, l, c: customers.get(l.customer_id), lis: loans.loanItems(l.id),
    ids: customers.ids(l.customer_id).filter((x) => x.status === 'accepted'), photos: (id) => files.list('item', id).filter((f) => f.kind !== 'ownership'),
    scans: Object.fromEntries(customers.ids(l.customer_id).map((x) => [x.id, files.list('customer_id', x.id)])),
    handback: ['rejected', 'cancelled'].includes(l.status), owing: loans.total(l),
  });
});
r.post('/:id/return', only('loan_officer'), (req, res) => {
  const l = loans.get(req.params.id);
  if (['rejected', 'cancelled'].includes(l.status)) loans.handBack(req.ctx(), l.id, { ...req.body, signatureDataUrl: req.body.signature_data });
  else loans.returnItems(req.ctx(), l.id, { ...req.body, signatureDataUrl: req.body.signature_data }, { authority: req.filesOf('authority') });
  res.flash('success', 'Item returned. Print the release slip for the customer to keep.');
  res.redirect(`/loans/${l.id}/slip`);
});
r.get('/:id/slip', (req, res) => {
  const l = load(req);
  res.render('print/slip', { title: `Release slip ${l.loan_no}`, l, c: customers.get(l.customer_id), lis: loans.loanItems(l.id), branch: db.get().prepare('SELECT * FROM branches WHERE id = ?').get(l.branch_id), sig: files.list('loan', l.id, 'return_signature').at(-1) });
});

r.post('/:id/ticket/replace', only('loan_officer'), (req, res) => {
  loans.replaceTicket(req.ctx(), Number(req.params.id), req.body);
  res.flash('success', 'Replacement ticket issued; the old ticket is cancelled. Print it now.');
  res.redirect(`/loans/${req.params.id}/ticket`);
});
r.post('/:id/documents', only('loan_officer'), (req, res) => { loans.uploadSignedTicket(req.ctx(), Number(req.params.id), req.filesOf('signed')); back(req, res, 'Signed ticket scanned into the loan.'); });
r.post('/:id/forfeit', only('cro'), (req, res) => { loans.declareForfeit(req.ctx(), Number(req.params.id), req.body.note); back(req, res, 'Item declared forfeited and moved to for-sale stock. The Admin has been told.'); });
r.post('/:id/notes', (req, res) => { loans.addNote(req.ctx(), Number(req.params.id), req.body.note); back(req, res, 'Note added.'); });
r.post('/:id/dispute', (req, res) => { loans.setDispute(req.ctx(), Number(req.params.id), { open: req.body.open === '1', note: req.body.note }); back(req, res, 'Dispute updated.'); });
r.post('/:id/archive', only('admin'), (req, res) => {
  archive.archive(req.ctx(), Number(req.params.id), { method: 'early', reason: req.body.reason });
  res.flash('success', 'Loan pulled out to the archive.');
  res.redirect(`/archive/loan/${req.params.id}`);
});

module.exports = r;
