'use strict';
const express = require('express');
const db = require('../db');
const dates = require('../lib/dates');
const settings = require('../services/settings');
const archive = require('../services/archive');
const payments = require('../services/payments');

const r = express.Router();
const LOAN_COLS = `l.*, c.given_names || ' ' || c.surname AS customer_name, c.mobile AS customer_mobile, c.customer_no,
  (l.principal_owing + l.interest_owing + l.fees_owing) AS owing`;

r.get('/', (req, res) => {
  const d = db.get();
  const u = req.user;
  const t = dates.today();
  const bf = u.role === 'admin' ? '' : ` AND l.branch_id = ${Number(u.branch_id)}`;
  const q = (where, ...args) => d.prepare(`SELECT ${LOAN_COLS} FROM loans l JOIN customers c ON c.id = l.customer_id WHERE l.archived = 0 AND ${where} ${bf} ORDER BY l.id DESC LIMIT 50`).all(...args);
  const data = {};
  if (u.role === 'loan_officer') {
    data.maturing = q("l.status = 'active' AND l.maturity_date BETWEEN ? AND ?", t, dates.addDays(t, 7)).sort((a, b) => (a.maturity_date < b.maturity_date ? -1 : 1));
    data.toMatch = payments.holdingList(req.ctx());
    data.toReturn = q("l.status = 'paid'");
    data.toRelease = q("l.status = 'approved'");
    data.returned = q("l.status IN ('draft','returned')");
    data.handBack = q("l.status IN ('rejected','cancelled') AND l.date_closed IS NULL");
    data.tasks = d.prepare(`SELECT * FROM tasks WHERE status = 'open' AND role = 'loan_officer' ${u.branch_id ? 'AND branch_id = ' + Number(u.branch_id) : ''} ORDER BY id DESC LIMIT 30`).all();
    data.grace = q("l.status = 'in_grace'");
  }
  if (u.role === 'cro') {
    data.waiting = q("l.status = 'submitted'");
    data.grace = q("l.status = 'in_grace' AND l.grace_end_date > ?", t);
    data.toForfeit = q("l.status = 'in_grace' AND l.grace_end_date <= ?", t);
    data.idChecks = d.prepare(`SELECT ci.*, c.customer_no, c.given_names || ' ' || c.surname AS name, t.name AS type_name FROM customer_ids ci JOIN customers c ON c.id = ci.customer_id
      JOIN id_types t ON t.id = ci.id_type_id WHERE ci.status = 'pending' ${u.branch_id ? 'AND c.branch_id = ' + Number(u.branch_id) : ''} ORDER BY ci.id`).all();
    data.duplicates = d.prepare(`SELECT * FROM customers WHERE verification_status = 'duplicate_review' ${u.branch_id ? 'AND branch_id = ' + Number(u.branch_id) : ''}`).all();
    data.waivers = d.prepare(`SELECT w.*, l.loan_no FROM waivers w JOIN loans l ON l.id = w.loan_id WHERE w.status = 'pending' ${bf}`).all();
    data.stockToSign = d.prepare(`SELECT s.*, b.name AS branch_name FROM stock_counts s JOIN branches b ON b.id = s.branch_id WHERE s.status = 'submitted' ${u.branch_id ? 'AND s.branch_id = ' + Number(u.branch_id) : ''}`).all();
    data.trend = redemptionTrend(t, u.branch_id);
  }
  if (u.role === 'admin') {
    const m = dates.monthOf(t);
    const lent = d.prepare("SELECT COALESCE(SUM(amount_released),0) s, COUNT(*) n FROM loans WHERE substr(release_date,1,7) = ?").get(m);
    const collected = d.prepare("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE substr(date_received,1,7) = ?").get(m);
    data.month = m;
    data.lent = lent; data.collected = collected.s;
    data.lendTarget = settings.get('monthly_lending_target'); data.collectTarget = settings.get('monthly_collection_target');
    data.forSale = d.prepare(`SELECT s.*, l.loan_no, i.item_no, i.brand_name || ' ' || i.model AS item, l.owing_at_forfeiture FROM forfeiture_sales s JOIN loans l ON l.id = s.loan_id
      JOIN items i ON i.id = s.item_id WHERE s.status != 'sold' ORDER BY s.id`).all();
    data.expiring = archive.expiringSoon(t);
    data.stock = d.prepare(`SELECT b.name, b.id, (SELECT status FROM stock_counts s WHERE s.branch_id = b.id AND s.period = ?) AS status,
      (SELECT missing_count FROM stock_counts s WHERE s.branch_id = b.id AND s.period = ?) AS missing FROM branches b WHERE b.active = 1`).all(m, m);
    data.reversals = d.prepare("SELECT COUNT(*) n FROM reversal_requests WHERE status = 'pending'").get().n;
    data.locked = d.prepare('SELECT * FROM users WHERE locked = 1').all();
    data.amlOpen = d.prepare("SELECT COUNT(*) n FROM aml_flags WHERE status = 'open'").get().n;
    data.lastRun = d.prepare("SELECT * FROM job_runs WHERE job = 'nightly' ORDER BY id DESC LIMIT 1").get();
  }
  res.render('dashboard', { title: 'Dashboard', data });
});

// Redeemed against forfeited by month of closing, last 12 months.
function redemptionTrend(t, branchId) {
  const d = db.get();
  const out = [];
  for (let i = 11; i >= 0; i--) {
    const m = dates.monthOf(dates.addMonths(t.slice(0, 8) + '01', -i));
    const row = d.prepare(`SELECT
      SUM(CASE WHEN status = 'redeemed' OR (status = 'archived' AND pre_archive_status = 'redeemed') THEN 1 ELSE 0 END) red,
      SUM(CASE WHEN status = 'item_sold' OR (status = 'archived' AND pre_archive_status = 'item_sold') THEN 1 ELSE 0 END) forf
      FROM loans WHERE substr(date_closed,1,7) = ? ${branchId ? 'AND branch_id = ' + Number(branchId) : ''}`).get(m);
    out.push({ month: m, redeemed: row.red || 0, forfeited: row.forf || 0 });
  }
  return out;
}

module.exports = r;
