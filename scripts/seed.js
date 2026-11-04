'use strict';
// Demo data: replays about four months of branch activity through the real services and
// the nightly job, so every balance, interest entry and status is produced by the system.
//   node scripts/seed.js --reset
const fs = require('fs');
const path = require('path');
const config = require('../src/config');

if (fs.existsSync(config.DB_FILE)) {
  if (!process.argv.includes('--reset')) { console.error(`Database exists at ${config.DB_FILE}. Run with --reset to replace it with demo data.`); process.exit(1); }
  for (const f of [config.DB_FILE, config.DB_FILE + '-wal', config.DB_FILE + '-shm']) if (fs.existsSync(f)) fs.unlinkSync(f);
  for (const f of fs.readdirSync(config.UPLOADS)) fs.unlinkSync(path.join(config.UPLOADS, f));
}

const db = require('../src/db');
const dates = require('../src/lib/dates');
const settings = require('../src/services/settings');
const users = require('../src/services/users');
const customers = require('../src/services/customers');
const items = require('../src/services/items');
const loans = require('../src/services/loans');
const payments = require('../src/services/payments');
const jobs = require('../src/services/jobs');
const fx = require('./fixtures');

db.open();
settings.seedReferenceData();
const d = db.get();
d.prepare(`INSERT INTO branches(code, name, phone, email, postal_address, physical_address, created_at) VALUES ('LAE','Lae – Top Town','+675 472 0000','lae@kinapledge.com.pg','PO Box 2200, Lae, Morobe','Section 5, Lot 9, Coronation Drive, Top Town, Lae',?)`).run(dates.nowIso());

const PW = 'Demo#Pass2026';
const mk = (username, full_name, role, branch_id, mobile) => users.get(users.create(null, { username, full_name, role, branch_id, mobile, password: PW }));
const admin = mk('admin', 'Rose Aihi', 'admin', null, '+67570000001');
const lo = mk('officer', 'Ben Tamarua', 'loan_officer', 1, '+67570000002');
const lo2 = mk('officer2', 'Janet Kaupa', 'loan_officer', 1, '+67570000003');
const cro = mk('cro', 'David Pokana', 'cro', 1, '+67570000004');
const loLae = mk('officer.lae', 'Simon Yalu', 'loan_officer', 2, '+67570000005');
const croLae = mk('cro.lae', 'Agnes Bomai', 'cro', 2, '+67570000006');

const svc = { db, customers, items };
const C = (u, t) => fx.ctxFor(u, t);
const luhnImei = (p14) => { for (let x = 0; x < 10; x++) if (items.luhn(p14 + x)) return p14 + x; };

const T = dates.today();
const day = (n) => dates.addDays(T, n);
const START = day(-125);

// timeline[date] = list of actions run after that night's job
const timeline = {};
const at = (n, fn) => { (timeline[day(n)] = timeline[day(n)] || []).push(fn); };

function loanFor({ who, cust, kind, item, ask, grade, market, repair = '0', amount, rate, channel = 'cash', ref, t }) {
  const itemId = fx.makeItem(svc, who.lo, t, cust, kind, item);
  const id = loans.createApplication(C(who.lo, t), { customer_id: cust, item_ids: [itemId], requested_amount: ask });
  loans.submit(C(who.lo, t), id);
  loans.valuate(C(who.cro, t), id, itemId, { ...fx.valuationData(svc, kind, { grade, market, repair }), ownership_note: item.ownerNote });
  loans.decide(C(who.cro, t), id, { decision: 'approve', amount, rate });
  loans.release(C(who.lo, t), id, { channel, reference: ref, agreement_signed: 1 });
  loans.uploadSignedTicket(C(who.lo, t), id, [fx.file('signed-ticket.png')]);
  return id;
}
const POM = { lo, cro };
const LAE = { lo: loLae, cro: croLae };
const ids = {};

