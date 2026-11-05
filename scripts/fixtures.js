'use strict';
// Helpers shared by the demo seed and the tests: build a fully verified customer with
// two IDs and an item in the store, using the real service rules.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const DATA_URL = 'data:image/png;base64,' + PNG.toString('base64');
const file = (name = 'scan.png') => ({ buffer: PNG, mimetype: 'image/png', originalname: name });
const files = (n, name) => Array.from({ length: n }, (_, i) => file(`${name || 'photo'}-${i + 1}.png`));

function ctxFor(user, today) { return { user: { id: user.id, username: user.username, role: user.role, branch_id: user.branch_id }, ip: '127.0.0.1', today }; }

function makeCustomer(svc, lo, cro, today, p) {
  const { customers } = svc;
  const { id } = customers.create(ctxFor(lo, today), {
    surname: p.surname, given_names: p.given, dob: p.dob, sex: p.sex || 'Female', marital_status: p.marital || 'Married', citizenship: 'Papua New Guinean',
    home_province: p.home || 'Eastern Highlands', home_district: p.district || 'Goroka', home_village: p.village || 'Asaro',
    mobile: require('../src/lib/phone').format(p.mobile), email: p.email || '', second_phone: '',
    addr_province: 'National Capital District', addr_district: p.addrDistrict || 'Moresby North-East', addr_town: p.town || 'Gerehu',
    addr_section_lot: p.lot || 'Section 9, Lot 21', addr_landmark: p.landmark || 'Near Gerehu Stage 2 market', po_box: '',
    residence_proof_type: 'Utility bill', employer: p.employer || '', occupation: p.occupation || 'Teacher', usual_income: p.income || '',
    bank_name: 'BSP', bank_account: p.bank || '1000123456', mobile_banking: '', sms_language: p.lang || 'en',
    nok_name: p.nok || 'Mary Kila', nok_relationship: 'Sister', nok_phone: '(+675) 7123-9999', nok_address: 'Asaro village',
    consent_terms: 'on', consent_data: 'on', consent_forfeit: 'on',
  }, { photoDataUrl: DATA_URL, signatureDataUrl: DATA_URL, residence: [file('bill.png')] });
  const code = customers.sendMobileCode(ctxFor(lo, today), id);
  customers.confirmMobileCode(ctxFor(lo, today), id, code);
  const types = customers.idTypes();
  const nid = types.find((t) => t.name.startsWith('PNG National ID'));
  const sec = types.find((t) => t.name === (p.secondType || 'Employer staff ID card'));
  const fullName = `${p.given} ${p.surname}`;
  const i1 = customers.addId(ctxFor(lo, today), id, { id_type_id: nid.id, number: p.nid, issue_date: '01/03/2022', expiry_date: p.nidExpiry || '01/03/2032', name_on_id: fullName, dob_on_id: p.dob }, { front: [file()], back: [file()] });
  const i2 = customers.addId(ctxFor(lo, today), id, { id_type_id: sec.id, number: p.second, issue_date: '15/01/2024', expiry_date: '15/01/2029', name_on_id: fullName, dob_on_id: p.dob }, { front: [file()] });
  customers.reviewId(ctxFor(cro, today), i1, { decision: 'accept', photo_match: true });
  customers.reviewId(ctxFor(cro, today), i2, { decision: 'accept', photo_match: true });
  return id;
}

function makeItem(svc, lo, today, customerId, kind, p = {}) {
  const { items, db } = svc;
  const brand = (cat, name) => db.get().prepare('SELECT id FROM brands WHERE category = ? AND name = ?').get(cat, name).id;
  const cat = items.CATEGORIES[kind];
  const base = { category: kind, intake_checks: cat.intakeChecks, owner_name: p.owner, ownership_doc_type: cat.ownership[0], accessories: cat.accessories.slice(0, 2) };
  // First bin of the right kind with room in it (cars: a yard bay plus a key bin).
  const bins = require('../src/services/bins');
  const branchId = db.get().prepare('SELECT branch_id FROM customers WHERE id = ?').get(customerId).branch_id;
  const free = (k) => (bins.forBranch(branchId, k).find((b) => !b.full && (b.capacity || b.used === 0)) || {}).bin_no;
  const pick = (k, kindName) => ('bin_no' in p || 'key_bin_no' in p ? p[k] : free(kindName));
  const binFields = kind === 'car' ? { bin_no: pick('bin_no', 'yard'), key_bin_no: pick('key_bin_no', 'key') } : { bin_no: pick('bin_no', 'store') };
  let data;
  if (kind === 'phone') data = { ...base, brand_id: brand('phone', p.brand || 'Samsung'), model: p.model || 'Galaxy S23', colour: 'Black', year: p.year || 2023, storage: '256 GB', ram: '8 GB', imei: p.imei, device_password: '4821', ...binFields };
  if (kind === 'laptop') data = { ...base, brand_id: brand('laptop', p.brand || 'HP'), model: p.model || 'ProBook 450 G9', colour: 'Silver', year: p.year || 2022, storage: '512 GB SSD', ram: '16 GB', processor: 'Intel Core i5', serial_no: p.serial, device_password: 'Pass123', ...binFields };
  if (kind === 'car') data = { ...base, brand_id: brand('car', p.brand || 'Toyota'), model: p.model || 'Hilux SR5', colour: 'White', year: p.year || 2016, vin: p.vin, engine_no: p.engine, plate: p.plate, mileage_intake: p.km || 142000, fuel_intake: 'Half', ...binFields };
  return items.intake(ctxFor(lo, today), customerId, data, { sides: files(4, 'side'), extra: [file('screen.png')] }, [file('receipt.png')]);
}

function valuationData(svc, kind, { grade = 'A', market = '2,000.00', repair = '0' } = {}) {
  const cat = svc.items.CATEGORIES[kind];
  const d = { grade, market_value: market, repair_cost: repair, ownership_verified: 'on' };
  cat.inspection.forEach((_, n) => { d[`check_${n}`] = 'ok'; });
  return d;
}

module.exports = { PNG, DATA_URL, file, files, ctxFor, makeCustomer, makeItem, valuationData };
