'use strict';
const express = require('express');
const db = require('../db');
const dates = require('../lib/dates');
const money = require('../lib/money');
const audit = require('../lib/audit');
const { normalizeNumber } = require('../lib/crypto');
const { rule, Forbidden, RuleError } = require('../lib/errors');
const settings = require('../services/settings');
const users = require('../services/users');
const aml = require('../services/aml');
const jobs = require('../services/jobs');
const backup = require('../services/backup');

const r = express.Router();
const only = (...roles) => (req, res, next) => (roles.includes(req.user.role) ? next() : next(new Forbidden()));
const admin = only('admin');

// ---------- users ----------
r.get('/users', admin, (req, res) => res.render('admin/users', { title: 'Users', list: users.list(), branches: branches() }));
r.post('/users', admin, (req, res) => { users.create(req.ctx(), req.body); res.flash('success', req.body.role === 'admin' ? 'User created. They must choose their own password at first sign-in.' : 'User created. Give them their username and password; only the Admin can change it.'); res.redirect('/admin/users'); });
r.post('/users/:id', admin, (req, res) => {
  const id = Number(req.params.id);
  if (req.body.action === 'unlock') users.unlock(req.ctx(), id);
  else if (req.body.action === 'reset') users.resetPassword(req.ctx(), id, req.body.password);
  else users.update(req.ctx(), id, { full_name: req.body.full_name, branch_id: req.body.branch_id ? Number(req.body.branch_id) : null, mobile: req.body.mobile, active: req.body.active === '1' });
  res.flash('success', 'User updated.');
  res.redirect('/admin/users');
});

// ---------- branches ----------
function branches() { return db.get().prepare('SELECT * FROM branches ORDER BY name').all(); }
r.get('/branches', admin, (req, res) => res.render('admin/branches', { title: 'Branches', list: branches() }));
r.post('/branches', admin, (req, res) => {
  const b = req.body;
  rule(b.code && b.name, 'Branch code and name are required.');
  const fields = [b.code.toUpperCase(), b.name, b.phone, b.email, b.postal_address, b.physical_address];
  if (b.id) {
    db.get().prepare('UPDATE branches SET code = ?, name = ?, phone = ?, email = ?, postal_address = ?, physical_address = ?, active = ? WHERE id = ?').run(...fields, b.active === '0' ? 0 : 1, b.id);
    audit.log(req.ctx(), 'branch_update', 'branch', b.id, null, b);
  } else {
    const info = db.get().prepare('INSERT INTO branches(code, name, phone, email, postal_address, physical_address, created_at) VALUES (?,?,?,?,?,?,?)').run(...fields, dates.nowIso());
    audit.log(req.ctx(), 'branch_create', 'branch', info.lastInsertRowid, null, b);
    require('../services/bins').seedBranch(info.lastInsertRowid);
  }
  res.flash('success', 'Branch saved.');
  res.redirect('/admin/branches');
});

