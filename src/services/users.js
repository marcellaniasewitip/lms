'use strict';
const bcrypt = require('bcryptjs');
const db = require('../db');
const dates = require('../lib/dates');
const audit = require('../lib/audit');
const { randomCode, sha256 } = require('../lib/crypto');
const { RuleError, NotFound, rule } = require('../lib/errors');
const { requireRole } = require('../lib/ctx');
const { MAX_LOGIN_ATTEMPTS } = require('../config');
const notify = require('./notify');
const phone = require('../lib/phone');

function passwordProblems(pw, username = '') {
  const p = [];
  if (!pw || pw.length < 10) p.push('at least 10 characters');
  if (!/[a-z]/.test(pw || '')) p.push('a lower-case letter');
  if (!/[A-Z]/.test(pw || '')) p.push('an upper-case letter');
  if (!/\d/.test(pw || '')) p.push('a number');
  if (!/[^A-Za-z0-9]/.test(pw || '')) p.push('a symbol');
  if (username && pw && pw.toLowerCase().includes(username.toLowerCase())) p.push('not contain the username');
  return p;
}

function get(id) {
  const u = db.get().prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) throw new NotFound('User not found.');
  return u;
}
function list() {
  return db.get().prepare('SELECT u.*, b.name AS branch_name FROM users u LEFT JOIN branches b ON b.id = u.branch_id ORDER BY u.role, u.full_name').all();
}

