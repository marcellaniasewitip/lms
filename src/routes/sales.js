'use strict';
const express = require('express');
const db = require('../db');
const loans = require('../services/loans');
const { Forbidden } = require('../lib/errors');

const r = express.Router();
const only = (...roles) => (req, res, next) => (roles.includes(req.user.role) ? next() : next(new Forbidden()));

r.get('/', (req, res) => {
  const list = db.get().prepare(`SELECT s.*, l.loan_no, l.id AS loan_id, l.owing_at_forfeiture, i.item_no, i.category, i.brand_name || ' ' || i.model AS item,
    li.assessed_value, b.name AS branch_name FROM forfeiture_sales s JOIN loans l ON l.id = s.loan_id JOIN items i ON i.id = s.item_id
    JOIN loan_items li ON li.loan_id = l.id AND li.item_id = i.id JOIN branches b ON b.id = l.branch_id
    ORDER BY s.status = 'sold', s.id DESC LIMIT 300`).all();
  res.render('sales/list', { title: 'Forfeited items for sale', list });
});
r.post('/:id/reserve', only('admin'), (req, res) => { loans.approveReserve(req.ctx(), Number(req.params.id), req.body); res.flash('success', 'Reserve approved.'); res.redirect('/sales'); });
r.post('/:id/listing', only('admin'), (req, res) => { loans.recordListing(req.ctx(), Number(req.params.id), req.body); res.flash('success', 'Auction listing recorded.'); res.redirect('/sales'); });
r.post('/:id/unsold', only('admin'), (req, res) => { loans.recordAuctionUnsold(req.ctx(), Number(req.params.id), req.body.note); res.flash('success', 'Marked as not sold at auction.'); res.redirect('/sales'); });
r.post('/:id/sold', only('admin'), (req, res) => { loans.recordSale(req.ctx(), Number(req.params.id), req.body); res.flash('success', 'Sale recorded.'); res.redirect('/sales'); });

module.exports = r;
