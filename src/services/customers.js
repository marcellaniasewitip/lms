'use strict';
const db = require('../db');
const dates = require('../lib/dates');
const money = require('../lib/money');
const seq = require('../lib/seq');
const audit = require('../lib/audit');
const names = require('../lib/names');
const { encrypt, decrypt, hmac, mask, normalizeNumber, randomCode, sha256 } = require('../lib/crypto');
const { RuleError, NotFound, rule } = require('../lib/errors');
const { requireRole, checkBranch, today } = require('../lib/ctx');
const files = require('./files');
const notify = require('./notify');
const settings = require('./settings');

const PROVINCES = ['Autonomous Region of Bougainville', 'Central', 'Chimbu (Simbu)', 'East New Britain', 'East Sepik', 'Eastern Highlands',
  'Enga', 'Gulf', 'Hela', 'Jiwaka', 'Madang', 'Manus', 'Milne Bay', 'Morobe', 'National Capital District', 'New Ireland',
  'Northern (Oro)', 'Southern Highlands', 'West New Britain', 'West Sepik (Sandaun)', 'Western (Fly)', 'Western Highlands'];
const RESIDENCE_PROOF = ['Utility bill', 'Rental letter', 'Letter from the ward councillor'];

const REQUIRED = {
  surname: 'Surname', given_names: 'Given names', dob: 'Date of birth', sex: 'Sex', marital_status: 'Marital status',
  citizenship: 'Citizenship', home_province: 'Home province', home_district: 'Home district', home_village: 'Home village',
  mobile: 'Mobile number', addr_province: 'Current address – province',
  addr_district: 'Current address – district', addr_town: 'Town or suburb', addr_section_lot: 'Section and lot (or settlement/village)',
  po_box: 'Postal address (printed on the pledge ticket)',
  // Nearest landmark and residence proof were removed from the form at the lender's request
  // (the columns stay, so values saved earlier are kept).
  // Next of kin was removed from the customer form at the lender's request. The database columns
  // (nok_name, nok_relationship, nok_phone, nok_address) are kept, so details already saved stay
  // on record; add the four fields back here and in views/customers/form.ejs to bring it back.
};
// mobile_network is never typed in: it is worked out from the number's prefix.
const EDITABLE = [...Object.keys(REQUIRED), 'mobile_network', 'second_phone', 'email', 'employer', 'occupation', 'usual_income',
  'bank_name', 'sms_language'];

// PNG mobiles for Digicel, Telikom and Vodafone — the rules live in lib/phone.js.
const phone = require('../lib/phone');
const normMobile = phone.normalize;
const displayMobile = phone.display;

function get(id) {
  const c = db.get().prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!c) throw new NotFound('Customer not found.');
  return c;
}
function fullName(c) { return `${c.given_names} ${c.surname}`; }

function cleanInput(data) {
  const out = {};
  for (const k of EDITABLE) if (data[k] !== undefined) out[k] = typeof data[k] === 'string' ? data[k].trim() : data[k];
  if (out.dob !== undefined) out.dob = dates.parse(out.dob);
  if (out.usual_income !== undefined) out.usual_income = out.usual_income === '' ? null : money.parse(out.usual_income);
  if (out.surname) out.surname = out.surname.toUpperCase();
  if (out.mobile !== undefined) out.mobile_network = phone.networkOf(out.mobile);
  else delete out.mobile_network;
  return out;
}

function validate(c, onDate) {
  const errs = [];
  for (const [k, label] of Object.entries(REQUIRED)) if (!c[k]) errs.push(`${label} is required.`);
  if (c.dob && dates.ageOn(c.dob, onDate) < 18) errs.push('The pledger must be 18 or over.');
  // Stored mobiles are plain digits; the entry format is checked in enteredPhoneProblems().
  if (c.mobile && !phone.normalize(c.mobile)) errs.push('Mobile number is not a PNG mobile number.');
  if (c.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email)) errs.push('Email is not valid.');
  if (c.residence_proof_type && !RESIDENCE_PROOF.includes(c.residence_proof_type)) errs.push('Choose a residence proof type.');
  return errs;
}

