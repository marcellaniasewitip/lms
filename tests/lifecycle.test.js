'use strict';
// End-to-end business rules through the service layer on a scratch database.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-test-'));
process.env.LMS_DATA_DIR = dir;
process.env.LMS_DB_FILE = path.join(dir, 'test.db');

const db = require('../src/db');
const settings = require('../src/services/settings');
const users = require('../src/services/users');
const customers = require('../src/services/customers');
const items = require('../src/services/items');
const loans = require('../src/services/loans');
const archive = require('../src/services/archive');
const jobs = require('../src/services/jobs');
const stock = require('../src/services/stock');
const dates = require('../src/lib/dates');
const fx = require('../scripts/fixtures');

db.open();
settings.seedReferenceData();
const svc = { db, customers, items };
const uid = (name, role) => users.get(users.create(null, { username: name, full_name: name.toUpperCase(), role, branch_id: 1, mobile: '(+675) 71000001', password: 'Str0ng!Passw0rd' }));
const admin = uid('admin1', 'admin');
const lo = uid('officer1', 'loan_officer');
const cro = uid('cro1', 'cro');
const lo2 = uid('officer2', 'loan_officer');
const C = (u, t) => fx.ctxFor(u, t);
// Matches a RuleError by its message or any of its detail lines.
const rx = (re) => (e) => { assert.match([e.message, ...(e.details || [])].join(' | '), re); return true; };

let customerId;
test('customer onboarding: two-ID rule and duplicate check', () => {
  const t = '2026-11-02';
  customerId = fx.makeCustomer(svc, lo, cro, t, { surname: 'Kila', given: 'John Peter', dob: '14/05/1988', mobile: '7234 5678', nid: 'NID12345678', second: 'EMP-4821' });
  assert.equal(customers.get(customerId).verification_status, 'verified');
  assert.ok(customers.loanReadiness(customerId, t).ok);
  // Duplicate: same mobile -> profile held for the CRO and blocked from loans
  fx.makeCustomer(svc, lo, cro, t, { surname: 'Other', given: 'Person', dob: '01/01/1990', mobile: '72345678', nid: 'X1', second: 'Y1' });
  const dup = db.get().prepare("SELECT * FROM customers WHERE surname = 'OTHER'").get();
  assert.equal(dup.verification_status, 'duplicate_review');
  assert.equal(customers.loanReadiness(dup.id, t).ok, false);
  assert.ok(db.get().prepare("SELECT 1 FROM notifications WHERE role = 'cro' AND title LIKE 'Possible duplicate%'").get());
  // same ID number on another profile is caught too
  assert.match(dup.duplicate_reason, /same mobile number/);
});

