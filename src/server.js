'use strict';
const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const multer = require('multer');
const crypto = require('crypto');

const config = require('./config');
const db = require('./db');
const dates = require('./lib/dates');
const money = require('./lib/money');
const { RuleError, Forbidden, NotFound } = require('./lib/errors');
const { ROLE_LABEL } = require('./lib/ctx');
const settings = require('./services/settings');
const notify = require('./services/notify');
const loans = require('./services/loans');
const items = require('./services/items');
const phone = require('./lib/phone');

db.open();
settings.seedReferenceData();

// ---------- session store in SQLite ----------
class SqliteStore extends session.Store {
  get(sid, cb) {
    const r = db.get().prepare('SELECT sess, expires FROM sessions WHERE sid = ?').get(sid);
    if (!r || r.expires < Date.now()) return cb(null, null);
    cb(null, JSON.parse(r.sess));
  }
  set(sid, sess, cb) {
    const exp = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + config.IDLE_MINUTES * 60000;
    db.get().prepare('INSERT INTO sessions(sid, sess, expires) VALUES (?,?,?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires')
      .run(sid, JSON.stringify(sess), exp);
    cb && cb(null);
  }
  destroy(sid, cb) { db.get().prepare('DELETE FROM sessions WHERE sid = ?').run(sid); cb && cb(null); }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}
setInterval(() => db.get().prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()), 3600000).unref();

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(config.ROOT, 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: { directives: { 'default-src': ["'self'"], 'img-src': ["'self'", 'data:', 'blob:'], 'style-src': ["'self'", "'unsafe-inline'"], 'script-src': ["'self'"], 'form-action': ["'self'"] } },
  crossOriginEmbedderPolicy: false,
}));
app.use('/static', express.static(path.join(config.ROOT, 'public'), { maxAge: '1h' }));
app.use(express.urlencoded({ extended: true, limit: '8mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 30, fieldSize: 6 * 1024 * 1024 } });
app.use((req, res, next) => (req.is('multipart/form-data') ? upload.any()(req, res, next) : next()));
app.use(session({
  store: new SqliteStore(), secret: config.SESSION_SECRET, name: 'lms.sid', resave: false, saveUninitialized: false, rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: config.COOKIE_SECURE, maxAge: config.IDLE_MINUTES * 60000 },
}));

// Files grouped by field name.
app.use((req, res, next) => {
  req.filesOf = (name) => (req.files || []).filter((f) => f.fieldname === name);
  req.body = req.body || {};
  next();
});

// ---------- CSRF ----------
app.use((req, res, next) => {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  if (req.method === 'POST') {
    const t = (req.body && req.body._csrf) || req.query._csrf || req.get('x-csrf-token');
    if (t !== req.session.csrf) return res.status(403).render('error', { title: 'Form expired', message: 'This form has expired or was sent from elsewhere. Go back, reload the page and try again.', status: 403, user: null, details: [] });
  }
  next();
});

// ---------- current user, idle logout ----------
app.use((req, res, next) => {
  res.locals.user = null;
  if (req.session.userId) {
    const idle = Date.now() - (req.session.lastSeen || 0) > config.IDLE_MINUTES * 60000;
    const u = db.get().prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (idle || !u || !u.active || u.locked) {
      return req.session.regenerate(() => res.redirect('/login' + (idle ? '?idle=1' : '')));
    }
    req.session.lastSeen = Date.now();
    req.user = { id: u.id, username: u.username, role: u.role, branch_id: u.branch_id, full_name: u.full_name, must_change_pw: u.must_change_pw };
    res.locals.user = req.user;
  }
  req.ctx = () => ({ user: req.user, ip: req.ip });
  next();
});

// ---------- view helpers ----------
app.use((req, res, next) => {
  const flash = req.session.flash || {};
  delete req.session.flash;
  const old = flash.old || null;
  Object.assign(res.locals, {
    flash, old, path: req.path, query: req.query, today: dates.today(), dates, money,
    fd: dates.fmt, fts: dates.fmtTs, K: money.fmt, STATUS: loans.STATUS, CHANNELS: loans.CHANNELS, ROLE_LABEL, CUSTODY: items.CUSTODY_LABEL,
    lender: settings.get('lender_name'), idleMinutes: config.IDLE_MINUTES,
    // Phone numbers shown and pre-filled as (+675) 7123-4567; forms check the same format.
    fmtPhone: (s) => (phone.normalize(s) ? phone.format(s) : s || ''),
    phonePattern: phone.HTML_PATTERN, phoneFormat: phone.FORMAT_TEXT,
    val: (name, def = '') => (old && old[name] !== undefined ? old[name] : def ?? ''),
    oldHas: (name, v, def = false) => {
      if (!old) return def;
      const x = old[name];
      return Array.isArray(x) ? x.includes(v) : v === undefined ? !!x : x === v;
    },
    unread: req.user ? notify.unreadCount(req.user) : 0,
    is: (...roles) => req.user && roles.includes(req.user.role),
  });
  res.flash = (kind, message, details) => { req.session.flash = { [kind]: message, details }; };
  next();
});

// ---------- routes ----------
app.use(require('./routes/auth'));
app.use((req, res, next) => {
  if (!req.user) return res.redirect('/login');
  if (req.user.must_change_pw && !req.path.startsWith('/account/password')) return res.redirect('/account/password');
  next();
});
app.use(require('./routes/dashboard'));
app.use('/customers', require('./routes/customers'));
app.use('/items', require('./routes/items'));
app.use('/loans', require('./routes/loans'));
app.use('/payments', require('./routes/payments'));
app.use('/sales', require('./routes/sales'));
app.use('/archive', require('./routes/archive'));
app.use('/stock', require('./routes/stock'));
app.use('/reports', require('./routes/reports'));
app.use('/aml', require('./routes/aml'));
app.use('/admin', require('./routes/admin'));
app.use(require('./routes/misc'));

app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.', status: 404, details: [] }));

// ---------- errors ----------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const known = err instanceof RuleError || err instanceof Forbidden || err instanceof NotFound || err.code === 'LIMIT_FILE_SIZE';
  if (!known) console.error(err);
  const message = known ? err.message : 'Something went wrong. The error has been logged.';
  const details = err.details || [];
  if (req.method === 'POST' && known && !(err instanceof NotFound)) {
    const old = { ...req.body };
    delete old._csrf;
    for (const k of Object.keys(old)) if (typeof old[k] === 'string' && old[k].startsWith('data:')) delete old[k];
    req.session.flash = { error: message, details, old };
    return res.redirect(req.get('Referer') || '/');
  }
  res.status(err.status || 500).render('error', { title: 'Error', message, details, status: err.status || 500 });
});

if (require.main === module) {
  require('./services/jobs').schedule();
  require('./services/jobs').catchUp().catch((e) => console.error('[nightly catch-up]', e));
  app.listen(config.PORT, () => console.log(`Loan Management System on http://localhost:${config.PORT} (Port Moresby date ${dates.fmt(dates.today())})`));
}

module.exports = app;