const people = [
  { key: 'grace', surname: 'Kila', given: 'Grace', dob: '14/05/1990', mobile: '71234501', nid: 'NID20190045501', second: 'EMP-PNGP-4821', lang: 'tpi', occupation: 'Nurse', employer: 'Port Moresby General Hospital' },
  { key: 'peter', surname: 'Wena', given: 'Peter John', dob: '02/11/1984', mobile: '71234502', nid: 'NID20180032202', second: 'NAS-55120931', secondType: 'Superannuation member card', sex: 'Male', occupation: 'Contractor' },
  { key: 'mary', surname: 'Tau', given: 'Mary', dob: '23/07/1995', mobile: '71234503', network: 'Telikom', nid: 'NID20200071103', second: 'UPNG-2015-3311', secondType: 'Student or institution ID', occupation: 'Student' },
  { key: 'joseph', surname: 'Moi', given: 'Joseph', dob: '09/09/1979', mobile: '71234504', nid: 'NID20170012004', second: 'DL-0098812', secondType: "Driver's licence", sex: 'Male', occupation: 'Driver' },
  { key: 'lucy', surname: 'Parkop', given: 'Lucy', dob: '30/01/1988', mobile: '71234505', nid: 'NID20190088805', second: 'EMP-BSP-1209', occupation: 'Bank teller', employer: 'BSP' },
  { key: 'thomas', surname: 'Hela', given: 'Thomas', dob: '17/03/1992', mobile: '712345066', network: 'Telikom', nid: 'NID20210044406', second: 'EMP-DIG-7781', sex: 'Male', occupation: 'Technician', employer: 'Digicel PNG' },
  { key: 'ruth', surname: 'Siune', given: 'Ruth', dob: '05/12/1986', mobile: '71234507', nid: 'NID20180066607', second: 'EMP-ANZ-3021', occupation: 'Clerk' },
  { key: 'kevin', surname: 'Bai', given: 'Kevin', dob: '11/06/1983', mobile: '81234508', network: 'Vodafone', nid: 'NID20170055508', second: 'DL-0044120', secondType: "Driver's licence", sex: 'Male', occupation: 'Mechanic' },
  { key: 'anna', surname: 'Gima', given: 'Anna', dob: '21/04/1997', mobile: '71234509', nid: 'NID20220033309', second: 'EMP-TEL-1188', occupation: 'Sales' },
  { key: 'samuel', surname: 'Nalu', given: 'Samuel', dob: '08/08/1975', mobile: '81234510', network: 'Vodafone', nid: 'NID20160011110', second: 'DL-0012777', secondType: "Driver's licence", sex: 'Male', occupation: 'Businessman', lae: true },
];

at(0 - 125, () => {
  for (const p of people) {
    const who = p.lae ? LAE : POM;
    ids[p.key] = fx.makeCustomer(svc, who.lo, who.cro, START, { ...p, addrDistrict: p.lae ? 'Lae' : 'Moresby North-East', town: p.lae ? 'Top Town' : 'Gerehu' });
    if (p.lae) d.prepare('UPDATE customers SET addr_province = ? WHERE id = ?').run('Morobe', ids[p.key]);
  }
});
const own = (k) => { const p = people.find((x) => x.key === k); return `${p.given} ${p.surname}`; };

// 1. Redeemed early in the period, archived by the nightly expiry check.
at(-120, () => { ids.l1 = loanFor({ who: POM, cust: ids.lucy, kind: 'laptop', item: { owner: own('lucy'), serial: '5CD9281XQA', brand: 'Dell', model: 'Latitude 5420' }, ask: '1,200', grade: 'A', market: '2,400', amount: '1,200', rate: 11, t: day(-120) }); });
at(-110, () => loans.postPayment(C(lo, day(-110)), ids.l1, { amount: '400', channel: 'cash' }));
at(-95, () => {
  const l = loans.get(ids.l1);
  loans.postPayment(C(lo, day(-95)), ids.l1, { amount: (loans.total(l) / 100).toFixed(2), channel: 'mobile', reference: `KB-${l.loan_no}-01` });
  loans.returnItems(C(lo, day(-95)), ids.l1, { ticket_presented: 1, condition_checked: 1, signatureDataUrl: fx.DATA_URL, id_record_id: customers.ids(ids.lucy)[0].id, id_number_shown: 'NID20190088805' });
});

// 2. Forfeited, sold at auction with a surplus that has been paid out.
at(-118, () => { ids.l2 = loanFor({ who: POM, cust: ids.joseph, kind: 'phone', item: { owner: own('joseph'), imei: luhnImei('35693803564380'), brand: 'Apple', model: 'iPhone 13' }, ask: '600', grade: 'B', market: '1,800', amount: '600', rate: 14, t: day(-118) }); });

// 3. Grace period ended — CRO declared forfeiture; Admin approved reserve and listed it.
at(-112, () => { ids.l3 = loanFor({ who: POM, cust: ids.kevin, kind: 'car', item: { owner: own('kevin'), vin: 'KUN26-0123456', engine: '1KD7712345', plate: 'BCF 421', km: 168000, brand: 'Toyota', model: 'Hilux SR' }, ask: '6,000', grade: 'C', market: '28,000', repair: '2,500', amount: '6,000', rate: 18, channel: 'bank', ref: 'BSP-TT-55012', t: day(-112) }); });
at(-90, () => loans.postPayment(C(lo, day(-90)), ids.l3, { amount: '1,500', channel: 'bank', reference: 'BSP-DEP-88120' }));

