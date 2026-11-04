'use strict';
const express = require('express');
const db = require('../db');
const payments = require('../services/payments');
const loans = require('../services/loans');
const { Forbidden } = require('../lib/errors');

const r = express.Router();
const only = (...roles) => (req, res, next) => (roles.includes(req.user.role) ? next() : next(new Forbidden()));

r.get('/unmatched', only('loan_officer', 'admin'), (req, res) => {
  const matched = db.get().prepare(`SELECT u.*, l.loan_no FROM unmatched_payments u LEFT JOIN loans l ON l.id = u.matched_loan_id WHERE u.status = 'matched' ORDER BY u.matched_at DESC LIMIT 30`).all();
  res.render('payments/unmatched', { title: 'Payments to match', list: payments.holdingList(req.ctx()), matched });
});
r.post('/unmatched', only('loan_officer'), (req, res) => {
  payments.addUnmatched(req.ctx(), req.body);
  res.flash('success', 'Added to the holding list.');
  res.redirect('/payments/unmatched');
});
r.post('/unmatched/:id/match', only('loan_officer'), (req, res) => {
  const pid = payments.match(req.ctx(), Number(req.params.id), req.body.loan_no);
  const p = loans.payment(pid);
  res.flash('success', `Matched to loan ${req.body.loan_no}: receipt ${p.receipt_no}.`);
  res.redirect('/payments/unmatched');
});

r.get('/reversals', only('admin', 'loan_officer'), (req, res) => {
  const list = db.get().prepare(`SELECT r.*, p.receipt_no, p.amount, p.channel, p.date_received, l.loan_no, l.id AS loan_id, u.full_name AS requested_by_name, d.full_name AS decided_by_name
    FROM reversal_requests r JOIN payments p ON p.id = r.payment_id JOIN loans l ON l.id = r.loan_id JOIN users u ON u.id = r.requested_by LEFT JOIN users d ON d.id = r.decided_by
    ORDER BY r.status = 'pending' DESC, r.id DESC LIMIT 200`).all();
  res.render('payments/reversals', { title: 'Payment reversals', list });
});
r.post('/reversals/:id', only('admin'), (req, res) => {
  loans.decideReversal(req.ctx(), Number(req.params.id), { approve: req.body.approve === '1', note: req.body.note });
  res.flash('success', req.body.approve === '1' ? 'Reversal approved and posted as a new entry.' : 'Reversal rejected.');
  res.redirect('/payments/reversals');
});

r.get('/refunds', (req, res) => {
  const list = db.get().prepare(`SELECT r.*, l.loan_no, l.id AS loan_id, c.given_names || ' ' || c.surname AS customer_name, c.bank_name
    FROM refunds r JOIN loans l ON l.id = r.loan_id JOIN customers c ON c.id = l.customer_id ORDER BY r.status = 'owed' DESC, r.id DESC LIMIT 200`).all();
  res.render('payments/refunds', { title: 'Refunds and surplus owed', list });
});
r.post('/refunds/:id/pay', only('loan_officer', 'admin'), (req, res) => {
  loans.payRefund(req.ctx(), Number(req.params.id), req.body);
  res.flash('success', 'Payment to the customer recorded.');
  res.redirect('/payments/refunds');
});

module.exports = r;