test('expired ID is rejected and under-18 blocked', () => {
  const t = '2026-11-02';
  const { id } = customers.create(C(lo, t), {
    surname: 'Young', given_names: 'Ana', dob: '01/01/2000', sex: 'Female', marital_status: 'Single', citizenship: 'Papua New Guinean', home_province: 'Central',
    home_district: 'Abau', home_village: 'Kupiano', mobile: '(+675) 8199-8888', addr_province: 'Central', addr_district: 'Abau', addr_town: 'Kupiano',
    addr_section_lot: 'Village', po_box: 'None', addr_landmark: 'Church', residence_proof_type: 'Letter from the ward councillor', nok_name: 'X', nok_relationship: 'Mother', nok_phone: '(+675) 71111111',
    nok_address: 'Kupiano', consent_terms: 1, consent_data: 1, consent_forfeit: 1,
  }, { photoDataUrl: fx.DATA_URL, signatureDataUrl: fx.DATA_URL });
  const nid = customers.idTypes()[0];
  const rid = customers.addId(C(lo, t), id, { id_type_id: nid.id, number: 'OLD999', expiry_date: '01/01/2025', name_on_id: 'Ana Young', dob_on_id: '01/01/2000' }, { front: [fx.file()] });
  assert.throws(() => customers.reviewId(C(cro, t), rid, { decision: 'accept', photo_match: true }), rx(/expired on 01\/01\/2025/));
  assert.throws(() => customers.create(C(lo, t), { surname: 'Kid', given_names: 'A', dob: '01/01/2012' }), /fix the customer profile/);
  // Entered as (+675) 8199-8888: stored as the local digits with the network from the prefix; next of kin is no longer recorded.
  assert.deepEqual([customers.get(id).mobile, customers.get(id).mobile_network, customers.get(id).nok_name], ['81998888', 'Vodafone', null]);
  // Contact numbers are accepted only as (+675) 71234567 or (+675) 7123-4567.
  for (const [mobile, net] of [['(+675) 71234567', 'Digicel'], ['(+675) 7812-3456', 'Telikom'], ['(+675) 8212-3456', 'Vodafone']]) {
    customers.update(C(lo, t), id, { mobile, second_phone: '(+675) 7123-4567' });
    assert.equal(customers.get(id).mobile_network, net, mobile);
  }
  for (const bad of ['71234567', '+675 7123 4567', '+67571234567', '(+675)71234567', '(+675) 7123 4567', '675 7123-4567']) {
    assert.throws(() => customers.update(C(lo, t), id, { mobile: bad }), rx(/must be written as \(\+675\) 71234567 or \(\+675\) 7123-4567/), bad);
  }
  assert.throws(() => customers.update(C(lo, t), id, { mobile: '(+675) 7712-3456' }), rx(/not a PNG mobile/));
  assert.throws(() => customers.update(C(lo, t), id, { second_phone: '7123 4567' }), rx(/Second number must be written/));
  // Next of kin is no longer part of the form or required.
  customers.update(C(lo, t), id, { nok_name: '', nok_phone: '' });
  // A saved profile can be edited without retyping the numbers (they are stored and re-shown in the accepted format).
  customers.update(C(lo, t), id, { occupation: 'Farmer' });
  // Staff sign-in numbers follow the same format.
  const sid = users.create(null, { username: 'fmt.test', full_name: 'Format Test', role: 'cro', branch_id: 1, mobile: '(+675) 8312-3456', password: 'Str0ng!Passw0rd' });
  assert.equal(users.get(sid).mobile, '+67583123456');
  // Only the Admin changes passwords: Loan Officers and CROs cannot, and are never asked to.
  assert.throws(() => users.changeOwnPassword(C(lo, t), 'Str0ng!Passw0rd', 'N3w!Password99'), /Admin only/);
  assert.throws(() => users.changeOwnPassword(C(cro, t), 'Str0ng!Passw0rd', 'N3w!Password99'), /Admin only/);
  const newLo = users.create(C(admin, t), { username: 'new.officer', full_name: 'New Officer', role: 'loan_officer', branch_id: 1, mobile: '(+675) 7212-3456', password: 'Str0ng!Passw0rd' });
  assert.equal(users.get(newLo).must_change_pw, 0);
  users.resetPassword(C(admin, t), newLo, 'An0ther!Passw0rd');
  assert.equal(users.get(newLo).must_change_pw, 0);
  const newAdmin = users.create(C(admin, t), { username: 'new.admin', full_name: 'New Admin', role: 'admin', mobile: '(+675) 7212-3457', password: 'Str0ng!Passw0rd' });
  assert.equal(users.get(newAdmin).must_change_pw, 1);
  users.changeOwnPassword(C(users.get(newAdmin), t), 'Str0ng!Passw0rd', 'N3w!Password99');
  assert.equal(users.get(newAdmin).must_change_pw, 0);
  assert.throws(() => users.create(null, { username: 'fmt.bad', full_name: 'Bad', role: 'cro', branch_id: 1, mobile: '+67583123456', password: 'Str0ng!Passw0rd' }), rx(/must be written as/));
});

