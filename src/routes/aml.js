'use strict';
const express = require('express');
const db = require('../db');
const aml = require('../services/aml');
const { Forbidden } = require('../lib/errors');

const r = express.Router();
r.get('/', (req, res) => {
  if (!['admin', 'cro'].includes(req.user.role)) throw new Forbidden();
  const list = db.get().prepare(`SELECT f.*, c.customer_no, c.given_names || ' ' || c.surname AS name, l.loan_no, u.full_name AS reviewer FROM aml_flags f
    LEFT JOIN customers c ON c.id = f.customer_id LEFT JOIN loans l ON l.id = f.loan_id LEFT JOIN users u ON u.id = f.reviewed_by
    ORDER BY f.status = 'open' DESC, f.id DESC LIMIT 300`).all();
  res.render('aml/list', { title: 'AML flags', list, TYPES: aml.TYPES });
});
// Any staff member can raise a suspicion.
r.post('/', (req, res) => {
  const c = req.body.customer_no ? db.get().prepare('SELECT id FROM customers WHERE customer_no = ?').get(req.body.customer_no.trim()) : null;
  aml.flag(req.ctx(), { type: 'manual', customerId: c ? c.id : null, details: `${req.body.details} (raised by ${req.user.full_name})` });
  res.flash('success', 'Suspicion recorded and sent to the CRO and Admin.');
  res.redirect(req.get('Referer') || '/');
});
r.post('/:id/review', (req, res) => {
  aml.review(req.ctx(), Number(req.params.id), req.body);
  res.flash('success', 'AML flag reviewed.');
  res.redirect('/aml');
});
module.exports = r;
