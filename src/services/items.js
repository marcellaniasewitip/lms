'use strict';
const db = require('../db');
const dates = require('../lib/dates');
const seq = require('../lib/seq');
const audit = require('../lib/audit');
const { encrypt, decrypt, normalizeNumber } = require('../lib/crypto');
const { RuleError, NotFound, rule } = require('../lib/errors');
const { requireRole, checkBranch, today } = require('../lib/ctx');
const files = require('./files');
const notify = require('./notify');
const settings = require('./settings');
const bins = require('./bins');

const CATEGORIES = {
  car: {
    label: 'Cars, utes, trucks',
    ownership: ['Vehicle registration papers in the customer\'s name', 'Purchase receipt'],
    intakeChecks: ['Registration current', 'VIN and plate match the papers', 'Starts and drives', 'No other lender\'s claim'],
    inspection: ['Mileage on the odometer', 'Year and model', 'Dents, scratches and rust', 'Engine', 'Gearbox', 'Brakes', 'Steering',
      'Suspension', 'Test drive', 'Warning lights', 'Tyres', 'Interior', 'Service history', 'Registration current'],
    accessories: ['Keys', 'Spare key', 'Registration papers', 'Service book'],
    extraPhoto: 'odometer reading and fuel level',
  },
  laptop: {
    label: 'Laptops',
    ownership: ['Purchase receipt', 'Warranty card'],
    intakeChecks: ['Powers on', 'Serial number readable', 'No damage that stops sale', 'Charger included'],
    inspection: ['Model year', 'Processor, storage and RAM', 'Screen cracks or dead pixels', 'Keyboard and touchpad', 'Battery health',
      'Charger', 'Ports', 'Hinges and casing', 'Starts and runs normally'],
    accessories: ['Charger', 'USB cable', 'Case'],
    extraPhoto: 'screen switched on',
  },
  phone: {
    label: 'Phones',
    ownership: ['Purchase receipt', 'Box with matching IMEI'],
    intakeChecks: ['Powers on', 'IMEI matches the receipt or box', 'Not reported lost or stolen', 'Signed out of iCloud or Google account'],
    inspection: ['Model year', 'Storage and RAM', 'Cracks on screen or back', 'Battery health', 'Cameras', 'Buttons', 'Charging port',
      'Speaker and microphone', 'SIM and network working', 'Signed out of iCloud or Google'],
    accessories: ['Charger', 'USB cable', 'Case', 'Box'],
    extraPhoto: 'screen switched on',
  },
};
const CUSTODY_LABEL = { in_store: 'In store', for_sale: 'For sale', sold: 'Sold', returned: 'Returned to customer', handed_back: 'Handed back (not pledged)', missing: 'Missing' };
const HELD = ['in_store', 'for_sale', 'missing'];

