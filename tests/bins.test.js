'use strict';
// Bin # rules: every item goes into a numbered bin (cars: yard bay + key bin), full bins are
// refused, bins move with the item and are freed when it leaves.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-bins-'));
process.env.LMS_DATA_DIR = dir;
process.env.LMS_DB_FILE = path.join(dir, 'bins.db');

const db = require('../src/db');
const settings = require('../src/services/settings');
const users = require('../src/services/users');
const customers = require('../src/services/customers');
const items = require('../src/services/items');
const loans = require('../src/services/loans');
const bins = require('../src/services/bins');
const fx = require('../scripts/fixtures');

db.open();
settings.seedReferenceData();
const svc = { db, customers, items };
const mk = (u, role) => users.get(users.create(null, { username: u, full_name: u, role, branch_id: 1, mobile: '(+675) 7100-0001', password: 'Str0ng!Passw0rd' }));
const admin = mk('admin1', 'admin'), lo = mk('lo1', 'loan_officer'), cro = mk('cro1', 'cro');
const C = (u) => fx.ctxFor(u, '2026-11-05');
const rx = (re) => (e) => { assert.match([e.message, ...(e.details || [])].join(' | '), re); return true; };
const bin = (kind, no) => db.get().prepare('SELECT * FROM bins WHERE branch_id = 1 AND kind = ? AND bin_no = ?').get(kind, no);

let cust;
test.before(() => { cust = fx.makeCustomer(svc, lo, cro, '2026-11-05', { surname: 'Bin', given: 'Tester', dob: '01/01/1990', mobile: '71112222', nid: 'NIDBIN1', second: 'EMPBIN1' }); });

test('each branch starts with numbered store bins, key bins and yard bays', () => {
  assert.equal(bins.forBranch(1, 'store').length, 40);
  assert.equal(bins.forBranch(1, 'key').length, 20);
  assert.equal(bins.forBranch(1, 'yard').length, 10);
  assert.equal(bins.label(bin('store', 'B-007')), 'Bin B-007');
  assert.equal(bins.findByText(1, 'b7').bin_no, 'B-007');
  assert.equal(bins.findByText(1, 'Key bin K-3').bin_no, 'K-03');
});

test('laptops and phones must go into a store bin; the bin # is the item location', () => {
  assert.throws(() => fx.makeItem(svc, lo, '2026-11-05', cust, 'laptop', { owner: 'Tester Bin', serial: 'SNBIN0001', bin_id: '' }), rx(/Choose the bin number/));
  assert.throws(() => fx.makeItem(svc, lo, '2026-11-05', cust, 'laptop', { owner: 'Tester Bin', serial: 'SNBIN0001', bin_id: bin('key', 'K-01').id }), rx(/store bin/i));
  const id = fx.makeItem(svc, lo, '2026-11-05', cust, 'laptop', { owner: 'Tester Bin', serial: 'SNBIN0001', bin_id: bin('store', 'B-005').id });
  const it = items.get(id);
  assert.equal(it.location, 'Bin B-005');
  assert.equal(bins.contents(bin('store', 'B-005').id).length, 1);
});

test('cars need a yard bay and a key bin; a key bin holds one set of keys', () => {
  assert.throws(() => fx.makeItem(svc, lo, '2026-11-05', cust, 'car', { owner: 'Tester Bin', vin: 'VINBIN0001', engine: 'ENG0001', plate: 'BIN001', bin_id: bin('yard', 'Y-01').id, key_bin_id: '' }), rx(/key bin number/));
  const car = fx.makeItem(svc, lo, '2026-11-05', cust, 'car', { owner: 'Tester Bin', vin: 'VINBIN0001', engine: 'ENG0001', plate: 'BIN001', bin_id: bin('yard', 'Y-01').id, key_bin_id: bin('key', 'K-01').id });
  assert.deepEqual([items.get(car).location, items.get(car).safe_location], ['Yard bay Y-01', 'Key bin K-01']);
  assert.throws(() => fx.makeItem(svc, lo, '2026-11-05', cust, 'car', { owner: 'Tester Bin', vin: 'VINBIN0002', engine: 'ENG0002', plate: 'BIN002', bin_id: bin('yard', 'Y-02').id, key_bin_id: bin('key', 'K-01').id }), rx(/Key bin K-01 is full/));
  assert.throws(() => fx.makeItem(svc, lo, '2026-11-05', cust, 'car', { owner: 'Tester Bin', vin: 'VINBIN0002', engine: 'ENG0002', plate: 'BIN002', bin_id: bin('yard', 'Y-01').id, key_bin_id: bin('key', 'K-02').id }), rx(/Yard bay Y-01 is full/));
});

test('moving an item changes its bin and is recorded', () => {
  const it = items.forCustomer(cust).find((i) => i.category === 'car');
  items.move(C(lo), it.id, { to_key_bin_id: bin('key', 'K-05').id, reason: 'Safe drawer rearranged' });
  assert.equal(items.get(it.id).safe_location, 'Key bin K-05');
  assert.equal(bins.contents(bin('key', 'K-01').id).length, 0);
  assert.match(items.movements(it.id).at(-1).to_location, /Key bin K-05/);
});

test('the Admin can add a numbered range of bins; a bin with items cannot be closed', () => {
  const out = bins.create(C(admin), { branch_id: 1, kind: 'store', from: 41, to: 45, capacity: 3 });
  assert.equal(out.added, 5);
  assert.ok(bin('store', 'B-045'));
  assert.throws(() => bins.create(C(lo), { branch_id: 1, kind: 'store', from: 1, to: 2 }), /Admin/);
  assert.throws(() => bins.update(C(admin), bin('store', 'B-005').id, { active: false }), rx(/still holds 1 item/));
});

test('returning the item frees its bin', () => {
  const laptop = items.forCustomer(cust).find((i) => i.category === 'laptop');
  const t = '2026-11-05';
  const id = loans.createApplication(C(lo), { customer_id: cust, item_ids: [laptop.id], requested_amount: '500' });
  loans.submit(C(lo), id);
  loans.valuate(C(cro), id, laptop.id, { ...fx.valuationData(svc, 'laptop', { market: '2,000' }), ownership_note: 'ok' });
  loans.decide(C(cro), id, { decision: 'approve', amount: '500', rate: 10 });
  loans.release(C(lo), id, { channel: 'cash', agreement_signed: 1 });
  loans.postPayment(C(lo), id, { amount: '550', channel: 'cash' });
  const rec = customers.ids(cust)[0];
  loans.returnItems(fx.ctxFor(lo, t), id, { ticket_presented: 1, condition_checked: 1, signatureDataUrl: fx.DATA_URL, id_record_id: rec.id, id_number_shown: 'NIDBIN1' });
  const after = items.get(laptop.id);
  assert.equal(after.bin_id, null);
  assert.equal(bins.contents(bin('store', 'B-005').id).length, 0);
});
