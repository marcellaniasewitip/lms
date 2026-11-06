'use strict';
// Nightly run at midnight Port Moresby time: weekly interest, reminders, maturity and
// grace transitions, ticket expiry, the expiry/archive check, retention deletion,
// stock-count reminders and the daily encrypted backup.
const db = require('../db');
const dates = require('../lib/dates');
const money = require('../lib/money');
const audit = require('../lib/audit');
const loans = require('./loans');
const archive = require('./archive');
const notify = require('./notify');
const customers = require('./customers');

function lastRunDate() {
  const r = db.get().prepare("SELECT MAX(run_date) d FROM job_runs WHERE job = 'nightly' AND finished_at IS NOT NULL").get();
  return r && r.d;
}

function nightlyFor(onDate, triggeredBy = null) {
  const d = db.get();
  const ctx = { user: null, today: onDate };
  const run = d.prepare("INSERT INTO job_runs(job, run_date, started_at, triggered_by) VALUES ('nightly', ?, ?, ?)").run(onDate, dates.nowIso(), triggeredBy).lastInsertRowid;
  const s = { interest: 0, reminders: 0, grace: 0, forfeitDue: 0, ticketsExpired: 0, archived: 0, blocked: 0, deleted: 0 };
  const open = d.prepare("SELECT * FROM loans WHERE archived = 0 AND status IN ('active','in_grace')").all();
  for (const l0 of open) {
    d.transaction(() => {
      const res = loans.sync(ctx, l0.id, { upTo: onDate });
      s.interest += res ? res.newWeekly.length : 0;
      const l = loans.get(l0.id);
      if (!loans.PAYABLE.includes(l.status)) return;
      const tot = money.fmt(loans.total(l));
      const left = dates.diffDays(onDate, l.maturity_date);
      if ([14, 7, 1].includes(left) && l.status === 'active') {
        loans.notifyCustomer('maturity_reminder', l, { days: left, maturity: dates.fmt(l.maturity_date), total: tot });
        notify.inApp({ userId: l.loan_officer_id, title: `Loan ${l.loan_no} matures in ${left} day(s)`, body: `${tot} owing; due ${dates.fmt(l.maturity_date)}`, link: `/loans/${l.id}` });
        s.reminders++;
      }
      if (onDate >= l.maturity_date && l.status === 'active' && loans.total(l) > 0) {
        loans.setStatus(ctx, l, 'in_grace', `Not paid by the maturity date; grace period to ${dates.fmt(l.grace_end_date)}`);
        loans.notifyCustomer('grace_started', l, { total: tot, graceEnd: dates.fmt(l.grace_end_date) });
        const c = customers.get(l.customer_id);
        notify.task({ type: 'call', loanId: l.id, customerId: c.id, branchId: l.branch_id, role: 'loan_officer', dueDate: onDate,
          title: `Call ${customers.fullName(c)} on ${customers.displayMobile(c.mobile)}: loan ${l.loan_no} in grace; item forfeited on ${dates.fmt(l.grace_end_date)} unless ${tot} is paid` });
        notify.inApp({ userId: l.loan_officer_id, title: `Loan ${l.loan_no} is in grace`, body: `Phone the customer. ${tot} owing.`, link: `/loans/${l.id}` });
        notify.inApp({ role: 'cro', branchId: l.branch_id, title: `Loan ${l.loan_no} is in grace`, body: `Grace ends ${dates.fmt(l.grace_end_date)}`, link: `/loans/${l.id}` });
        s.grace++;
      }
      const lg = loans.get(l.id);
      if (lg.status === 'in_grace' && dates.diffDays(onDate, lg.grace_end_date) === 1) {
        loans.notifyCustomer('grace_ends_tomorrow', lg, { total: money.fmt(loans.total(lg)), graceEnd: dates.fmt(lg.grace_end_date) });
        notify.inApp({ role: 'cro', branchId: lg.branch_id, title: `Grace ends tomorrow: loan ${lg.loan_no}`, body: 'The item will be forfeited if not paid.', link: `/loans/${lg.id}` });
      }
      if (lg.status === 'in_grace' && onDate === lg.grace_end_date) {
        notify.inApp({ role: 'cro', branchId: lg.branch_id, title: `Forfeiture to declare: loan ${lg.loan_no}`, body: `${money.fmt(loans.total(lg))} still owing at the grace end date.`, link: `/loans/${lg.id}` });
        s.forfeitDue++;
      }
    })();
  }
  // Ticket expiry: not redeemed by the redemption date.
  s.ticketsExpired = d.prepare(`UPDATE tickets SET status = 'expired' WHERE status = 'active' AND loan_id IN (
    SELECT id FROM loans WHERE status IN ('in_grace','forfeited') OR (maturity_date IS NOT NULL AND maturity_date < ? AND status IN ('active','in_grace')))`).run(onDate).changes;
  const ex = archive.runExpiry(ctx, onDate);
  s.archived = ex.archived; s.blocked = ex.blocked.length;
  s.deleted = archive.runRetention(ctx, onDate);
  // Monthly stock count due on the 1st.
  if (onDate.slice(8) === '01') {
    for (const b of d.prepare('SELECT * FROM branches WHERE active = 1').all()) {
      for (const role of ['loan_officer', 'cro', 'admin']) notify.inApp({ role, branchId: role === 'admin' ? null : b.id, title: `Monthly stock count due: ${b.name}`, body: `Count every item held for ${onDate.slice(0, 7)}.`, link: '/stock' });
    }
  }
  const summary = `${s.interest} interest charges; ${s.reminders} maturity reminders; ${s.grace} moved to grace; ${s.forfeitDue} forfeitures to declare; ${s.ticketsExpired} tickets expired; ${s.archived} archived (${s.blocked} blocked); ${s.deleted} permanently deleted`;
  d.prepare('UPDATE job_runs SET finished_at = ?, summary = ? WHERE id = ?').run(dates.nowIso(), summary, run);
  audit.log(ctx, 'nightly_run', 'job', onDate, null, { summary, blocked: ex.blocked });
  return summary;
}

// Runs every date that was missed (for example after an outage) up to today.
async function catchUp(triggeredBy = null) {
  const t = dates.today();
  const last = lastRunDate();
  let d = last ? dates.addDays(last, 1) : t;
  const out = [];
  if (triggeredBy && last === t) out.push(`${t}: ${nightlyFor(t, triggeredBy)}`);
  while (d <= t) { out.push(`${d}: ${nightlyFor(d, triggeredBy)}`); d = dates.addDays(d, 1); }
  try { await require('./backup').run(); } catch (e) { console.error('[backup]', e.message); }
  await notify.flushSms();
  return out;
}

function schedule() {
  const cron = require('node-cron');
  cron.schedule('0 0 * * *', () => catchUp().catch((e) => console.error('[nightly]', e)), { timezone: 'Pacific/Port_Moresby' });
  cron.schedule('*/1 * * * *', () => notify.flushSms().catch(() => {}), { timezone: 'Pacific/Port_Moresby' });
}

module.exports = { nightlyFor, catchUp, schedule, lastRunDate };