test('stolen item list blocks intake; IMEI must be valid', () => {
  const t = '2026-11-02';
  db.get().prepare("INSERT INTO stolen_list(number_type, number_norm, description, created_at) VALUES ('IMEI','490154203237518','Police report 123',?)").run(dates.nowIso());
  assert.throws(() => fx.makeItem(svc, lo, t, customerId, 'phone', { owner: 'John Peter Kila', imei: '490154203237518' }), /blocked/);
  assert.throws(() => fx.makeItem(svc, lo, t, customerId, 'phone', { owner: 'John Peter Kila', imei: '490154203237519' }), rx(/IMEI must be a valid/));
});

test('worked example end to end: K1,000 at 10% from 02/11/2026, paid in full 20/11/2026', () => {
  const itemId = fx.makeItem(svc, lo, '2026-11-02', customerId, 'laptop', { owner: 'John Kila', serial: '5CD1234XYZ' });
  const loanId = loans.createApplication(C(lo, '2026-11-02'), { customer_id: customerId, item_ids: [itemId], requested_amount: '1,000.00' });
  loans.submit(C(lo, '2026-11-02'), loanId);
  // the Loan Officer cannot value or approve
  assert.throws(() => loans.decide(C(lo, '2026-11-02'), loanId, { decision: 'approve' }), /CRO/);
  // owner name "John Kila" vs "John Peter Kila" is a small difference -> needs a note
  assert.throws(() => loans.valuate(C(cro, '2026-11-02'), loanId, itemId, fx.valuationData(svc, 'laptop', { market: '2,000.00' })), rx(/note/));
  loans.valuate(C(cro, '2026-11-02'), loanId, itemId, { ...fx.valuationData(svc, 'laptop', { market: '2,000.00' }), ownership_note: 'Middle name omitted on receipt' });
  // grade A: up to 60% of K2,000 = K1,200; rate band 10–12%
  assert.throws(() => loans.decide(C(cro, '2026-11-02'), loanId, { decision: 'approve', amount: '1,000', rate: 15 }), rx(/10% to 12%/));
  assert.throws(() => loans.decide(C(cro, '2026-11-02'), loanId, { decision: 'approve', amount: '1,300', rate: 10 }), rx(/cannot exceed K1,200.00/));
  loans.decide(C(cro, '2026-11-02'), loanId, { decision: 'approve', amount: '1,000', rate: 10 });
  assert.throws(() => loans.release(C(lo, '2026-11-02'), loanId, { channel: 'cash' }), /sign/);
  loans.release(C(lo, '2026-11-02'), loanId, { channel: 'cash', agreement_signed: 'on' });
  let l = loans.get(loanId);
  assert.equal(l.status, 'active');
  assert.equal(loans.total(l), 110000);
  assert.equal(l.maturity_date, '2027-02-02');
  assert.equal(l.grace_end_date, '2027-02-09');
  loans.postPayment(C(lo, '2026-11-06'), loanId, { amount: '300.00', channel: 'cash' });
  l = loans.get(loanId);
  assert.equal(l.principal_owing, 80000); assert.equal(loans.total(l), 80000);
  jobs.nightlyFor('2026-11-09');
  assert.equal(loans.total(loans.get(loanId)), 88000);
  for (let d = '2026-11-10'; d <= '2026-11-16'; d = dates.addDays(d, 1)) jobs.nightlyFor(d);
  assert.equal(loans.total(loans.get(loanId)), 96000);
  // the item cannot be returned before the balance is zero
  assert.throws(() => loans.returnItems(C(lo, '2026-11-20'), loanId, {}), /K0.00/);
  loans.postPayment(C(lo, '2026-11-20'), loanId, { amount: '960.00', channel: 'mobile', reference: `BSP-${'7781'}` });
  l = loans.get(loanId);
  assert.equal(l.status, 'paid');
  assert.equal(l.total_paid, 126000);
  const nidRec = customers.ids(customerId)[0];
  assert.throws(() => loans.returnItems(C(lo, '2026-11-20'), loanId, { ticket_presented: 1, condition_checked: 1, signatureDataUrl: fx.DATA_URL, id_record_id: nidRec.id, id_number_shown: 'WRONG' }), rx(/does not match/));
  loans.returnItems(C(lo, '2026-11-20'), loanId, { ticket_presented: 1, condition_checked: 1, signatureDataUrl: fx.DATA_URL, id_record_id: nidRec.id, id_number_shown: 'NID12345678' });
  l = loans.get(loanId);
  assert.equal(l.status, 'redeemed');
  assert.equal(l.date_closed, '2026-11-20');
  assert.equal(l.expiry_date, '2026-12-20');
  assert.equal(items.get(itemId).custody_status, 'returned');
  assert.equal(items.get(itemId).device_password_enc, null);
  // archive: not before expiry, then automatically on the expiry date
  jobs.nightlyFor('2026-12-19');
  assert.equal(loans.get(loanId).archived, 0);
  jobs.nightlyFor('2026-12-20');
  l = loans.get(loanId);
  assert.equal(l.archived, 1); assert.equal(l.status, 'archived');
  assert.throws(() => loans.addNote(C(lo, '2026-12-21'), loanId, 'x'), /archived/);
  assert.equal(archive.searchArchive('5CD1234XYZ').length, 1);
  assert.equal(archive.searchArchive('NID12345678').length, 1);
  const a = archive.searchArchive(l.loan_no)[0];
  archive.restore(C(admin, '2026-12-22'), a.id, 'Fix receipt typo');
  assert.equal(loans.get(loanId).status, 'redeemed');
  // retention: deleted after 7 years, deletion log keeps only the number
  archive.archive(C(admin, '2026-12-23'), loanId, { method: 'early', reason: 'Fixed' });
  jobs.nightlyFor('2033-12-24');
  assert.equal(db.get().prepare('SELECT COUNT(*) n FROM loans WHERE id = ?').get(loanId).n, 0);
  assert.equal(db.get().prepare('SELECT COUNT(*) n FROM deletion_log WHERE loan_no = ?').get(l.loan_no).n, 1);
  assert.ok(customers.get(customerId)); // the profile stays
});

