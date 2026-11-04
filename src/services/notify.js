'use strict';
const db = require('../db');
const { SMS_GATEWAY_URL, SMS_GATEWAY_TOKEN } = require('../config');

// Customer SMS in English or Tok Pisin. Tok Pisin wording should be reviewed by a
// native-speaking staff member before go-live.
const TEMPLATES = {
  mobile_code: {
    en: 'Your {lender} verification code is {code}. Do not share it.',
    tpi: 'Namba kod bilong {lender} em {code}. No ken givim long narapela man.',
  },
  app_approved: {
    en: 'Loan {loan}: your application is approved for {amount} at {rate}% a week. Please come to {branch} to sign and collect.',
    tpi: 'Loan {loan}: aplikesen bilong yu i kisim orait long {amount}, interes {rate}% long wanpela wik. Plis kam long {branch} long sainim na kisim mani.',
  },
  app_returned: {
    en: 'Loan {loan}: your application needs more information. A loan officer will contact you.',
    tpi: 'Loan {loan}: aplikesen bilong yu i nidim moa infomesen. Wanpela loan ofisa bai toktok wantaim yu.',
  },
  app_rejected: {
    en: 'Loan {loan}: sorry, your application was not approved. Please collect your item at {branch} with your ID.',
    tpi: 'Loan {loan}: sori, aplikesen bilong yu i no kisim orait. Plis kam kisim samting bilong yu long {branch} wantaim ID bilong yu.',
  },
  released: {
    en: 'Loan {loan}: {amount} released at {rate}% a week. Pay in full by {maturity} to collect your item. Quote {loan} as payment reference.',
    tpi: 'Loan {loan}: {amount} i go long yu, interes {rate}% long olgeta wik. Peim olgeta long {maturity} bilong kisim bek samting bilong yu. Raitim {loan} taim yu peim.',
  },
  interest_added: {
    en: 'Loan {loan}: this week\'s interest of {interest} was added. Amount to collect your item today: {total}.',
    tpi: 'Loan {loan}: interes bilong dispela wik {interest} i go antap. Mani bilong kisim bek samting bilong yu tude: {total}.',
  },
  payment_received: {
    en: 'Loan {loan}: we received {amount}, receipt {receipt}. Amount left to pay: {total}.',
    tpi: 'Loan {loan}: mipela kisim {amount}, risit {receipt}. Mani i stap yet long peim: {total}.',
  },
  maturity_reminder: {
    en: 'Loan {loan}: {days} day(s) until your due date {maturity}. Amount to collect your item today: {total}.',
    tpi: 'Loan {loan}: i gat {days} de i stap long de bilong peim, {maturity}. Mani bilong kisim bek samting bilong yu tude: {total}.',
  },
  grace_started: {
    en: 'Loan {loan}: your due date has passed. Pay {total} in full by {graceEnd} or your item will be forfeited and sold.',
    tpi: 'Loan {loan}: de bilong peim i pinis. Peim olgeta {total} long {graceEnd} o samting bilong yu bai lus na mipela bai salim.',
  },
  grace_ends_tomorrow: {
    en: 'Loan {loan}: tomorrow {graceEnd} is the last day. Pay {total} in full or your item will be forfeited.',
    tpi: 'Loan {loan}: tumora {graceEnd} em las de. Peim olgeta {total} o samting bilong yu bai lus.',
  },
  paid_in_full: {
    en: 'Loan {loan} is fully paid. Your item is ready to collect at {branch}. Bring your pledge ticket and the same ID.',
    tpi: 'Loan {loan} i pinis olgeta. Samting bilong yu i redi long {branch}. Bringim tiket na wankain ID.',
  },
};

function render(tpl, vars) { return tpl.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : '')); }

function sms(template, { to, language = 'en', customerId = null, loanId = null, userId = null, vars = {} }) {
  const t = TEMPLATES[template];
  if (!t) throw new Error('Unknown SMS template ' + template);
  const settings = require('./settings');
  const body = render(t[language] || t.en, { lender: settings.get('lender_name'), ...vars });
  const info = db.get().prepare(`INSERT INTO sms_outbox(to_number, language, template, body, customer_id, loan_id, user_id, created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(to, language, template, body, customerId, loanId, userId, new Date().toISOString());
  return info.lastInsertRowid;
}

// Sends queued SMS through the configured gateway. With no gateway configured, messages
// are marked 'logged' so they can be read in the SMS outbox screen (training mode).
async function flushSms() {
  const rows = db.get().prepare("SELECT * FROM sms_outbox WHERE status = 'queued' ORDER BY id LIMIT 200").all();
  for (const r of rows) {
    let status = 'logged', error = null;
    if (SMS_GATEWAY_URL) {
      try {
        const res = await fetch(SMS_GATEWAY_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SMS_GATEWAY_TOKEN}` },
          body: JSON.stringify({ to: r.to_number, message: r.body }),
        });
        status = res.ok ? 'sent' : 'failed';
        if (!res.ok) error = `HTTP ${res.status}`;
      } catch (e) { status = 'failed'; error = e.message; }
    }
    db.get().prepare('UPDATE sms_outbox SET status = ?, error = ?, sent_at = ? WHERE id = ?').run(status, error, new Date().toISOString(), r.id);
  }
}

// In-app notification for one user, or for everyone with a role (optionally limited to a branch).
function inApp({ userId = null, role = null, branchId = null, title, body = '', link = '' }) {
  db.get().prepare('INSERT INTO notifications(user_id, role, branch_id, title, body, link, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(userId, role, branchId, title, body, link, new Date().toISOString());
}

function forUser(user, { unreadOnly = false, limit = 100 } = {}) {
  return db.get().prepare(`SELECT n.*, (r.user_id IS NOT NULL) AS is_read FROM notifications n
    LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = @uid
    WHERE (n.user_id = @uid OR (n.user_id IS NULL AND n.role = @role AND (n.branch_id IS NULL OR @branch IS NULL OR n.branch_id = @branch)))
    ${unreadOnly ? 'AND r.user_id IS NULL' : ''}
    ORDER BY n.id DESC LIMIT @limit`).all({ uid: user.id, role: user.role, branch: user.branch_id, limit });
}
function unreadCount(user) { return forUser(user, { unreadOnly: true, limit: 1000 }).length; }
function markRead(user, id) {
  db.get().prepare('INSERT OR IGNORE INTO notification_reads(notification_id, user_id) VALUES (?, ?)').run(id, user.id);
}
function markAllRead(user) { for (const n of forUser(user, { unreadOnly: true, limit: 5000 })) markRead(user, n.id); }

function task({ type = 'call', loanId = null, customerId = null, branchId = null, role = 'loan_officer', title, dueDate = null }) {
  db.get().prepare('INSERT INTO tasks(type, loan_id, customer_id, branch_id, role, title, due_date, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(type, loanId, customerId, branchId, role, title, dueDate, new Date().toISOString());
}

module.exports = { TEMPLATES, sms, flushSms, inApp, forUser, unreadCount, markRead, markAllRead, task };
