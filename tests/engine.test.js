'use strict';
const test = require('node:test');
const assert = require('node:assert');
const engine = require('../src/lib/engine');
const dates = require('../src/lib/dates');
const money = require('../src/lib/money');

test('worked example from the system description (K1,000 at 10%)', () => {
  const base = { principal: 100000, rate: 10, releaseDate: '2026-11-02' };
  const pay1 = { type: 'payment', id: 1, date: '2026-11-06', order: 1, amount: 30000 };
  // 02/11: week 1 interest added
  let r = engine.replay({ ...base, upTo: '2026-11-02' });
  assert.equal(r.charges[0].amount, 10000);
  assert.equal(r.total, 110000);
  // 06/11: part payment K300 -> principal 800, total 800
  r = engine.replay({ ...base, events: [pay1], upTo: '2026-11-06' });
  assert.equal(r.principal, 80000); assert.equal(r.total, 80000);
  assert.deepEqual([r.allocations[1].interest, r.allocations[1].principal], [10000, 20000]);
  // 09/11 and 16/11: K80 interest each week on the K800 principal still owed
  r = engine.replay({ ...base, events: [pay1], upTo: '2026-11-16' });
  assert.deepEqual(r.charges.map((c) => c.amount), [10000, 8000, 8000]);
  assert.equal(r.total, 96000);
  // 20/11: paid in full with K960
  const pay2 = { type: 'payment', id: 2, date: '2026-11-20', order: 2, amount: 96000 };
  r = engine.replay({ ...base, events: [pay1, pay2], upTo: '2026-11-20' });
  assert.equal(r.total, 0);
  assert.equal(r.paidTotal, 126000); // K1,260 paid in total
  assert.equal(r.zeroDate, '2026-11-20');
  assert.equal(r.nextInterest, null);
});

test('pledge ticket sample: K140 at 20% from 01/08/2026 to 17/10/2026 = K476', () => {
  const r = engine.redemptionPrice({ principal: 14000, rate: 20, releaseDate: '2026-08-01', redemptionDate: '2026-10-17' });
  assert.equal(r.weeklyCharge, 2800);
  assert.equal(r.charges, 12);
  assert.equal(r.totalCharges, 33600);
  assert.equal(r.price, 47600);
});

test('key dates: maturity 3 months after release, grace end 7 days later', () => {
  assert.deepEqual(engine.keyDates('2026-11-02'), { maturity: '2027-02-02', graceEnd: '2027-02-09' });
  assert.equal(engine.keyDates('2026-11-30').maturity, '2027-02-28'); // month-end clamp
});

test('fees are paid first, then interest, then principal; overpayment is reported', () => {
  const r = engine.replay({
    principal: 50000, rate: 15, releaseDate: '2026-01-05', fees: [{ amount: 5000 }],
    events: [{ type: 'payment', id: 9, date: '2026-01-05', order: 1, amount: 70000 }], upTo: '2026-01-05',
  });
  assert.deepEqual(r.allocations[9], { fees: 5000, interest: 7500, principal: 50000, over: 7500, balanceAfter: 0 });
});

test('waivers reduce interest owing only, never below zero', () => {
  const r = engine.replay({
    principal: 100000, rate: 10, releaseDate: '2026-01-01',
    events: [{ type: 'waiver', id: 1, kind: 'interest', date: '2026-01-02', order: 1, amount: 50000 }], upTo: '2026-01-02',
  });
  assert.equal(r.waiversApplied[1], 10000);
  assert.equal(r.total, 100000);
});

test('interest stops at forfeiture', () => {
  const r = engine.replay({ principal: 10000, rate: 10, releaseDate: '2026-01-01', upTo: '2026-06-01', stopDate: '2026-04-08' });
  assert.equal(r.charges.at(-1).date <= '2026-04-08', true);
  assert.equal(r.nextInterest, null);
});

test('dates and money helpers', () => {
  assert.equal(dates.fmt('2026-11-02'), '02/11/2026');
  assert.equal(dates.parse('2/11/2026'), '2026-11-02');
  assert.equal(dates.parse('31/02/2026'), null);
  assert.equal(dates.ageOn('2008-11-03', '2026-11-02'), 17);
  assert.equal(dates.ageOn('2008-11-02', '2026-11-02'), 18);
  assert.equal(money.fmt(150000), 'K1,500.00');
  assert.equal(money.parse('K1,500.50'), 150050);
  assert.equal(money.parse('abc'), null);
  assert.equal(money.pct(12345, 13), 1605);
});