// 4. In grace now (maturity passed, grace ends in a couple of days).
at(-95, () => { ids.l4 = loanFor({ who: POM, cust: ids.mary, kind: 'laptop', item: { owner: own('mary'), serial: '1H8K2L3M9P', brand: 'HP', model: 'Pavilion 15' }, ask: '700', grade: 'B', market: '1,600', amount: '700', rate: 15, t: day(-95) }); });
at(-60, () => loans.postPayment(C(lo2, day(-60)), ids.l4, { amount: '250', channel: 'cash' }));

// 5. Car loan maturing within 7 days.
at(-86, () => { ids.l5 = loanFor({ who: POM, cust: ids.peter, kind: 'car', item: { owner: 'Peter Wena', ownerNote: 'Middle name not on registration papers', vin: 'GDJ150-0045512', engine: '1GD0045512', plate: 'BDA 118', km: 92000, brand: 'Toyota', model: 'Land Cruiser Prado' }, ask: '15,000', grade: 'A', market: '65,000', amount: '15,000', rate: 10, channel: 'bank', ref: 'BSP-TT-60311', t: day(-86) }); });
at(-70, () => loans.postPayment(C(lo, day(-70)), ids.l5, { amount: '4,000', channel: 'bank', reference: 'BSP-DEP-70112' }));
at(-40, () => loans.postPayment(C(lo, day(-40)), ids.l5, { amount: '3,500', channel: 'mobile', reference: 'BSP-MB-40220' }));

// 6. Active phone loan with a part payment (customer gets SMS in Tok Pisin).
at(-20, () => { ids.l6 = loanFor({ who: POM, cust: ids.grace, kind: 'phone', item: { owner: own('grace'), imei: luhnImei('35123456789012'), brand: 'Samsung', model: 'Galaxy S23' }, ask: '1,000', grade: 'A', market: '2,000', amount: '1,000', rate: 10, t: day(-20) }); });
at(-16, () => loans.postPayment(C(lo, day(-16)), ids.l6, { amount: '300', channel: 'cash' }));

// 7. Paid in full yesterday — item waiting to be returned.
at(-30, () => { ids.l7 = loanFor({ who: POM, cust: ids.thomas, kind: 'laptop', item: { owner: own('thomas'), serial: 'PF3ABCD12', brand: 'Lenovo', model: 'ThinkPad E14' }, ask: '900', grade: 'A', market: '1,800', amount: '900', rate: 12, t: day(-30) }); });
at(-1, () => { const l = loans.get(ids.l7); loans.postPayment(C(lo, day(-1)), ids.l7, { amount: (loans.total(l) / 100).toFixed(2), channel: 'cash' }); });

// 8. Redeemed 25 days ago: shows on the Admin's expiring-loans list.
at(-50, () => { ids.l8 = loanFor({ who: POM, cust: ids.ruth, kind: 'phone', item: { owner: own('ruth'), imei: luhnImei('86012345678901'), brand: 'Oppo', model: 'Reno 10' }, ask: '400', grade: 'B', market: '1,000', amount: '400', rate: 13, t: day(-50) }); });
at(-25, () => {
  const l = loans.get(ids.l8);
  loans.postPayment(C(lo, day(-25)), ids.l8, { amount: (loans.total(l) / 100).toFixed(2), channel: 'cash' });
  loans.returnItems(C(lo, day(-25)), ids.l8, { ticket_presented: 1, condition_checked: 1, signatureDataUrl: fx.DATA_URL, id_record_id: customers.ids(ids.ruth)[0].id, id_number_shown: 'NID20180066607' });
});

// 9. Lae branch loan, active.
at(-35, () => { ids.l9 = loanFor({ who: LAE, cust: ids.samuel, kind: 'car', item: { owner: own('samuel'), vin: 'MR0FZ29G0012345', engine: '2GD1234567', plate: 'LAE 902', km: 120500, brand: 'Toyota', model: 'Hilux' }, ask: '8,000', grade: 'B', market: '42,000', amount: '8,000', rate: 14, channel: 'bank', ref: 'KB-TT-1002', t: day(-35) }); });