// Contact numbers typed into the form must be written as (+675) 71234567 or (+675) 7123-4567.
const PHONE_FIELDS = { mobile: 'Mobile number', second_phone: 'Second number' };
function enteredPhoneProblems(input) {
  const errs = [];
  for (const [k, label] of Object.entries(PHONE_FIELDS)) {
    if (input[k] === undefined || input[k] === null) continue;
    if (input[k] === '' && k === 'second_phone') continue; // optional
    if (input[k] === '') continue; // "is required" comes from validate()
    const pr = phone.problem(input[k], label);
    if (pr) errs.push(pr);
  }
  return errs;
}
// Store numbers in one consistent shape once they have passed the entry check.
function tidyPhones(c) {
  if (c.mobile) c.mobile = phone.parseInput(c.mobile) || normMobile(c.mobile);
  if (c.second_phone) c.second_phone = phone.format(c.second_phone);
}

function findDuplicates({ mobileNorm, nameNorm, dob, excludeId = 0 }) {
  const d = db.get();
  const hits = [];
  if (mobileNorm) for (const r of d.prepare('SELECT id, customer_no FROM customers WHERE mobile_norm = ? AND id != ?').all(mobileNorm, excludeId)) hits.push({ ...r, why: 'same mobile number' });
  if (nameNorm && dob) for (const r of d.prepare('SELECT id, customer_no FROM customers WHERE name_norm = ? AND dob = ? AND id != ?').all(nameNorm, dob, excludeId)) hits.push({ ...r, why: 'same name and date of birth' });
  return hits;
}

function screenSanctions(ctx, c) {
  const aml = require('./aml');
  const nm = fullName(c);
  for (const s of db.get().prepare('SELECT * FROM sanctions_list').all()) {
    const cmp = names.compare(nm, s.full_name);
    if (cmp === 'match' || (cmp === 'flagged' && (!s.dob || s.dob === c.dob))) {
      aml.flag(ctx, { type: 'sanctions_match', customerId: c.id, details: `Possible sanctions list match: "${s.full_name}" (${s.source || 'list'}).` });
    }
  }
}

function sendToDuplicateReview(ctx, customerId, hits) {
  const reason = hits.map((h) => `${h.why} as ${h.customer_no}`).join('; ');
  db.get().prepare("UPDATE customers SET verification_status = 'duplicate_review', duplicate_reason = ?, duplicate_of = ? WHERE id = ?")
    .run(reason, hits[0].id, customerId);
  const c = get(customerId);
  notify.inApp({ role: 'cro', branchId: c.branch_id, title: `Possible duplicate customer ${c.customer_no}`, body: reason, link: `/customers/${customerId}` });
  audit.log(ctx, 'duplicate_blocked', 'customer', customerId, null, { reason });
}

// Customer photos: up to two uploaded photos (photo1, photo2). Uploading new photos replaces the
// earlier ones. The signature is given on the printed pledge ticket, not at registration.
function saveMedia(ctx, customerId, media = {}) {
  const uid = ctx.user && ctx.user.id;
  const uploads = [...(media.photo1 || []), ...(media.photo2 || []), ...(media.photo || [])];
  if (uploads.length) {
    files.removeOwner('customer_photo', customerId);
    files.storeUploads(uploads.slice(0, 2), { ownerType: 'customer_photo', ownerId: customerId, kind: 'customer_photo', userId: uid });
  } else if (media.photoDataUrl) {
    files.removeOwner('customer_photo', customerId);
    files.storeDataUrl({ ownerType: 'customer_photo', ownerId: customerId, kind: 'customer_photo', dataUrl: media.photoDataUrl, userId: uid });
  }
}

