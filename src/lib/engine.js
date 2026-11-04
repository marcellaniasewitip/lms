'use strict';
// Pure loan arithmetic. No database access here so it can be tested directly.
//
// Rules (from the system description):
//  - Interest is added once a week on the principal still owed: on the release date
//    (week 1, so the minimum interest is one week) and every 7 days after.
//  - Unpaid interest is never itself charged interest.
//  - Each payment clears fees first, then interest, then principal.
//  - Interest keeps being added through the grace period and stops when the item is
//    forfeited (the forfeiture date is the last interest date that can apply).
const dates = require('./dates');
const money = require('./money');

function interestDates(releaseDate, upTo, stopDate) {
  const out = [];
  for (let d = releaseDate; d <= upTo && (!stopDate || d <= stopDate); d = dates.addDays(d, 7)) out.push(d);
  return out;
}

/**
 * Replays a loan from its release.
 * @param {object} p
 *  principal (toea), rate (% per week), releaseDate, fees [{amount}] (charged on release date),
 *  events [{type:'payment'|'waiver', id, date, order, amount, kind}] — waiver kind is 'interest' or 'fees',
 *  upTo (date to replay to, inclusive), stopDate (forfeiture date or null)
 */
function replay({ principal, rate, releaseDate, fees = [], events = [], upTo, stopDate = null }) {
  const s = { p: principal, i: 0, f: 0 };
  const charges = [];
  const allocations = {};
  const waiversApplied = {};
  let interestTotal = 0, feesTotal = 0, paidTotal = 0, waivedTotal = 0, zeroDate = null;

  const sorted = events.filter((e) => e.date <= upTo)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.order || 0) - (b.order || 0)));
  const iDates = interestDates(releaseDate, upTo, stopDate);
  const days = [...new Set([...iDates, ...sorted.map((e) => e.date)])].sort();
  if (!days.includes(releaseDate)) days.unshift(releaseDate);

  for (const day of days) {
    if (day < releaseDate) continue;
    if (day === releaseDate) for (const fee of fees) { s.f += fee.amount; feesTotal += fee.amount; }
    // Interest is added at the start of the interest date, before that day's payments.
    if (iDates.includes(day) && s.p > 0) {
      const amt = money.pct(s.p, rate);
      charges.push({ date: day, principal: s.p, rate, amount: amt });
      s.i += amt; interestTotal += amt;
    }
    for (const e of sorted.filter((x) => x.date === day)) {
      if (e.type === 'payment') {
        let left = e.amount;
        const a = { fees: Math.min(left, s.f) }; left -= a.fees; s.f -= a.fees;
        a.interest = Math.min(left, s.i); left -= a.interest; s.i -= a.interest;
        a.principal = Math.min(left, s.p); left -= a.principal; s.p -= a.principal;
        a.over = left;
        a.balanceAfter = s.p + s.i + s.f;
        paidTotal += e.amount - left;
        allocations[e.id] = a;
      } else if (e.type === 'waiver') {
        const key = e.kind === 'fees' ? 'f' : 'i';
        const applied = Math.min(e.amount, s[key]);
        s[key] -= applied; waivedTotal += applied; waiversApplied[e.id] = applied;
      }
      if (s.p + s.i + s.f === 0 && !zeroDate) zeroDate = day;
    }
    if (s.p + s.i + s.f > 0) zeroDate = null;
  }
  const nextInterest = (() => {
    if (s.p <= 0) return null;
    let d = releaseDate;
    while (d <= upTo) d = dates.addDays(d, 7);
    return stopDate && d > stopDate ? null : d;
  })();
  return {
    charges, allocations, waiversApplied,
    principal: s.p, interest: s.i, fees: s.f, total: s.p + s.i + s.f,
    interestTotal, feesTotal, paidTotal, waivedTotal, zeroDate, nextInterest,
  };
}

// Key dates fixed at release.
function keyDates(releaseDate, { termMonths = 3, graceDays = 7 } = {}) {
  const maturity = dates.addMonths(releaseDate, termMonths);
  return { maturity, graceEnd: dates.addDays(maturity, graceDays) };
}

// Pledge-ticket figures: the weekly charge on the amount advanced and the redemption
// price if nothing is paid before the redemption (maturity) date.
function redemptionPrice({ principal, rate, releaseDate, redemptionDate, fees = 0 }) {
  const n = interestDates(releaseDate, redemptionDate).length;
  const weekly = money.pct(principal, rate);
  return { weeklyCharge: weekly, charges: n, totalCharges: weekly * n, fees, price: principal + weekly * n + fees };
}

module.exports = { replay, keyDates, redemptionPrice, interestDates };