// Today: work queues.
at(0, () => {
  // Waiting for CRO valuation
  const it = fx.makeItem(svc, lo, T, ids.anna, 'phone', { owner: own('anna'), imei: luhnImei('35900011122233'), brand: 'Apple', model: 'iPhone 14', year: 2022 });
  ids.l10 = loans.createApplication(C(lo, T), { customer_id: ids.anna, item_ids: [it], requested_amount: '800' });
  loans.submit(C(lo, T), ids.l10);
  // Approved, ready to release
  const it2 = fx.makeItem(svc, lo2, T, ids.grace, 'laptop', { owner: own('grace'), serial: 'C02XG1ABJG5H', brand: 'Apple', model: 'MacBook Air M1', year: 2021 });
  ids.l11 = loans.createApplication(C(lo2, T), { customer_id: ids.grace, item_ids: [it2], requested_amount: '1,500' });
  loans.submit(C(lo2, T), ids.l11);
  loans.valuate(C(cro, T), ids.l11, it2, fx.valuationData(svc, 'laptop', { grade: 'A', market: '3,200' }));
  loans.decide(C(cro, T), ids.l11, { decision: 'approve', amount: '1,500', rate: 11 });
  // A transfer quoting the loan number, waiting to be matched
  payments.addUnmatched(C(lo, T), { amount: '200', channel: 'mobile', reference: `KINA MB ${loans.get(ids.l6).loan_no}`, payer_name: 'G KILA', date_received: dates.fmt(T) });
  // A new customer whose IDs the CRO still has to check
  const { id } = customers.create(C(lo, T), {
    surname: 'Kumul', given_names: 'Esther', dob: '12/02/1993', sex: 'Female', marital_status: 'Single', citizenship: 'Papua New Guinean', home_province: 'Manus',
    home_district: 'Lorengau', home_village: 'Pere', mobile: '81234511', mobile_network: 'Vodafone', addr_province: 'National Capital District', addr_district: 'Moresby South',
    addr_town: 'Boroko', addr_section_lot: 'Section 41, Lot 7', addr_landmark: 'Opposite Boroko Foodworld', residence_proof_type: 'Rental letter', nok_name: 'Paul Kumul',
    nok_relationship: 'Brother', nok_phone: '+675 7222 1111', nok_address: 'Pere village', sms_language: 'en', consent_terms: 1, consent_data: 1, consent_forfeit: 1,
  }, { photoDataUrl: fx.DATA_URL, signatureDataUrl: fx.DATA_URL, residence: [fx.file('rental-letter.png')] });
  const code = customers.sendMobileCode(C(lo, T), id); customers.confirmMobileCode(C(lo, T), id, code);
  const types = customers.idTypes();
  customers.addId(C(lo, T), id, { id_type_id: types[1].id, number: 'P1234567', issue_date: '10/10/2021', expiry_date: '10/10/2031', name_on_id: 'Esther Kumul', dob_on_id: '12/02/1993' }, { front: [fx.file()] });
  customers.addId(C(lo, T), id, { id_type_id: types[3].id, number: 'EMP-NBC-552', issue_date: '01/01/2024', expiry_date: '01/01/2027', name_on_id: 'Ester Kumul', dob_on_id: '12/02/1993' }, { front: [fx.file()] });
  // Flagged item on the stolen list
  d.prepare("INSERT INTO stolen_list(number_type, number_norm, description, source, added_by, created_at) VALUES ('IMEI', ?, 'Reported stolen at Waigani', 'RPNGC report 2026/1187', ?, ?)")
    .run(luhnImei('35000000000001'), cro.id, dates.nowIso());
});

// Replay the timeline with the nightly job each day.
for (let t = START; t <= T; t = dates.addDays(t, 1)) {
  jobs.nightlyFor(t);
  for (const fn of timeline[t] || []) fn();
  // Forfeiture and sale steps once the grace period has ended.
  for (const [key, steps] of Object.entries({ l2: 'sell', l3: 'list' })) {
    const id = ids[key];
    if (!id) continue;
    const l = loans.get(id);
    if (l.status === 'in_grace' && t >= l.grace_end_date) {
      loans.declareForfeit(C(cro, t), id, 'Not paid by the grace end date');
      const s = d.prepare('SELECT * FROM forfeiture_sales WHERE loan_id = ?').get(id);
      loans.approveReserve(C(admin, t), s.id, { reserve_price: key === 'l2' ? '1,200' : '20,000' });
      loans.recordListing(C(admin, t), s.id, { auction_platform: 'PNG Online Auctions', listing_ref: `POA-${l.loan_no}` });
      if (steps === 'sell') {
        loans.recordSale(C(admin, dates.addDays(t, 0)), s.id, { sale_price: '1,650', buyer_name: 'Highlands Mobile Traders', sale_receipt_no: `SR-${l.loan_no}` });
        const r = d.prepare("SELECT * FROM refunds WHERE loan_id = ? AND kind = 'surplus'").get(id);
        if (r) loans.payRefund(C(lo, t), r.id, { channel: 'bank', reference: 'BSP-TT-SURPLUS-01' });
      }
    }
  }
}
console.log('Demo data loaded.');
console.log(`  Port Moresby date: ${dates.fmt(T)}`);
console.log(`  Users (password ${PW}): admin · officer · officer2 · cro · officer.lae · cro.lae`);
for (const l of d.prepare("SELECT loan_no, status FROM loans ORDER BY id").all()) console.log(`  loan ${l.loan_no}: ${loans.STATUS[l.status]}`);