function create(ctx, data, media = {}) {
  requireRole(ctx, 'loan_officer');
  const on = today(ctx);
  const c = cleanInput(data);
  const errs = [...enteredPhoneProblems(c), ...validate(c, on)];
  if (errs.length) throw new RuleError('Please fix the customer profile.', errs);
  const consentTs = dates.nowIso();
  for (const k of ['consent_terms', 'consent_data', 'consent_forfeit']) if (!data[k]) errs.push('All three consents (loan terms, data use, forfeiture and sale) must be given and are dated.');
  if (errs.length) throw new RuleError('Consents are required.', [...new Set(errs)]);
  if (!(media.photo1 || []).length && !(media.photo || []).length && !media.photoDataUrl) throw new RuleError('Please fix the customer profile.', ['Upload the customer photo (Photo 1).']);
  tidyPhones(c);
  const nameNorm = names.norm(`${c.given_names} ${c.surname}`);
  const hits = findDuplicates({ mobileNorm: c.mobile, nameNorm, dob: c.dob });
  const d = db.get();
  const id = d.transaction(() => {
    const info = d.prepare(`INSERT INTO customers (customer_no, branch_id, ${EDITABLE.join(',')}, bank_account_enc, mobile_banking_enc,
      consent_terms_at, consent_data_at, consent_forfeit_at, name_norm, mobile_norm, created_by, created_at, updated_at)
      VALUES (@customer_no, @branch_id, ${EDITABLE.map((k) => '@' + k).join(',')}, @bank_account_enc, @mobile_banking_enc,
      @ts, @ts, @ts, @name_norm, @mobile_norm, @uid, @ts, @ts)`).run({
      ...Object.fromEntries(EDITABLE.map((k) => [k, c[k] ?? null])),
      sms_language: c.sms_language === 'tpi' ? 'tpi' : 'en',
      customer_no: seq.customerNo(), branch_id: ctx.user.branch_id,
      bank_account_enc: encrypt(data.bank_account), mobile_banking_enc: encrypt(data.mobile_banking),
      ts: consentTs, name_norm: nameNorm, mobile_norm: c.mobile, uid: ctx.user.id,
    });
    const cid = info.lastInsertRowid;
    saveMedia(ctx, cid, media);
    audit.log(ctx, 'create', 'customer', cid, null, { ...c, bank_account_enc: data.bank_account ? 'x' : null });
    if (hits.length) sendToDuplicateReview(ctx, cid, hits);
    screenSanctions(ctx, get(cid));
    return cid;
  })();
  return { id, duplicates: hits };
}

function update(ctx, id, data, media = {}) {
  requireRole(ctx, 'loan_officer', 'cro');
  const before = get(id);
  checkBranch(ctx, before.branch_id);
  const input = cleanInput(data);
  const c = { ...before, ...input };
  const errs = [...enteredPhoneProblems(input), ...validate(c, today(ctx))];
  if (errs.length) throw new RuleError('Please fix the customer profile.', [...new Set(errs)]);
  tidyPhones(c);
  const nameNorm = names.norm(`${c.given_names} ${c.surname}`);
  const d = db.get();
  d.transaction(() => {
    const sets = EDITABLE.map((k) => `${k} = @${k}`).join(', ');
    d.prepare(`UPDATE customers SET ${sets}, name_norm = @name_norm, mobile_norm = @mobile, updated_at = @ts
      WHERE id = @id`).run({
      ...Object.fromEntries(EDITABLE.map((k) => [k, c[k] ?? null])), sms_language: c.sms_language === 'tpi' ? 'tpi' : 'en',
      name_norm: nameNorm, ts: dates.nowIso(), id,
    });
    if (data.bank_account !== undefined && data.bank_account !== '') d.prepare('UPDATE customers SET bank_account_enc = ? WHERE id = ?').run(encrypt(data.bank_account), id);
    if (data.mobile_banking !== undefined && data.mobile_banking !== '') d.prepare('UPDATE customers SET mobile_banking_enc = ? WHERE id = ?').run(encrypt(data.mobile_banking), id);
    saveMedia(ctx, id, media);
    const [o, n] = audit.diff(before, c);
    audit.log(ctx, 'update', 'customer', id, o, n);
    // Name, DOB or mobile changes are re-checked for duplicates.
    const hits = findDuplicates({ mobileNorm: c.mobile, nameNorm, dob: c.dob, excludeId: id });
    if (hits.length && before.verification_status !== 'duplicate_review' && !before.duplicate_reviewed_at) sendToDuplicateReview(ctx, id, hits);
    recomputeVerification(id, today(ctx));
  })();
}

// The customer's mobile number is recorded as given; it is not confirmed by an SMS code
// (removed at the lender's request).

// ---------- Identity documents ----------
function idTypes(activeOnly = true) { return db.get().prepare(`SELECT * FROM id_types ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY id`).all(); }

function ids(customerId) {
  return db.get().prepare(`SELECT ci.*, t.name AS type_name, t.use AS type_use, t.photo AS type_photo, t.is_photo_id,
    u.full_name AS checked_by_name FROM customer_ids ci JOIN id_types t ON t.id = ci.id_type_id
    LEFT JOIN users u ON u.id = ci.checked_by WHERE ci.customer_id = ? ORDER BY ci.id`).all(customerId);
}

