'use strict';
const express = require('express');
const db = require('../db');
const bins = require('../services/bins');
const { checkBranch } = require('../lib/ctx');
const { Forbidden } = require('../lib/errors');

const r = express.Router();

// All bins with how full they are; Loan Officers and CROs see their own branch.
r.get('/', (req, res) => {
  const u = req.user;
  const branchId = u.role === 'admin' ? (req.query.branch_id ? Number(req.query.branch_id) : null) : u.branch_id;
  let list = bins.all(branchId);
  if (req.query.kind) list = list.filter((b) => b.kind === req.query.kind);
  if (req.query.show === 'used') list = list.filter((b) => b.used > 0);
  if (req.query.show === 'empty') list = list.filter((b) => b.used === 0 && b.active);
  res.render('bins/list', { title: 'Bins', list, KINDS: bins.KINDS, branches: db.get().prepare('SELECT * FROM branches ORDER BY name').all(), branchId });
});

r.get('/:id', (req, res) => {
  const b = bins.get(req.params.id);
  checkBranch(req.ctx(), b.branch_id);
  res.render('bins/view', { title: bins.label(b), b, label: bins.label(b), KINDS: bins.KINDS, items: bins.contents(b.id),
    branch: db.get().prepare('SELECT name FROM branches WHERE id = ?').get(b.branch_id).name });
});

r.post('/', (req, res) => {
  if (req.user.role !== 'admin') throw new Forbidden();
  const out = bins.create(req.ctx(), req.body);
  res.flash('success', `${out.added} bin(s) added${out.skipped ? `; ${out.skipped} already existed` : ''}.`);
  res.redirect(`/bins?branch_id=${req.body.branch_id}&kind=${req.body.kind}`);
});
r.post('/:id', (req, res) => {
  if (req.user.role !== 'admin') throw new Forbidden();
  bins.update(req.ctx(), Number(req.params.id), { capacity: req.body.capacity, description: req.body.description, active: req.body.active === '1' });
  res.flash('success', 'Bin updated.');
  res.redirect(`/bins/${req.params.id}`);
});

module.exports = r;