function create(ctx, { username, full_name, role, branch_id, mobile, password }) {
  if (ctx) requireRole(ctx, 'admin');
  const errs = [];
  if (!/^[a-z0-9._-]{3,32}$/.test(username || '')) errs.push('Username: 3–32 lower-case letters, numbers, dot, dash or underscore.');
  if (!full_name) errs.push('Full name is required.');
  if (!['admin', 'loan_officer', 'cro'].includes(role)) errs.push('Each user has exactly one role: Admin, Loan Officer or CRO.');
  if (role !== 'admin' && !branch_id) errs.push('Loan Officers and CROs belong to a branch.');
  const mobileProblem = phone.problem(mobile, 'Mobile (for the SMS sign-in code)');
  if (mobileProblem) errs.push(mobileProblem);
  const pp = passwordProblems(password, username);
  if (pp.length) errs.push('Password needs ' + pp.join(', ') + '.');
  if (db.get().prepare('SELECT 1 FROM users WHERE username = ?').get(username)) errs.push('That username is taken.');
  if (errs.length) throw new RuleError('The user cannot be created.', errs);
  const info = db.get().prepare(`INSERT INTO users(username, full_name, role, branch_id, mobile, password_hash, must_change_pw, created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(username, full_name, role, role === 'admin' ? (branch_id || null) : branch_id, '+675' + phone.parseInput(mobile),
    bcrypt.hashSync(password, 12), ctx ? 1 : 0, dates.nowIso());
  if (ctx) audit.log(ctx, 'user_create', 'user', info.lastInsertRowid, null, { username, full_name, role, branch_id });
  return info.lastInsertRowid;
}

function update(ctx, id, { full_name, branch_id, mobile, active }) {
  requireRole(ctx, 'admin');
  const u = get(id);
  rule(!(u.id === ctx.user.id && active === false), 'You cannot deactivate your own account.');
  if (mobile && phone.problem(mobile)) throw new RuleError(phone.problem(mobile, 'Mobile (for the SMS sign-in code)'));
  const after = { full_name: full_name || u.full_name, branch_id: u.role === 'admin' ? (branch_id || null) : (branch_id || u.branch_id), mobile: mobile ? '+675' + phone.parseInput(mobile) : u.mobile, active: active === undefined ? u.active : active ? 1 : 0 };
  db.get().prepare('UPDATE users SET full_name = ?, branch_id = ?, mobile = ?, active = ? WHERE id = ?').run(after.full_name, after.branch_id, after.mobile, after.active, id);
  const [o, n] = audit.diff(u, after);
  audit.log(ctx, 'user_update', 'user', id, o, n);
}
function unlock(ctx, id) {
  requireRole(ctx, 'admin');
  db.get().prepare('UPDATE users SET locked = 0, failed_attempts = 0 WHERE id = ?').run(id);
  audit.log(ctx, 'user_unlock', 'user', id);
}
function resetPassword(ctx, id, password) {
  requireRole(ctx, 'admin');
  const u = get(id);
  const pp = passwordProblems(password, u.username);
  if (pp.length) throw new RuleError('Password needs ' + pp.join(', ') + '.');
  db.get().prepare('UPDATE users SET password_hash = ?, must_change_pw = 1, locked = 0, failed_attempts = 0 WHERE id = ?').run(bcrypt.hashSync(password, 12), id);
  audit.log(ctx, 'user_password_reset', 'user', id);
}
function changeOwnPassword(ctx, current, next) {
  const u = get(ctx.user.id);
  rule(bcrypt.compareSync(current || '', u.password_hash), 'Current password is wrong.');
  const pp = passwordProblems(next, u.username);
  if (pp.length) throw new RuleError('New password needs ' + pp.join(', ') + '.');
  rule(!bcrypt.compareSync(next, u.password_hash), 'Choose a new password different from the current one.');
  db.get().prepare('UPDATE users SET password_hash = ?, must_change_pw = 0 WHERE id = ?').run(bcrypt.hashSync(next, 12), u.id);
  audit.log(ctx, 'password_change', 'user', u.id);
}

// Step 1 of sign-in: password. Returns {user, code} where code is sent by SMS.
function checkPassword(username, password, ip) {
  const u = db.get().prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim().toLowerCase());
  const ctx = { user: u ? { id: u.id, username: u.username, role: u.role } : null, ip };
  if (!u || !u.active) { audit.log({ ip }, 'login_failed', 'user', username, null, { reason: 'unknown or inactive' }); throw new RuleError('Wrong username or password.'); }
  if (u.locked) throw new RuleError('This account is locked after too many wrong attempts. Ask the Admin to unlock it.');
  if (!bcrypt.compareSync(password || '', u.password_hash)) { failed(u, ctx, 'password'); throw new RuleError('Wrong username or password.'); }
  const code = randomCode(6);
  db.get().prepare('UPDATE users SET failed_attempts = failed_attempts WHERE id = ?').run(u.id);
  notify.sms('mobile_code', { to: u.mobile, language: 'en', userId: u.id, vars: { code } });
  return { user: u, codeHash: sha256(code + u.id), code };
}
function failed(u, ctx, what) {
  const n = u.failed_attempts + 1;
  const lock = n >= MAX_LOGIN_ATTEMPTS ? 1 : 0;
  db.get().prepare('UPDATE users SET failed_attempts = ?, locked = ? WHERE id = ?').run(n, lock, u.id);
  audit.log(ctx, lock ? 'account_locked' : 'login_failed', 'user', u.id, null, { attempt: n, what });
  if (lock) notify.inApp({ role: 'admin', title: `Account locked: ${u.username}`, body: `${MAX_LOGIN_ATTEMPTS} wrong sign-in attempts.`, link: '/admin/users' });
}
// Step 2 of sign-in: the SMS code.
function checkCode(userId, code, codeHash, ip) {
  const u = get(userId);
  const ctx = { user: { id: u.id, username: u.username, role: u.role }, ip };
  if (u.locked) throw new RuleError('This account is locked. Ask the Admin to unlock it.');
  if (sha256(String(code || '').trim() + u.id) !== codeHash) { failed(u, ctx, 'sms code'); throw new RuleError('The code is wrong.'); }
  db.get().prepare('UPDATE users SET failed_attempts = 0, last_login_at = ? WHERE id = ?').run(dates.nowIso(), u.id);
  audit.log(ctx, 'login', 'user', u.id);
  return get(u.id);
}

module.exports = { passwordProblems, get, list, create, update, unlock, resetPassword, changeOwnPassword, checkPassword, checkCode };
