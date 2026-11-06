'use strict';
// IDs recorded as type + name on the ID + scans: the CRO reads the number, expiry and date of
// birth from the scans; staff confirm the ID shown at the counter against its scan.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-ids-'));
process.env.LMS_DATA_DIR = dir;
process.env.LMS_DB_FILE = path.join(dir, 'ids.db');

// An older database where the ID number and date of birth were required.
const old = new Database(process.env.LMS_DB_FILE);
old.exec(`CREATE TABLE customer_ids (
  id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, id_type_id INTEGER NOT NULL,
  number_enc TEXT NOT NULL, number_hash TEXT NOT NULL, number_last4 TEXT,
  issued_by TEXT, issue_date TEXT, expiry_date TEXT, name_on_id TEXT NOT NULL, dob_on_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', name_check TEXT, photo_match INTEGER, check_note TEXT, checked_by INTEGER, checked_at TEXT,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL);
  INSERT INTO customer_ids (customer_id, id_type_id, number_enc, number_hash, number_last4, name_on_id, dob_on_id, created_by, created_at)
  VALUES (999, 1, 'x', 'h', '1234', 'Old Record', '1990-01-01', 1, '2026-01-01');`);
old.close();

const db = require('../src/db');
const settings = require('../src/services/settings');
const users = require('../src/services/users');
const customers = require('../src/services/customers');
const items = require('../src/services/items');
const loans = require('../src/services/loans');
const fx = require('../scripts/fixtures');

db.open();
settings.seedReferenceData();
const svc = { db, customers, items };
const mk = (u, role) => users.get(users.create(null, { username: u, full_name: u, role, branch_id: 1, mobile: '(+675) 7100-0001', password: 'Str0ng!Passw0rd' }));
const lo = mk('lo1', 'loan_officer'), cro = mk('cro1', 'cro');
const T = '2026-11-06';
const C = (u) => fx.ctxFor(u, T);
const rx = (re) => (e) => { assert.match([e.message, ...(e.details || [])].join(' | '), re); return true; };

test('older databases are updated: the number and date of birth become optional, rows kept', () => {
  const cols = db.get().prepare('PRAGMA table_info(customer_ids)').all();
  for (const c of ['number_enc', 'number_hash', 'dob_on_id']) assert.equal(cols.find((x) => x.name === c).notnull, 0, c);
  assert.equal(db.get().prepare("SELECT name_on_id FROM customer_ids WHERE customer_id = 999").get().name_on_id, 'Old Record');
});

let cust, nid, emp;
test('an ID is added with only its type, the name exactly as on the ID and the scans', () => {
  const { id } = customers.create(C(lo), {
    surname: 'Arua', given_names: 'John Junior', dob: '08/10/1996', sex: 'Male', marital_status: 'Single', citizenship: 'Papua New Guinean',
    home_province: 'Central', home_district: 'Abau', home_village: 'Kupiano', mobile: '(+675) 8213-4228', addr_province: 'National Capital District',
    addr_district: 'Moresby North-East', addr_town: 'Garden Hills', addr_section_lot: 'Manioto St', po_box: 'P.O.Box 685, Waigani, NCD',
    consent_terms: 1, consent_data: 1, consent_forfeit: 1,
  }, { photo1: [fx.file('p.png')] });
  cust = id;
  const types = customers.idTypes();
  assert.throws(() => customers.addId(C(lo), cust, { id_type_id: types[0].id, name_on_id: 'John Junior Arua' }, {}), rx(/Front scan/));
  nid = customers.addId(C(lo), cust, { id_type_id: types[0].id, name_on_id: 'John Junior Arua' }, { front: [fx.file()], back: [fx.file()] });
  emp = customers.addId(C(lo), cust, { id_type_id: types[3].id, name_on_id: 'John Junior Arua' }, { front: [fx.file()] });
  const r = customers.ids(cust).find((x) => x.id === nid);
  assert.equal(r.number_enc, null); assert.equal(r.dob_on_id, null); assert.equal(r.expiry_date, null);
  assert.equal(r.name_check, 'match');
});

test('the CRO confirms from the scan that the ID is not expired and the date of birth matches', () => {
  assert.throws(() => customers.reviewId(C(cro), nid, { decision: 'accept', photo_match: true }), rx(/has not expired.*matches the profile/));
  assert.throws(() => customers.reviewId(C(cro), nid, { decision: 'accept', photo_match: true, not_expired: true }), rx(/date of birth on the scan/));
  customers.reviewId(C(cro), nid, { decision: 'accept', photo_match: true, not_expired: true, dob_match: true });
  customers.reviewId(C(cro), emp, { decision: 'accept', photo_match: true, not_expired: true, dob_match: true });
  assert.equal(customers.get(cust).verification_status, 'verified');
  assert.ok(customers.loanReadiness(cust, T).ok);
});

test('at the counter the ID shown is confirmed against its scan; the ticket names the ID types', () => {
  const it = fx.makeItem(svc, lo, T, cust, 'phone', { owner: 'John Junior Arua', imei: '356938035643809' });
  const id = loans.createApplication(C(lo), { customer_id: cust, item_ids: [it], requested_amount: '140' });
  loans.submit(C(lo), id);
  loans.valuate(C(cro), id, it, fx.valuationData(svc, 'phone', { grade: 'C', market: '1,000' }));
  loans.decide(C(cro), id, { decision: 'approve', amount: '140', rate: 20 });
  loans.markTicketPrinted(C(lo), id);
  loans.release(C(lo), id, { channel: 'cash', agreement_signed: 1 });
  // lost ticket: replacement needs a photo ID confirmed against its scan
  assert.throws(() => loans.replaceTicket(C(lo), id, { id_record_id: nid, reason: 'Lost' }), rx(/Compare the ID shown with the scan/));
  loans.replaceTicket(C(lo), id, { id_record_id: nid, id_confirmed: '1', reason: 'Lost' });
  loans.postPayment(C(lo), id, { amount: '168', channel: 'cash' });
  assert.equal(loans.get(id).status, 'paid');
  const base = { ticket_presented: 1, condition_checked: 1, signatureDataUrl: fx.DATA_URL, id_record_id: nid };
  assert.throws(() => loans.returnItems(C(lo), id, base), rx(/Compare the ID shown with the scan/));
  loans.returnItems(C(lo), id, { ...base, id_confirmed: '1' });
  assert.equal(loans.get(id).status, 'redeemed');
  assert.equal(items.get(it).return_id_shown, 'PNG National ID (NID) card');
});