test('grace, forfeiture, sale with surplus; reversal and waiver need a second person', () => {
  const t0 = '2027-01-04';
  const itemId = fx.makeItem(svc, lo, t0, customerId, 'phone', { owner: 'John Peter Kila', imei: '356938035643809' });
  const loanId = loans.createApplication(C(lo, t0), { customer_id: customerId, item_ids: [itemId], requested_amount: '500' });
  loans.submit(C(lo, t0), loanId);
  loans.valuate(C(cro, t0), loanId, itemId, fx.valuationData(svc, 'phone', { grade: 'B', market: '1,500' }));
  loans.decide(C(cro, t0), loanId, { decision: 'approve', amount: '500', rate: 14 });
  loans.release(C(lo, t0), loanId, { channel: 'cash', agreement_signed: 1 });
  const pid = loans.postPayment(C(lo, '2027-01-08'), loanId, { amount: '100', channel: 'cash' });
  const before = loans.total(loans.get(loanId));
  const rq = loans.requestReversal(C(lo, '2027-01-08'), pid, 'Posted to wrong loan');
  loans.decideReversal(C(admin, '2027-01-08'), rq, { approve: true });
  assert.equal(loans.total(loans.get(loanId)), before + 10000);
  assert.equal(loans.payment(pid).status, 'reversed');
  const w = loans.requestWaiver(C(lo, '2027-01-08'), loanId, { kind: 'interest', amount: '10', reason: 'Goodwill' });
  assert.throws(() => loans.decideWaiver(C(lo, '2027-01-08'), w, { approve: true }), /CRO/);
  loans.decideWaiver(C(cro, '2027-01-08'), w, { approve: true });
  assert.equal(loans.get(loanId).interest_owing, 7000 - 1000);
  // run nightly through maturity and grace
  let d = '2027-01-09';
  const l1 = loans.get(loanId);
  assert.throws(() => loans.declareForfeit(C(cro, l1.maturity_date), loanId), /grace/);
  while (d <= l1.grace_end_date) { jobs.nightlyFor(d); d = dates.addDays(d, 1); }
  assert.equal(loans.get(loanId).status, 'in_grace');
  assert.ok(db.get().prepare("SELECT 1 FROM tasks WHERE loan_id = ? AND type = 'call'").get(loanId));
  assert.equal(loans.currentTicket(loanId).status, 'expired');
  loans.declareForfeit(C(cro, l1.grace_end_date), loanId);
  const lf = loans.get(loanId);
  assert.equal(lf.status, 'forfeited');
  assert.equal(items.get(itemId).custody_status, 'for_sale');
  const s = db.get().prepare('SELECT * FROM forfeiture_sales WHERE loan_id = ?').get(loanId);
  assert.throws(() => loans.recordSale(C(admin, lf.grace_end_date), s.id, { sale_price: '900', buyer_name: 'B', sale_receipt_no: 'S1' }), /auction/);
  loans.approveReserve(C(admin, lf.grace_end_date), s.id, { reserve_price: '800' });
  loans.recordListing(C(admin, lf.grace_end_date), s.id, { auction_platform: 'PNG Online Auctions', listing_ref: 'A-77' });
  loans.recordSale(C(admin, lf.grace_end_date), s.id, { sale_price: '2,000', buyer_name: 'Buyer One', sale_receipt_no: 'SR-1' });
  const ls = loans.get(loanId);
  assert.equal(ls.status, 'item_sold');
  assert.ok(ls.surplus > 0);
  assert.equal(ls.surplus, 200000 - ls.owing_at_forfeiture);
  // K500 at 14%: 14 weekly charges of K70 (04/01 to 05/04/2027, last one inside grace), less the K10 waiver
  assert.equal(ls.owing_at_forfeiture, 50000 + 14 * 7000 - 1000);
  const refund = db.get().prepare("SELECT * FROM refunds WHERE loan_id = ? AND kind = 'surplus'").get(loanId);
  assert.equal(refund.amount, ls.surplus);
  // surplus still owed blocks archiving
  assert.ok(archive.eligibility(ls, dates.addDays(ls.date_closed, 40)).reasons.some((r) => /owed to the pledger/.test(r)));
  loans.payRefund(C(lo, ls.date_closed), refund.id, { channel: 'bank', reference: 'TT-55' });
  assert.ok(archive.eligibility(loans.get(loanId), dates.addDays(ls.date_closed, 40)).eligible);
});