function addId(ctx, customerId, data, scans = {}) {
  requireRole(ctx, 'loan_officer');
  const c = get(customerId);
  checkBranch(ctx, c.branch_id);
  const t = db.get().prepare('SELECT * FROM id_types WHERE id = ? AND active = 1').get(data.id_type_id);
  const errs = [];
  if (!t) errs.push('Choose an accepted ID type.');
  // Only the type, the name exactly as on the ID and the scans are entered; the number, dates and
  // date of birth are on the scans, which the CRO checks. (A number may still be passed in.)
  const number = normalizeNumber(data.number) || null;
  const issue = dates.parse(data.issue_date), expiry = dates.parse(data.expiry_date), dobOnId = dates.parse(data.dob_on_id);
  if (!data.name_on_id) errs.push('Name exactly as on the ID is required.');
  if (!scans.front || !scans.front.length) errs.push('Front scan of the ID is required.');
  if (errs.length) throw new RuleError('Please fix the ID details.', errs);
  const existing = ids(customerId);
  if (existing.some((x) => x.id_type_id === t.id && x.status !== 'rejected')) throw new RuleError('This customer already has this ID type. The two IDs must be of different types.');
  const hash = number ? hmac(number) : null;
  const others = hash ? db.get().prepare(`SELECT ci.customer_id, c.customer_no FROM customer_ids ci JOIN customers c ON c.id = ci.customer_id
    WHERE ci.number_hash = ? AND ci.customer_id != ?`).all(hash, customerId) : [];
  const d = db.get();
  const idId = d.transaction(() => {
    const info = d.prepare(`INSERT INTO customer_ids(customer_id, id_type_id, number_enc, number_hash, number_last4, issued_by, issue_date,
      expiry_date, name_on_id, dob_on_id, name_check, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      customerId, t.id, number ? encrypt(number) : null, hash, number ? number.slice(-4) : null, data.issued_by || t.issued_by, issue, expiry,
      data.name_on_id.trim(), dobOnId, nameCheck(c, data.name_on_id, dobOnId), ctx.user.id, dates.nowIso());
    const rid = info.lastInsertRowid;
    files.storeUploads(scans.front, { ownerType: 'customer_id', ownerId: rid, kind: 'front', userId: ctx.user.id });
    if (scans.back) files.storeUploads(scans.back, { ownerType: 'customer_id', ownerId: rid, kind: 'back', userId: ctx.user.id });
    audit.log(ctx, 'add_id', 'customer_id', rid, null, { customer_id: customerId, type: t.name, number: number ? mask(number) : null, name_on_id: data.name_on_id });
    if (others.length) sendToDuplicateReview(ctx, customerId, others.map((o) => ({ id: o.customer_id, customer_no: o.customer_no, why: 'same ID number' })));
    db.get().prepare("UPDATE customers SET verification_status = CASE WHEN verification_status IN ('duplicate_review') THEN verification_status ELSE 'pending' END WHERE id = ?").run(customerId);
    notify.inApp({ role: 'cro', branchId: c.branch_id, title: `ID to verify for ${c.customer_no}`, body: `${t.name} added for ${fullName(c)}`, link: `/customers/${customerId}` });
    return rid;
  })();
  return idId;
}

function nameCheck(c, nameOnId, dobOnId) {
  if (dobOnId && dobOnId !== c.dob) return 'mismatch';
  return names.compare(fullName(c), nameOnId);
}

// The CRO checks the ID against its scans: the photo against the customer's photos, that it has
// not expired, and that the date of birth matches the profile (both read from the scan when they
// were not typed in).
function reviewId(ctx, idRecordId, { decision, photo_match, not_expired, dob_match, note }) {
  requireRole(ctx, 'cro');
  const r = db.get().prepare(`SELECT ci.*, t.use AS type_use, t.photo AS type_photo, t.name AS type_name FROM customer_ids ci
    JOIN id_types t ON t.id = ci.id_type_id WHERE ci.id = ?`).get(idRecordId);
  if (!r) throw new NotFound('ID record not found.');
  const c = get(r.customer_id);
  checkBranch(ctx, c.branch_id);
  const on = today(ctx);
  const nc = nameCheck(c, r.name_on_id, r.dob_on_id);
  if (decision === 'accept') {
    const errs = [];
    if (r.expiry_date && r.expiry_date < on) errs.push(`This ID expired on ${dates.fmt(r.expiry_date)} and must be rejected.`);
    if (!r.expiry_date && !not_expired) errs.push('Check the expiry date on the scan and confirm the ID has not expired.');
    if (r.dob_on_id && r.dob_on_id !== c.dob) errs.push('Date of birth on the ID does not match the profile.');
    if (!r.dob_on_id && !dob_match) errs.push(`Check the date of birth on the scan and confirm it matches the profile (${dates.fmt(c.dob)}).`);
    if (dates.ageOn(r.dob_on_id || c.dob, on) < 18) errs.push('The pledger is under 18.');
    if (nc === 'mismatch') errs.push('The name on the ID does not match the profile.');
    if (nc === 'flagged' && !note) errs.push('The name differs slightly from the profile: add a note explaining why you accept it.');
    if (r.type_photo === 'yes' && !photo_match) errs.push("Confirm the photo on the ID matches the customer's photos.");
    if (!files.list('customer_photo', c.id).length) errs.push('The customer has no photo yet: upload Photo 1 on the profile.');
    if (errs.length) throw new RuleError('This ID cannot be accepted.', errs);
  } else if (!note) throw new RuleError('Give a reason for rejecting the ID.');
  db.get().prepare('UPDATE customer_ids SET status = ?, photo_match = ?, name_check = ?, check_note = ?, checked_by = ?, checked_at = ? WHERE id = ?')
    .run(decision === 'accept' ? 'accepted' : 'rejected', photo_match ? 1 : 0, nc, note || null, ctx.user.id, dates.nowIso(), idRecordId);
  audit.log(ctx, decision === 'accept' ? 'id_accepted' : 'id_rejected', 'customer_id', idRecordId, { status: r.status },
    { status: decision, note, photo_match: !!photo_match, not_expired: r.expiry_date ? undefined : !!not_expired, dob_match: r.dob_on_id ? undefined : !!dob_match });
  recomputeVerification(c.id, on);
}

// Two valid IDs rule (see "Two valid IDs rule" 1–5).
function twoIdRule(customerId, onDate) {
  const reasons = [];
  const valid = ids(customerId).filter((x) => x.status === 'accepted' && (!x.expiry_date || x.expiry_date >= onDate));
  const types = new Set(valid.map((x) => x.id_type_id));
  if (types.size < 2) reasons.push('Two different, valid, unexpired IDs checked by the CRO are needed.');
  if (!valid.some((x) => x.type_use === 'primary' && x.type_photo === 'yes' && x.photo_match)) reasons.push("At least one must be a primary ID with a photo matched to the customer's photos.");
  const expired = ids(customerId).filter((x) => x.status === 'accepted' && x.expiry_date && x.expiry_date < onDate);
  for (const x of expired) reasons.push(`${x.type_name} expired on ${dates.fmt(x.expiry_date)}.`);
  return { ok: reasons.length === 0, reasons, valid };
}

function profileComplete(c) {
  const reasons = validate(c, dates.today()).filter((e) => !e.includes('18'));
  if (!files.list('customer_photo', c.id).length) reasons.push('Customer photo missing (upload Photo 1).');
  if (!c.consent_terms_at || !c.consent_data_at || !c.consent_forfeit_at) reasons.push('Consents missing.');
  return reasons;
}

// Everything that must be true before a loan can be created for this customer.
function loanReadiness(customerId, onDate) {
  const c = get(customerId);
  const reasons = [...profileComplete(c)];
  if (c.status !== 'active') reasons.push(`Customer status is ${c.status}.`);
  if (c.verification_status === 'duplicate_review') reasons.push('Waiting for the CRO to review a possible duplicate profile.');
  if (dates.ageOn(c.dob, onDate) < 18) reasons.push('Customer is under 18.');
  reasons.push(...twoIdRule(customerId, onDate).reasons);
  const aml = db.get().prepare("SELECT COUNT(*) n FROM aml_flags WHERE customer_id = ? AND status = 'open' AND type = 'sanctions_match'").get(customerId).n;
  if (aml) reasons.push('An open sanctions-list match must be cleared first.');
  return { ok: reasons.length === 0, reasons };
}

function recomputeVerification(customerId, onDate = dates.today()) {
  const c = get(customerId);
  if (c.verification_status === 'duplicate_review') return;
  const rule2 = twoIdRule(customerId, onDate);
  const pending = ids(customerId).some((x) => x.status === 'pending');
  const status = rule2.ok ? 'verified' : pending ? 'pending' : 'unverified';
  if (status !== c.verification_status) db.get().prepare('UPDATE customers SET verification_status = ? WHERE id = ?').run(status, customerId);
}

function resolveDuplicate(ctx, customerId, { decision, note }) {
  requireRole(ctx, 'cro');
  const c = get(customerId);
  rule(c.verification_status === 'duplicate_review', 'This profile is not waiting for a duplicate review.');
  rule(note, 'Add a note explaining the decision.');
  if (decision === 'clear') {
    db.get().prepare("UPDATE customers SET verification_status = 'unverified', duplicate_reviewed_by = ?, duplicate_reviewed_at = ? WHERE id = ?")
      .run(ctx.user.id, dates.nowIso(), customerId);
    recomputeVerification(customerId, today(ctx));
  } else {
    db.get().prepare("UPDATE customers SET status = 'inactive', verification_status = 'rejected', duplicate_reviewed_by = ?, duplicate_reviewed_at = ? WHERE id = ?")
      .run(ctx.user.id, dates.nowIso(), customerId);
  }
  audit.log(ctx, 'duplicate_' + decision, 'customer', customerId, { verification_status: c.verification_status }, { decision, note });
}

function setStatus(ctx, customerId, { status, risk_grade, note }) {
  requireRole(ctx, 'cro');
  const c = get(customerId);
  rule(['active', 'blacklisted', 'deceased', 'inactive'].includes(status), 'Invalid status.');
  rule(note, 'Give a reason for the status change.');
  db.get().prepare('UPDATE customers SET status = ?, risk_grade = ?, updated_at = ? WHERE id = ?').run(status, risk_grade || c.risk_grade, dates.nowIso(), customerId);
  audit.log(ctx, 'status_change', 'customer', customerId, { status: c.status, risk_grade: c.risk_grade }, { status, risk_grade, note });
}

// Search active customers (name, customer no, mobile, ID number).
function search(ctx, q) {
  const d = db.get();
  const branch = ctx.user.role === 'admin' ? null : ctx.user.branch_id;
  if (!q) return d.prepare(`SELECT * FROM customers ${branch ? 'WHERE branch_id = ?' : ''} ORDER BY id DESC LIMIT 100`).all(...(branch ? [branch] : []));
  const like = `%${q.trim().toUpperCase()}%`;
  const mob = normMobile(q);
  const byId = d.prepare('SELECT customer_id FROM customer_ids WHERE number_hash = ?').all(hmac(q)).map((r) => r.customer_id);
  return d.prepare(`SELECT * FROM customers WHERE (UPPER(surname || ' ' || given_names) LIKE @like OR UPPER(given_names || ' ' || surname) LIKE @like
    OR customer_no LIKE @like OR mobile_norm = @mob OR id IN (${byId.length ? byId.join(',') : '0'}))
    ${branch ? 'AND branch_id = @branch' : ''} ORDER BY surname LIMIT 100`).all({ like, mob: mob || '-', branch });
}

// ID number as the viewer may see it: masked for Loan Officers.
function idNumberFor(ctx, idRecord) {
  if (!idRecord.number_enc) return '';
  const full = decrypt(idRecord.number_enc);
  return ctx.user.role === 'loan_officer' ? mask(full) : full;
}
// How an ID is named on documents: its number when one was recorded, otherwise its type.
function idLabel(idRecord) { return idRecord.number_last4 ? `${idRecord.type_name} ${mask(idRecord.number_last4)}` : idRecord.type_name; }
function bankFor(ctx, c) {
  const acct = decrypt(c.bank_account_enc), mb = decrypt(c.mobile_banking_enc);
  return ctx.user.role === 'loan_officer' ? { account: mask(acct), mobile: mask(mb) } : { account: acct, mobile: mb };
}

module.exports = {
  PROVINCES, RESIDENCE_PROOF, REQUIRED, get, fullName, create, update, idTypes, ids, addId, reviewId,
  twoIdRule, profileComplete, loanReadiness, recomputeVerification, resolveDuplicate, setStatus, search, idNumberFor, idLabel, bankFor,
  normMobile, displayMobile, NETWORKS: phone.NAMES,
};
