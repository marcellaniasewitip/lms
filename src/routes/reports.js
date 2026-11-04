'use strict';
const express = require('express');
const db = require('../db');
const reports = require('../services/reports');
const settings = require('../services/settings');
const audit = require('../lib/audit');
const { reportToXlsx, reportToPdf } = require('../lib/export');
const { NotFound } = require('../lib/errors');

const r = express.Router();

r.get('/', (req, res) => {
  res.render('reports/index', { title: 'Reports', list: reports.LIST.filter((x) => !x.roles || x.roles.includes(req.user.role)) });
});
r.get('/:key', async (req, res) => {
  const rep = reports.build(req.ctx(), req.params.key, req.query);
  if (!rep) throw new NotFound();
  const fmt = req.query.format;
  if (fmt === 'xlsx' || fmt === 'pdf') {
    audit.log(req.ctx(), 'export_report', 'report', req.params.key, null, { format: fmt, params: req.query });
    const name = `${req.params.key}-${new Date().toISOString().slice(0, 10)}.${fmt}`;
    const buf = fmt === 'xlsx' ? await reportToXlsx(rep) : await reportToPdf(rep, settings.get('lender_name'));
    res.set('Content-Type', fmt === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${name}"`);
    return res.send(Buffer.from(buf));
  }
  const def = reports.LIST.find((x) => x.key === req.params.key);
  const custs = req.params.key === 'customer' ? db.get().prepare(`SELECT id, customer_no, given_names || ' ' || surname AS name FROM customers
    ${req.user.role === 'loan_officer' ? 'WHERE id IN (SELECT customer_id FROM loans WHERE loan_officer_id = ' + req.user.id + ') OR created_by = ' + req.user.id : ''} ORDER BY surname`).all() : [];
  res.render('reports/show', { title: rep.title, rep, def, key: req.params.key, branches: db.get().prepare('SELECT * FROM branches').all(), custs });
});

module.exports = r;