function luhn(imei) {
  let sum = 0;
  for (let i = 0; i < imei.length; i++) {
    let n = +imei[imei.length - 1 - i];
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}

function get(id) {
  const it = db.get().prepare('SELECT * FROM items WHERE id = ?').get(id);
  if (!it) throw new NotFound('Item not found.');
  return it;
}
function byTag(tag) { return db.get().prepare('SELECT * FROM items WHERE item_no = ?').get(String(tag || '').trim().toUpperCase()); }
function uniqueNumbers(it) { return [['VIN', it.vin], ['Engine', it.engine_no], ['Plate', it.plate], ['Serial', it.serial_no], ['IMEI', it.imei]].filter(([, v]) => v); }
function describe(it) { return `${it.brand_name} ${it.model}${it.year ? ' ' + it.year : ''}${it.colour ? ', ' + it.colour : ''}`; }

function stolenHits(numbers) {
  const hits = [];
  for (const [type, v] of numbers) {
    const n = normalizeNumber(v);
    const r = db.get().prepare('SELECT * FROM stolen_list WHERE number_norm = ? AND active = 1').get(n);
    if (r) hits.push(`${type} ${v} is on the flagged (stolen) list${r.description ? ': ' + r.description : ''}`);
  }
  return hits;
}
function alreadyHeld(numbers, excludeId = 0) {
  const hits = [];
  for (const [type, v] of numbers) {
    const col = { VIN: 'vin', Engine: 'engine_no', Plate: 'plate', Serial: 'serial_no', IMEI: 'imei' }[type];
    const r = db.get().prepare(`SELECT item_no FROM items WHERE ${col} = ? AND custody_status IN ('in_store','for_sale','missing') AND id != ?`).get(v, excludeId);
    if (r) hits.push(`${type} ${v} is already held as item ${r.item_no}.`);
  }
  return hits;
}

function validateIntake(data, photos, ownershipScans) {
  const cat = CATEGORIES[data.category];
  const errs = [];
  if (!cat) { errs.push('Choose a category: car, laptop or phone.'); return { errs }; }
  const brand = db.get().prepare('SELECT * FROM brands WHERE id = ? AND category = ? AND active = 1').get(data.brand_id, data.category);
  if (!brand) errs.push('Only brands on the approved list can be accepted.');
  if (!data.model) errs.push('Model is required.');
  const year = data.year ? Number(data.year) : null;
  if (brand && brand.min_model_year) {
    if (!year) errs.push(`Year is required (minimum ${brand.min_model_year} for ${brand.name}).`);
    else if (year < brand.min_model_year) errs.push(`${brand.name} ${data.category}s must be ${brand.min_model_year} or newer.`);
  }
  if (data.category === 'car') {
    for (const [k, l] of [['vin', 'VIN / chassis number'], ['engine_no', 'Engine number'], ['plate', 'Registration plate']]) if (!data[k]) errs.push(`${l} is required.`);
    if (data.vin && normalizeNumber(data.vin).length < 6) errs.push('VIN / chassis number looks too short.');
    if (!data.mileage_intake || !/^\d+$/.test(String(data.mileage_intake))) errs.push('Odometer reading (km) at intake is required.');
    if (!data.fuel_intake) errs.push('Fuel level at intake is required.');
  } else {
    if (!data.storage) errs.push('Storage is required.');
    if (!data.ram) errs.push('RAM is required.');
  }
  if (data.category === 'laptop' && !data.serial_no) errs.push('Serial number is required.');
  if (data.category === 'phone') {
    const imei = String(data.imei || '').replace(/\D/g, '');
    if (!/^\d{15}$/.test(imei) || !luhn(imei)) errs.push('IMEI must be a valid 15-digit number (dial *#06#).');
  }
  const ticked = [].concat(data.intake_checks || []);
  for (const c of cat.intakeChecks) if (!ticked.includes(c)) errs.push(`Check before accepting: "${c}" must be confirmed.`);
  if (!data.owner_name) errs.push('Owner name as shown on the proof of ownership is required.');
  if (!data.ownership_doc_type) errs.push('Choose the proof of ownership document.');
  if (!ownershipScans || !ownershipScans.length) errs.push('Scan the proof of ownership.');
  const min = settings.get('min_item_photos');
  if (!photos.sides || photos.sides.length < min) errs.push(`At least ${min} photos from all sides are required.`);
  if (!photos.extra || !photos.extra.length) errs.push(`A photo of the ${cat.extraPhoto} is required.`);
  if (!String(data.bin_no || '').trim()) errs.push(data.category === 'car' ? 'Enter the yard bay number for the car (for example Y3).' : 'Enter the bin number the item goes into (for example C1).');
  if (data.category === 'car' && !String(data.key_bin_no || '').trim()) errs.push('Enter the key bin number for the car keys and papers (for example K-01).');
  return { errs, brand, cat, year };
}

function intake(ctx, customerId, data, photos = {}, ownershipScans = []) {
  requireRole(ctx, 'loan_officer');
  const customers = require('./customers');
  const c = customers.get(customerId);
  checkBranch(ctx, c.branch_id);
  rule(c.status === 'active', `Customer status is ${c.status}; items cannot be received.`);
  const { errs, brand, cat, year } = validateIntake(data, photos, ownershipScans);
  if (errs.length) throw new RuleError('The item cannot be accepted yet.', errs);
  const rec = {
    category: data.category, brand_id: brand.id, brand_name: brand.name, model: data.model.trim(), colour: data.colour || null, year,
    storage: data.storage || null, ram: data.ram || null, processor: data.processor || null,
    vin: data.vin ? normalizeNumber(data.vin) : null, engine_no: data.engine_no ? normalizeNumber(data.engine_no) : null,
    plate: data.plate ? normalizeNumber(data.plate) : null, serial_no: data.serial_no ? normalizeNumber(data.serial_no) : null,
    imei: data.imei ? String(data.imei).replace(/\D/g, '') : null,
  };
  const nums = uniqueNumbers(rec);
  const stolen = stolenHits(nums);
  if (stolen.length) {
    audit.log(ctx, 'stolen_blocked', 'customer', customerId, null, { numbers: nums, hits: stolen });
    notify.inApp({ role: 'cro', branchId: c.branch_id, title: 'Item blocked: on flagged list', body: `${c.customer_no}: ${stolen.join('; ')}. Check with police.`, link: `/customers/${c.id}` });
    throw new RuleError('This item is blocked.', [...stolen, 'The CRO has been told and must check with police before anything else is done.']);
  }
  const held = alreadyHeld(nums);
  if (held.length) throw new RuleError('This item is already in custody.', held);
  const d = db.get();
  return d.transaction(() => {
    // The typed bin numbers: existing bins, or new ones created on first use.
    const bin = bins.resolve(ctx, data.bin_no, { branchId: c.branch_id, kind: data.category === 'car' ? 'yard' : 'store' });
    const keyBin = data.category === 'car' ? bins.resolve(ctx, data.key_bin_no, { branchId: c.branch_id, kind: 'key' }) : null;
    const ts = dates.nowIso();
    const info = d.prepare(`INSERT INTO items(item_no, customer_id, branch_id, category, brand_id, brand_name, model, colour, year, storage, ram, processor,
      vin, engine_no, plate, serial_no, imei, device_password_enc, faults, accessories, intake_checks, owner_name, ownership_doc_type,
      mileage_intake, fuel_intake, custody_status, location, safe_location, bin_id, key_bin_id, received_by, date_in, created_at)
      VALUES (@item_no, @customer_id, @branch_id, @category, @brand_id, @brand_name, @model, @colour, @year, @storage, @ram, @processor,
      @vin, @engine_no, @plate, @serial_no, @imei, @pw, @faults, @accessories, @checks, @owner_name, @ownership_doc_type,
      @mileage, @fuel, 'in_store', @location, @safe, @bin_id, @key_bin_id, @uid, @date_in, @ts)`).run({
      ...rec, item_no: seq.itemNo(), customer_id: customerId, branch_id: c.branch_id,
      pw: data.category === 'car' ? null : encrypt(data.device_password), faults: data.faults || null,
      accessories: JSON.stringify([].concat(data.accessories || [])), checks: JSON.stringify([].concat(data.intake_checks || [])),
      owner_name: data.owner_name.trim(), ownership_doc_type: data.ownership_doc_type,
      mileage: data.category === 'car' ? Number(data.mileage_intake) : null, fuel: data.fuel_intake || null,
      location: bins.label(bin), safe: keyBin ? bins.label(keyBin) : null, bin_id: bin.id, key_bin_id: keyBin ? keyBin.id : null,
      uid: ctx.user.id, date_in: today(ctx), ts,
    });
    const id = info.lastInsertRowid;
    files.storeUploads(photos.sides, { ownerType: 'item', ownerId: id, kind: 'intake_photo', userId: ctx.user.id });
    files.storeUploads(photos.extra, { ownerType: 'item', ownerId: id, kind: data.category === 'car' ? 'odometer_photo' : 'screen_photo', userId: ctx.user.id });
    files.storeUploads(ownershipScans, { ownerType: 'item', ownerId: id, kind: 'ownership', userId: ctx.user.id });
    d.prepare(`INSERT INTO item_movements(item_id, from_location, to_location, from_status, to_status, reason, moved_by, moved_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(id, null, bins.label(bin) + (keyBin ? `; keys in ${bins.label(keyBin)}` : ''), null, 'in_store', 'Received at intake, tagged and put in its bin', ctx.user.id, ts);
    audit.log(ctx, 'item_intake', 'item', id, null, { ...rec, bin: bin.bin_no, key_bin: keyBin && keyBin.bin_no, customer_id: customerId });
    return id;
  })();
}

function movements(itemId) {
  return db.get().prepare(`SELECT m.*, u.full_name AS by_name FROM item_movements m LEFT JOIN users u ON u.id = m.moved_by
    WHERE item_id = ? ORDER BY m.id`).all(itemId);
}

// Records a move. With to_bin_id / to_key_bin_id the item goes into those bins; when it leaves
// the lender (returned, handed back, sold) its bins are freed.
function recordMovement(ctx, item, { to_location, to_status, reason, safe_location, to_bin_id, to_key_bin_id }) {
  const d = db.get();
  const status = to_status ?? item.custody_status;
  const leaving = ['returned', 'handed_back', 'sold'].includes(status);
  let binId = leaving ? null : item.bin_id, keyBinId = leaving ? null : item.key_bin_id;
  let location = to_location ?? item.location, safe = leaving ? null : (safe_location ?? item.safe_location);
  if (to_bin_id) { const b = bins.get(to_bin_id); binId = b.id; location = bins.label(b); }
  if (to_key_bin_id) { const b = bins.get(to_key_bin_id); keyBinId = b.id; safe = bins.label(b); }
  const fromText = item.location + (item.safe_location ? `; keys in ${item.safe_location}` : '');
  const toText = location + (safe ? `; keys in ${safe}` : '');
  d.prepare(`INSERT INTO item_movements(item_id, from_location, to_location, from_status, to_status, reason, moved_by, moved_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(item.id, fromText, toText, item.custody_status, status, reason, ctx.user ? ctx.user.id : null, dates.nowIso());
  d.prepare('UPDATE items SET location = ?, custody_status = ?, safe_location = ?, bin_id = ?, key_bin_id = ? WHERE id = ?')
    .run(location, status, safe, binId, keyBinId, item.id);
  audit.log(ctx, 'item_movement', 'item', item.id, { location: fromText, status: item.custody_status }, { location: toText, status, reason });
}

function move(ctx, itemId, { to_bin_no, to_key_bin_no, reason }) {
  requireRole(ctx, 'loan_officer', 'cro');
  const it = get(itemId);
  checkBranch(ctx, it.branch_id);
  rule(HELD.includes(it.custody_status), 'Only items held by the lender can be moved.');
  const toBin = String(to_bin_no || '').trim(), toKey = String(to_key_bin_no || '').trim();
  rule(toBin || toKey, 'Type the new bin number.');
  rule(reason, 'Give a reason for the move.');
  if (toKey) rule(it.category === 'car', 'Only cars have a key bin.');
  db.get().transaction(() => {
    const b = toBin ? bins.resolve(ctx, toBin, { branchId: it.branch_id, kind: it.category === 'car' ? 'yard' : 'store', itemId: it.id }) : null;
    const k = toKey ? bins.resolve(ctx, toKey, { branchId: it.branch_id, kind: 'key', itemId: it.id }) : null;
    recordMovement(ctx, it, { to_bin_id: b ? b.id : null, to_key_bin_id: k ? k.id : null, reason });
  })();
}

// Device password: encrypted, shown only to the CRO, every view logged.
function revealPassword(ctx, itemId) {
  requireRole(ctx, 'cro');
  const it = get(itemId);
  checkBranch(ctx, it.branch_id);
  audit.log(ctx, 'view_device_password', 'item', itemId);
  return it.device_password_enc ? decrypt(it.device_password_enc) : null;
}
function deletePassword(ctx, item, why) {
  if (!item.device_password_enc) return;
  db.get().prepare('UPDATE items SET device_password_enc = NULL WHERE id = ?').run(item.id);
  audit.log(ctx, 'delete_device_password', 'item', item.id, null, { reason: why });
}

function addViewing(ctx, itemId, { visitor, note }) {
  requireRole(ctx, 'loan_officer', 'cro');
  const it = get(itemId);
  rule(it.category === 'car', 'Viewings are recorded for cars in the yard.');
  rule(visitor, 'Name of the person viewing is required.');
  db.get().prepare('INSERT INTO car_viewings(item_id, visitor, staff_id, at, note) VALUES (?,?,?,?,?)').run(itemId, visitor, ctx.user.id, dates.nowIso(), note || null);
  audit.log(ctx, 'car_viewing', 'item', itemId, null, { visitor, note });
}
function viewings(itemId) {
  return db.get().prepare('SELECT v.*, u.full_name AS staff_name FROM car_viewings v JOIN users u ON u.id = v.staff_id WHERE item_id = ? ORDER BY v.id DESC').all(itemId);
}

// Repeat loan: an item collected after redemption is brought back and taken in again.
function reIntake(ctx, itemId, { bin_no, key_bin_no, mileage_intake, fuel_intake }, photos = {}) {
  requireRole(ctx, 'loan_officer');
  const it = get(itemId);
  checkBranch(ctx, it.branch_id);
  rule(['returned', 'handed_back'].includes(it.custody_status), 'Only an item that was returned to the customer can be taken in again.');
  const errs = [];
  const min = settings.get('min_item_photos');
  if (!photos.sides || photos.sides.length < min) errs.push(`At least ${min} new photos from all sides are required.`);
  if (!photos.extra || !photos.extra.length) errs.push(`A new photo of the ${CATEGORIES[it.category].extraPhoto} is required.`);
  if (!String(bin_no || '').trim()) errs.push(it.category === 'car' ? 'Enter the yard bay number.' : 'Enter the bin number.');
  if (it.category === 'car' && !String(key_bin_no || '').trim()) errs.push('Enter the key bin number for the keys and papers.');
  if (it.category === 'car' && !/^\d+$/.test(String(mileage_intake || ''))) errs.push('Odometer reading is required.');
  if (errs.length) throw new RuleError('The item cannot be taken in again yet.', errs);
  const stolen = stolenHits(uniqueNumbers(it));
  if (stolen.length) throw new RuleError('This item is blocked.', stolen);
  db.get().transaction(() => {
    const bin = bins.resolve(ctx, bin_no, { branchId: it.branch_id, kind: it.category === 'car' ? 'yard' : 'store', itemId: it.id });
    const keyBin = it.category === 'car' ? bins.resolve(ctx, key_bin_no, { branchId: it.branch_id, kind: 'key', itemId: it.id }) : null;
    db.get().prepare(`UPDATE items SET returned_at = NULL, returned_to = NULL, return_id_shown = NULL, return_mileage = NULL, return_note = NULL,
      current_loan_id = NULL, date_in = ?, mileage_intake = COALESCE(?, mileage_intake), fuel_intake = COALESCE(?, fuel_intake), received_by = ? WHERE id = ?`)
      .run(today(ctx), it.category === 'car' ? Number(mileage_intake) : null, fuel_intake || null, ctx.user.id, itemId);
    files.storeUploads(photos.sides, { ownerType: 'item', ownerId: itemId, kind: 'intake_photo', userId: ctx.user.id, caption: `Re-intake ${today(ctx)}` });
    files.storeUploads(photos.extra, { ownerType: 'item', ownerId: itemId, kind: it.category === 'car' ? 'odometer_photo' : 'screen_photo', userId: ctx.user.id, caption: `Re-intake ${today(ctx)}` });
    recordMovement(ctx, get(itemId), { to_status: 'in_store', reason: 'Taken in again for a new loan', to_bin_id: bin.id, to_key_bin_id: keyBin ? keyBin.id : null });
  })();
}

function forCustomer(customerId) { return db.get().prepare('SELECT * FROM items WHERE customer_id = ? ORDER BY id DESC').all(customerId); }

// Items free to be pledged on a new application.
function available(customerId) {
  return db.get().prepare(`SELECT * FROM items WHERE customer_id = ? AND custody_status = 'in_store' AND id NOT IN (
    SELECT li.item_id FROM loan_items li JOIN loans l ON l.id = li.loan_id
    WHERE l.status NOT IN ('rejected','cancelled','redeemed','item_sold','expired','archived')) ORDER BY id`).all(customerId);
}

module.exports = {
  CATEGORIES, CUSTODY_LABEL, HELD, get, byTag, describe, uniqueNumbers, intake, movements, recordMovement, move, revealPassword,
  deletePassword, addViewing, viewings, reIntake, forCustomer, available, luhn,
};