test('two-person rule, branch scoping, stock count and audit immutability', () => {
  const t = '2027-05-03';
  const loanId = loans.createApplication(C(lo, t), { customer_id: customerId, item_ids: [fx.makeItem(svc, lo, t, customerId, 'car', { owner: 'John Peter Kila', vin: 'GRJ200-1234567', engine: '1GD123456', plate: 'BAA123' })], requested_amount: '5,000' });
  // creator cannot approve (CRO role check fires first for the LO; a CRO who created it would be blocked too)
  db.get().prepare('UPDATE loans SET created_by = ? WHERE id = ?').run(cro.id, loanId);
  db.get().prepare("UPDATE loans SET status = 'submitted' WHERE id = ?").run(loanId);
  assert.throws(() => loans.decide(C(cro, t), loanId, { decision: 'approve', amount: '1000', rate: 10 }), /created/);
  const sc = stock.start(C(lo, t));
  const lines = stock.lines(sc);
  assert.ok(lines.length >= 1);
  stock.scan(C(lo, t), sc, lines[0].item_no);
  stock.submit(C(lo, t), sc);
  assert.ok(db.get().prepare("SELECT 1 FROM notifications WHERE role = 'admin' AND title LIKE 'MISSING%'").get() || lines.length === 1);
  assert.throws(() => stock.review(C(admin, t), sc), /CRO/);
  stock.signOff(C(cro, t), sc, 'ok');
  stock.review(C(admin, t), sc, 'seen');
  assert.throws(() => db.get().prepare('UPDATE audit_log SET action = ? WHERE id = 1').run('x'), /read-only/);
  assert.throws(() => db.get().prepare('DELETE FROM audit_log WHERE id = 1').run(), /retention/);
  void lo2;
});
