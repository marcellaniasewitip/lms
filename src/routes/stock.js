'use strict';
const express = require('express');
const stock = require('../services/stock');
const { checkBranch } = require('../lib/ctx');
const { Forbidden } = require('../lib/errors');

const r = express.Router();
const only = (...roles) => (req, res, next) => (roles.includes(req.user.role) ? next() : next(new Forbidden()));

r.get('/', (req, res) => res.render('stock/list', { title: 'Stock counts', list: stock.list(req.ctx()) }));
r.post('/', only('loan_officer'), (req, res) => res.redirect(`/stock/${stock.start(req.ctx())}`));
r.get('/access', (req, res) => res.render('stock/access', { title: 'Store, yard and safe access', list: stock.accessLog(req.ctx()) }));
r.post('/access', only('loan_officer', 'cro'), (req, res) => { stock.storeAccess(req.ctx(), req.body); res.flash('success', 'Access recorded.'); res.redirect('/stock/access'); });

r.get('/:id', (req, res) => {
  const c = stock.get(req.params.id);
  checkBranch(req.ctx(), c.branch_id);
  res.render('stock/sheet', { title: `Stock count ${c.period}`, c, lines: stock.lines(c.id) });
});
r.post('/:id/save', only('loan_officer'), (req, res) => {
  stock.save(req.ctx(), Number(req.params.id), { found: req.body.found || [], notes: req.body.notes || {} });
  res.flash('success', 'Saved.');
  res.redirect(`/stock/${req.params.id}`);
});
r.post('/:id/scan', only('loan_officer'), (req, res) => {
  const line = stock.scan(req.ctx(), Number(req.params.id), req.body.tag);
  res.flash('success', `${line.item_no} counted.`);
  res.redirect(`/stock/${req.params.id}#scan`);
});
r.post('/:id/submit', only('loan_officer'), (req, res) => { stock.submit(req.ctx(), Number(req.params.id)); res.flash('success', 'Count submitted for CRO sign-off.'); res.redirect(`/stock/${req.params.id}`); });
r.post('/:id/signoff', only('cro'), (req, res) => { stock.signOff(req.ctx(), Number(req.params.id), req.body.note); res.flash('success', 'Signed off.'); res.redirect(`/stock/${req.params.id}`); });
r.post('/:id/review', only('admin'), (req, res) => { stock.review(req.ctx(), Number(req.params.id), req.body.note); res.flash('success', 'Reviewed.'); res.redirect(`/stock/${req.params.id}`); });

module.exports = r;