// ---------- settings ----------
r.get('/settings', admin, (req, res) => res.render('admin/settings', { title: 'Settings', s: settings.all(), grades: settings.grades(), fees: db.get().prepare('SELECT * FROM fees ORDER BY category').all() }));
r.post('/settings', admin, (req, res) => {
  const b = req.body;
  const before = settings.all();
  const errs = [];
  const moneyKeys = ['min_loan', 'aml_cash_threshold', 'aml_high_value', 'monthly_lending_target', 'monthly_collection_target'];
  const intKeys = ['term_months', 'grace_days', 'expiry_days', 'retention_years', 'surplus_payment_days', 'min_item_photos', 'car_mileage_tolerance_km', 'aml_repeat_count', 'aml_repeat_days'];
  const next = {};
  for (const k of ['lender_name', 'lender_slogan', 'pledger_confirmations', 'rights_obligations', 'disclosure_extra']) if (b[k] !== undefined) next[k] = String(b[k]).trim();
  for (const k of moneyKeys) if (b[k] !== undefined) { const v = money.parse(b[k]); if (v === null || v < 0) errs.push(`${k}: enter an amount.`); else next[k] = v; }
  for (const k of intKeys) if (b[k] !== undefined) { const v = Number(b[k]); if (!Number.isInteger(v) || v < 0) errs.push(`${k}: enter a whole number.`); else next[k] = v; }
  if (next.min_loan !== undefined && next.min_loan < 2000) errs.push('The minimum loan cannot be below K20.00.');
  if (next.term_months !== undefined && next.term_months > 3) errs.push('The longest term is 3 months.');
  if (next.retention_years !== undefined && next.retention_years < 7) errs.push('Records must be kept for at least 7 years (AML/CTF Act 2015).');
  if (b.rate_options !== undefined) {
    const opts = [].concat(b.rate_options).map(Number).filter((n) => n >= 10 && n <= 20).sort((x, y) => x - y);
    if (!opts.length) errs.push('Choose at least one weekly rate between 10% and 20%.'); else next.rate_options = opts;
  }
  if (b.ticket_terms !== undefined) next.ticket_terms = [].concat(b.ticket_terms).map((x) => String(x).trim()).filter(Boolean);
  if (errs.length) throw new RuleError('Settings not saved.', errs);
  for (const [k, v] of Object.entries(next)) settings.set(k, v);
  const changed = Object.fromEntries(Object.entries(next).filter(([k, v]) => JSON.stringify(before[k]) !== JSON.stringify(v)));
  audit.log(req.ctx(), 'settings_update', 'settings', null, Object.fromEntries(Object.keys(changed).map((k) => [k, before[k]])), changed);
  res.flash('success', 'Settings saved. Existing loans keep their own copy of the terms.');
  res.redirect('/admin/settings');
});
r.post('/grades', admin, (req, res) => {
  const errs = [];
  const opts = settings.get('rate_options');
  for (const g of settings.grades()) {
    const share = Number(req.body[`share_${g.grade}`]);
    const accepted = req.body[`accepted_${g.grade}`] === '1' ? 1 : 0;
    const min = req.body[`min_${g.grade}`] ? Number(req.body[`min_${g.grade}`]) : null, max = req.body[`max_${g.grade}`] ? Number(req.body[`max_${g.grade}`]) : null;
    if (accepted && (!(share > 0 && share <= 100) || !opts.includes(min) || !opts.includes(max) || min > max)) { errs.push(`Grade ${g.grade}: share 1–100% and a rate band within the rate options.`); continue; }
    db.get().prepare('UPDATE grades SET description = ?, share_pct = ?, rate_min = ?, rate_max = ?, accepted = ? WHERE grade = ?')
      .run(req.body[`desc_${g.grade}`] || g.description, accepted ? share : 0, accepted ? min : null, accepted ? max : null, accepted, g.grade);
    audit.log(req.ctx(), 'grade_update', 'grade', g.grade, g, { share, min, max, accepted });
  }
  if (errs.length) throw new RuleError('Some grades were not saved.', errs);
  res.flash('success', 'Grade shares and rate bands saved.');
  res.redirect('/admin/settings#grades');
});
r.post('/fees', admin, (req, res) => {
  const b = req.body;
  if (b.id && b.delete) db.get().prepare('UPDATE fees SET active = 0 WHERE id = ?').run(b.id);
  else {
    const amt = money.parse(b.amount);
    rule(['car', 'laptop', 'phone'].includes(b.category) && b.name && amt > 0, 'Category, name and amount are required.');
    if (b.id) db.get().prepare('UPDATE fees SET category = ?, name = ?, amount = ?, active = 1 WHERE id = ?').run(b.category, b.name, amt, b.id);
    else db.get().prepare('INSERT INTO fees(category, name, amount) VALUES (?,?,?)').run(b.category, b.name, amt);
  }
  audit.log(req.ctx(), 'fee_update', 'fee', b.id || null, null, b);
  res.flash('success', 'Fees saved.');
  res.redirect('/admin/settings#fees');
});

// ---------- reference lists ----------
r.get('/lists', admin, (req, res) => res.render('admin/lists', {
  title: 'ID types and approved brands', idTypes: db.get().prepare('SELECT * FROM id_types ORDER BY id').all(), brands: db.get().prepare('SELECT * FROM brands ORDER BY category, name').all(),
}));
r.post('/id-types', admin, (req, res) => {
  const b = req.body;
  if (b.id) {
    db.get().prepare('UPDATE id_types SET active = ? WHERE id = ?').run(b.active === '1' ? 1 : 0, b.id);
  } else {
    rule(b.name && b.issued_by && ['yes', 'no', 'varies'].includes(b.photo) && ['primary', 'secondary', 'secondary_only'].includes(b.use), 'Fill in every field.');
    rule(!(b.use === 'primary' && b.photo !== 'yes'), 'A primary ID must carry a photo.');
    db.get().prepare('INSERT INTO id_types(name, issued_by, photo, use, is_photo_id) VALUES (?,?,?,?,?)').run(b.name, b.issued_by, b.photo, b.use, b.photo === 'yes' ? 1 : 0);
  }
  audit.log(req.ctx(), 'id_type_update', 'id_type', b.id || null, null, b);
  res.flash('success', 'ID types saved.');
  res.redirect('/admin/lists');
});
r.post('/brands', admin, (req, res) => {
  const b = req.body;
  if (b.id) {
    db.get().prepare('UPDATE brands SET active = ?, min_model_year = ?, min_model = ? WHERE id = ?').run(b.active === '1' ? 1 : 0, b.min_model_year ? Number(b.min_model_year) : null, b.min_model || null, b.id);
  } else {
    rule(['car', 'laptop', 'phone'].includes(b.category) && b.name, 'Category and brand name are required.');
    db.get().prepare('INSERT INTO brands(category, name, min_model_year, min_model) VALUES (?,?,?,?) ON CONFLICT(category, name) DO UPDATE SET active = 1, min_model_year = excluded.min_model_year')
      .run(b.category, b.name.trim(), b.min_model_year ? Number(b.min_model_year) : null, b.min_model || null);
  }
  audit.log(req.ctx(), 'brand_update', 'brand', b.id || null, null, b);
  res.flash('success', 'Brand list saved.');
  res.redirect('/admin/lists#brands');
});

