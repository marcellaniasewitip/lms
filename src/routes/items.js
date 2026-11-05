'use strict';
const express = require('express');
const bwipjs = require('bwip-js');
const db = require('../db');
const items = require('../services/items');
const files = require('../services/files');
const customers = require('../services/customers');
const { checkBranch } = require('../lib/ctx');
const { Forbidden } = require('../lib/errors');

const r = express.Router();
const only = (...roles) => (req, res, next) => (roles.includes(req.user.role) ? next() : next(new Forbidden()));

r.get('/', (req, res) => {
  const u = req.user;
  const where = [];
  const args = {};
  if (u.role !== 'admin') { where.push('i.branch_id = @b'); args.b = u.branch_id; } else if (req.query.branch_id) { where.push('i.branch_id = @b'); args.b = Number(req.query.branch_id); }
  const status = req.query.status || 'held';
  if (status === 'held') where.push("i.custody_status IN ('in_store','for_sale','missing')");
  else if (items.CUSTODY_LABEL[status]) { where.push('i.custody_status = @s'); args.s = status; }
  if (req.query.category) { where.push('i.category = @c'); args.c = req.query.category; }
  if (req.query.q) { where.push('(i.item_no LIKE @q OR i.vin LIKE @q OR i.serial_no LIKE @q OR i.imei LIKE @q OR i.plate LIKE @q OR i.model LIKE @q OR UPPER(i.location) LIKE @q OR UPPER(i.safe_location) LIKE @q)'); args.q = `%${String(req.query.q).toUpperCase()}%`; }
  const list = db.get().prepare(`SELECT i.*, c.given_names || ' ' || c.surname AS customer_name, b.name AS branch_name, l.loan_no, l.status AS loan_status
    FROM items i JOIN customers c ON c.id = i.customer_id JOIN branches b ON b.id = i.branch_id LEFT JOIN loans l ON l.id = i.current_loan_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.location, i.item_no LIMIT 500`).all(args);
  res.render('items/list', { title: 'Item store', list, status, branches: db.get().prepare('SELECT * FROM branches').all() });
});

r.get('/:id', (req, res) => {
  const it = items.get(req.params.id);
  checkBranch(req.ctx(), it.branch_id);
  const loansFor = db.get().prepare(`SELECT l.*, li.grade, li.assessed_value, li.max_loan, li.schedule_no FROM loan_items li JOIN loans l ON l.id = li.loan_id WHERE li.item_id = ? ORDER BY l.id DESC`).all(it.id);
  // The decrypted device password is shown once, right after the CRO asks for it.
  const password = req.session.revealed && req.session.revealed[it.id];
  delete req.session.revealed;
  const bins = require('../services/bins');
  res.render('items/view', {
    title: `Item ${it.item_no}`, it, branchName: (db.get().prepare('SELECT name FROM branches WHERE id = ?').get(it.branch_id) || {}).name, c: customers.get(it.customer_id), cat: items.CATEGORIES[it.category], movements: items.movements(it.id),
    photos: files.list('item', it.id), viewings: items.viewings(it.id), loans: loansFor.filter((l) => !(l.archived && req.user.role === 'loan_officer')),
    password, minPhotos: require('../services/settings').get('min_item_photos'),
  });
});

r.get('/:id/tag.png', (req, res) => {
  const it = items.get(req.params.id);
  bwipjs.toBuffer({ bcid: 'code128', text: it.item_no, scale: 3, height: 12, includetext: true, textxalign: 'center' }, (err, png) => {
    if (err) return res.status(500).end();
    res.set('Content-Type', 'image/png'); res.send(png);
  });
});
r.get('/:id/tag', (req, res) => {
  const it = items.get(req.params.id);
  res.render('print/tag', { title: `Tag ${it.item_no}`, it, layout: false });
});

r.post('/:id/move', only('loan_officer', 'cro'), (req, res) => {
  items.move(req.ctx(), Number(req.params.id), req.body);
  res.flash('success', 'Movement recorded.');
  res.redirect(`/items/${req.params.id}`);
});
r.post('/:id/password', only('cro'), (req, res) => {
  const pw = items.revealPassword(req.ctx(), Number(req.params.id));
  req.session.revealed = { [req.params.id]: pw || '(none recorded)' };
  res.redirect(`/items/${req.params.id}#password`);
});
r.post('/:id/viewing', only('loan_officer', 'cro'), (req, res) => {
  items.addViewing(req.ctx(), Number(req.params.id), req.body);
  res.flash('success', 'Viewing recorded.');
  res.redirect(`/items/${req.params.id}`);
});
r.post('/:id/reintake', only('loan_officer'), (req, res) => {
  items.reIntake(req.ctx(), Number(req.params.id), req.body, { sides: req.filesOf('photos'), extra: req.filesOf('extra_photo') });
  res.flash('success', 'Item taken in again. It can now go on a new loan application.');
  res.redirect(`/items/${req.params.id}`);
});
r.post('/:id/found', only('cro'), (req, res) => {
  require('../services/stock').markFound(req.ctx(), Number(req.params.id), req.body.bin_no);
  res.flash('success', 'Item marked as found.');
  res.redirect(`/items/${req.params.id}`);
});

module.exports = r;
