'use strict';
const express = require('express');
const db = require('../db');
const dates = require('../lib/dates');
const audit = require('../lib/audit');
const archive = require('../services/archive');
const loans = require('../services/loans');
const settings = require('../services/settings');
const { archivedLoanToPdf } = require('../lib/export');
const { Forbidden, NotFound } = require('../lib/errors');

const r = express.Router();
// Archive access is read-only and for Admin and CRO only.
r.use((req, res, next) => (['admin', 'cro'].includes(req.user.role) ? next() : next(new Forbidden('Loan Officers cannot see the archive.'))));

r.get('/', (req, res) => {
  res.render('archive/search', { title: 'Archive', list: archive.searchArchive(req.query.q), q: req.query.q || '' });
});
r.get('/expiring', (req, res) => {
  res.render('archive/expiring', { title: 'Expiring loans', list: archive.expiringSoon(dates.today()) });
});
r.get('/deleted', (req, res) => {
  res.render('archive/deleted', { title: 'Deletion log', list: db.get().prepare('SELECT * FROM deletion_log ORDER BY id DESC LIMIT 500').all() });
});

function byLoan(id) {
  const a = db.get().prepare('SELECT * FROM archive WHERE loan_id = ? ORDER BY id DESC LIMIT 1').get(id);
  if (!a) throw new NotFound('No archive record for this loan.');
  return a;
}
r.get('/loan/:id', (req, res) => {
  const a = byLoan(req.params.id);
  const snap = JSON.parse(a.snapshot);
  audit.log(req.ctx(), 'view_archive', 'loan', a.loan_id);
  const by = a.archived_by ? db.get().prepare('SELECT full_name FROM users WHERE id = ?').get(a.archived_by).full_name : 'Nightly expiry check';
  res.render('archive/view', { title: `Archived loan ${a.loan_no}`, a, snap, by, live: db.get().prepare('SELECT archived, status FROM loans WHERE id = ?').get(a.loan_id) });
});
r.get('/loan/:id/pdf', async (req, res) => {
  const a = byLoan(req.params.id);
  audit.log(req.ctx(), 'export_archive_pdf', 'loan', a.loan_id);
  const pdf = await archivedLoanToPdf(JSON.parse(a.snapshot), a, settings.get('lender_name'), (s) => loans.STATUS[s] || s);
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="loan-${a.loan_no}-archive.pdf"`);
  res.send(pdf);
});
r.post('/:id/restore', (req, res) => {
  if (req.user.role !== 'admin') throw new Forbidden('Only the Admin can restore archived loans.');
  const a = db.get().prepare('SELECT * FROM archive WHERE id = ?').get(req.params.id);
  archive.restore(req.ctx(), Number(req.params.id), req.body.reason);
  res.flash('success', 'Loan restored to the active system. It will not be re-archived automatically until the Admin archives it again.');
  res.redirect(`/loans/${a.loan_id}`);
});

module.exports = r;
