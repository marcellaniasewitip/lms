'use strict';
const express = require('express');
const users = require('../services/users');
const config = require('../config');
const { RuleError } = require('../lib/errors');

const r = express.Router();

r.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { title: 'Sign in', idle: req.query.idle });
});
r.post('/login', (req, res) => {
  try {
    const { user, codeHash, code } = users.checkPassword(req.body.username, req.body.password, req.ip);
    req.session.pending = { userId: user.id, codeHash, expires: Date.now() + 5 * 60000, demoCode: config.SHOW_CODES ? code : null };
    res.redirect('/login/code');
  } catch (e) {
    if (!(e instanceof RuleError)) throw e;
    // Shown on the login page itself; the username stays filled in (never the password).
    req.session.flash = { error: e.message, old: { username: req.body.username } };
    res.redirect('/login');
  }
});
r.get('/login/code', (req, res) => {
  const p = req.session.pending;
  if (!p) return res.redirect('/login');
  res.render('login_code', { title: 'SMS code', demoCode: p.demoCode });
});
r.post('/login/code', (req, res) => {
  const p = req.session.pending;
  if (!p || p.expires < Date.now()) { delete req.session.pending; res.flash('error', 'The code expired. Sign in again.'); return res.redirect('/login'); }
  try {
    const u = users.checkCode(p.userId, req.body.code, p.codeHash, req.ip);
    req.session.regenerate(() => {
      req.session.userId = u.id;
      req.session.lastSeen = Date.now();
      res.redirect(u.must_change_pw && u.role === 'admin' ? '/account/password' : '/');
    });
  } catch (e) {
    if (!(e instanceof RuleError)) throw e;
    res.flash('error', e.message);
    if (e.message.includes('locked')) delete req.session.pending;
    res.redirect(e.message.includes('locked') ? '/login' : '/login/code');
  }
});
r.post('/logout', (req, res) => {
  if (req.user) require('../lib/audit').log(req.ctx(), 'logout', 'user', req.user.id);
  req.session.destroy(() => res.redirect('/login'));
});
// Changing a password is for the Admin only. Loan Officers and CROs use the credentials the
// Admin assigns; the Admin resets them under Admin → Users.
function adminOnly(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.role !== 'admin') {
    return res.status(403).render('error', { title: 'Not allowed', message: 'Only the Admin can change passwords. Ask the Admin if you need your password reset.', status: 403, details: [] });
  }
  next();
}
r.get('/account/password', adminOnly, (req, res) => {
  res.render('password', { title: 'Change password' });
});
r.post('/account/password', adminOnly, (req, res) => {
  if (req.body.next !== req.body.confirm) { res.flash('error', 'The new passwords do not match.'); return res.redirect('/account/password'); }
  users.changeOwnPassword(req.ctx(), req.body.current, req.body.next);
  res.flash('success', 'Password changed.');
  res.redirect('/');
});

module.exports = r;
