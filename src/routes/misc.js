'use strict';
const express = require('express');
const db = require('../db');
const dates = require('../lib/dates');
const audit = require('../lib/audit');
const notify = require('../services/notify');
const files = require('../services/files');
const items = require('../services/items');
const loans = require('../services/loans');
const { Forbidden, NotFound, rule } = require('../lib/errors');

const r = express.Router();

r.get('/notifications', (req, res) => {
  res.render('notifications', { title: 'Notifications', list: notify.forUser(req.user, { limit: 200 }) });
});
r.post('/notifications/read', (req, res) => {
  if (req.body.id) notify.markRead(req.user, Number(req.body.id)); else notify.markAllRead(req.user);
  const n = req.body.id && db.get().prepare('SELECT link FROM notifications WHERE id = ?').get(req.body.id);
  res.redirect(n && n.link ? n.link : '/notifications');
});

r.get('/tasks', (req, res) => {
  const u = req.user;
  const list = db.get().prepare(`SELECT t.*, l.loan_no, u.full_name AS done_by_name FROM tasks t LEFT JOIN loans l ON l.id = t.loan_id LEFT JOIN users u ON u.id = t.done_by
    WHERE (t.role = ? OR ? = 'admin') ${u.role !== 'admin' && u.branch_id ? 'AND t.branch_id = ' + Number(u.branch_id) : ''} ORDER BY t.status = 'done', t.id DESC LIMIT 200`).all(u.role, u.role);
  res.render('tasks', { title: 'Call tasks', list });
});
r.post('/tasks/:id/done', (req, res) => {
  rule(req.body.outcome, 'Record what happened on the call.');
  db.get().prepare("UPDATE tasks SET status = 'done', outcome = ?, done_by = ?, done_at = ? WHERE id = ?").run(req.body.outcome, req.user.id, dates.nowIso(), req.params.id);
  const t = db.get().prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (t && t.loan_id) loans.event(req.ctx(), t.loan_id, 'note', { note: `Call: ${req.body.outcome}` });
  audit.log(req.ctx(), 'task_done', 'task', req.params.id, null, { outcome: req.body.outcome });
  res.flash('success', 'Task completed.');
  res.redirect('/tasks');
});

// Barcode lookup: scan an item tag or a pledge ticket (contract number).
r.get('/lookup', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.redirect('/');
  const it = items.byTag(q);
  if (it) return res.redirect(`/items/${it.id}`);
  const l = loans.byNo(q.split('/')[0]);
  if (l && !(l.archived && req.user.role === 'loan_officer')) return res.redirect(l.archived ? `/archive/loan/${l.id}` : `/loans/${l.id}`);
  res.redirect(`/customers?q=${encodeURIComponent(q)}`);
});

// Decrypted file download, with permission checks and audit of ID scan views.
r.get('/files/:id', (req, res) => {
  const f = files.getMeta(req.params.id);
  if (!f) throw new NotFound();
  const u = req.user;
  if (f.owner_type === 'loan') {
    const l = db.get().prepare('SELECT archived, branch_id FROM loans WHERE id = ?').get(f.owner_id);
    if (l && l.archived && u.role === 'loan_officer') throw new Forbidden('Loan Officers cannot see archived loans.');
  }
  if (f.owner_type === 'customer_id') audit.log(req.ctx(), 'view_id_scan', 'customer_id', f.owner_id, null, { file: f.id, side: f.kind });
  res.set('Content-Type', f.mime);
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Disposition', `inline; filename="${(f.original_name || 'file').replace(/[^\w.-]/g, '_')}"`);
  res.send(files.read(f));
});

module.exports = r;