// ---------- flagged (stolen) list and sanctions list ----------
r.get('/watchlists', only('admin', 'cro'), (req, res) => res.render('admin/watchlists', {
  title: 'Flagged items and sanctions list',
  stolen: db.get().prepare('SELECT s.*, u.full_name FROM stolen_list s LEFT JOIN users u ON u.id = s.added_by ORDER BY s.id DESC').all(),
  sanctions: db.get().prepare('SELECT * FROM sanctions_list ORDER BY full_name').all(),
}));
r.post('/stolen', only('admin', 'cro'), (req, res) => {
  const b = req.body;
  if (b.id) db.get().prepare('UPDATE stolen_list SET active = 0 WHERE id = ?').run(b.id);
  else {
    rule(b.number, 'Enter the serial number, IMEI, VIN, engine number or plate.');
    db.get().prepare('INSERT INTO stolen_list(number_type, number_norm, description, source, added_by, created_at) VALUES (?,?,?,?,?,?)')
      .run(b.number_type || 'Number', normalizeNumber(b.number), b.description || null, b.source || null, req.user.id, dates.nowIso());
  }
  audit.log(req.ctx(), b.id ? 'stolen_remove' : 'stolen_add', 'stolen_list', b.id || null, null, b);
  res.flash('success', 'Flagged list updated.');
  res.redirect('/admin/watchlists');
});
r.post('/sanctions', admin, (req, res) => {
  if (req.body.id) aml.removeSanction(req.ctx(), Number(req.body.id)); else aml.addSanction(req.ctx(), req.body);
  res.flash('success', 'Sanctions list updated.');
  res.redirect('/admin/watchlists#sanctions');
});

// ---------- system: nightly job, backups, SMS outbox ----------
r.get('/system', admin, (req, res) => res.render('admin/system', {
  title: 'System', runs: db.get().prepare('SELECT * FROM job_runs ORDER BY id DESC LIMIT 30').all(), backups: backup.list(),
}));
r.post('/system/nightly', admin, async (req, res) => {
  const out = await jobs.catchUp(req.user.id);
  res.flash('success', 'Nightly run finished.', out);
  res.redirect('/admin/system');
});
r.post('/system/backup', admin, async (req, res) => {
  const name = await backup.run();
  audit.log(req.ctx(), 'backup', 'backup', name);
  res.flash('success', `Encrypted backup ${name} written to both locations.`);
  res.redirect('/admin/system');
});
r.post('/system/restore-test', admin, (req, res) => {
  const result = backup.testRestore(req.body.id ? Number(req.body.id) : null);
  audit.log(req.ctx(), 'restore_test', 'backup', req.body.id || 'latest', null, { result });
  res.flash(result.startsWith('OK') ? 'success' : 'error', `Restore test: ${result}`);
  res.redirect('/admin/system');
});
r.get('/sms', admin, (req, res) => res.render('admin/sms', { title: 'SMS outbox', list: db.get().prepare('SELECT * FROM sms_outbox ORDER BY id DESC LIMIT 300').all() }));

// ---------- audit log (Admin and CRO) ----------
r.get('/audit', only('admin', 'cro'), (req, res) => {
  const where = []; const args = {};
  if (req.query.user) { where.push('username = @u'); args.u = req.query.user; }
  if (req.query.action) { where.push('action LIKE @a'); args.a = `%${req.query.action}%`; }
  if (req.query.entity) { where.push('entity = @e'); args.e = req.query.entity; }
  if (req.query.entity_id) { where.push('entity_id = @eid'); args.eid = req.query.entity_id; }
  const list = db.get().prepare(`SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 500`).all(args);
  res.render('admin/audit', { title: 'Audit log', list });
});

module.exports = r;
