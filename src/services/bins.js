'use strict';
// Numbered storage bins, per branch:
//   store — locked-store bins for laptops and phones (B-001 ...)
//   key   — key bins in the safe for car keys and papers (K-01 ...)
//   yard  — numbered bays in the secure car yard (Y-01 ...)
// Every item held is in a bin: laptops and phones in a store bin; cars in a yard bay with
// their keys in a key bin. A bin is freed automatically when its item leaves the lender.
const db = require('../db');
const dates = require('../lib/dates');
const audit = require('../lib/audit');
const { RuleError, NotFound, rule } = require('../lib/errors');
const { requireRole } = require('../lib/ctx');

const KINDS = {
  store: { label: 'Store bin', prefix: 'B', pad: 3, for: 'Laptops and phones' },
  key: { label: 'Key bin', prefix: 'K', pad: 2, for: 'Car keys and papers (in the safe)' },
  yard: { label: 'Yard bay', prefix: 'Y', pad: 2, for: 'Cars, utes and trucks' },
};
const HELD = "('in_store','for_sale','missing')";

// Human-readable label, also stored on the item as its location: "Bin B-012", "Key bin K-03", "Yard bay Y-04".
function label(bin) {
  if (!bin) return '';
  return bin.kind === 'store' ? `Bin ${bin.bin_no}` : `${KINDS[bin.kind].label} ${bin.bin_no}`;
}

function get(id) {
  const b = db.get().prepare('SELECT * FROM bins WHERE id = ?').get(id);
  if (!b) throw new NotFound('Bin not found.');
  return b;
}

function occupancyQuery(where) {
  return `SELECT b.*, br.name AS branch_name,
    (SELECT COUNT(*) FROM items i WHERE (i.bin_id = b.id OR i.key_bin_id = b.id) AND i.custody_status IN ${HELD}) AS used
    FROM bins b JOIN branches br ON br.id = b.branch_id ${where}`;
}

// Bins of one kind in a branch, with how many items are in each (for drop-downs).
function forBranch(branchId, kind, { activeOnly = true } = {}) {
  return db.get().prepare(occupancyQuery(`WHERE b.branch_id = ? AND b.kind = ? ${activeOnly ? 'AND b.active = 1' : ''}`) + ' ORDER BY b.bin_no')
    .all(branchId, kind).map((b) => ({ ...b, full: b.capacity ? b.used >= b.capacity : false, text: optionText(b) }));
}
function optionText(b) {
  const cap = b.capacity ? `${b.used}/${b.capacity}` : `${b.used} item${b.used === 1 ? '' : 's'}`;
  return `${b.bin_no}${b.description ? ' — ' + b.description : ''} (${b.capacity && b.used >= b.capacity ? 'FULL' : b.used ? cap : 'empty'})`;
}

function all(branchId) {
  return db.get().prepare(occupancyQuery(branchId ? 'WHERE b.branch_id = ?' : '') + ' ORDER BY br.name, b.kind, b.bin_no').all(...(branchId ? [branchId] : []));
}

// Items currently in a bin.
function contents(binId) {
  return db.get().prepare(`SELECT i.*, c.given_names || ' ' || c.surname AS customer_name, l.loan_no, l.status AS loan_status
    FROM items i JOIN customers c ON c.id = i.customer_id LEFT JOIN loans l ON l.id = i.current_loan_id
    WHERE (i.bin_id = ? OR i.key_bin_id = ?) AND i.custody_status IN ${HELD} ORDER BY i.item_no`).all(binId, binId);
}

// Checks that a chosen bin can take an item, and returns it.
function checkFree(binId, { branchId, kind, itemId = 0 }) {
  const what = KINDS[kind].label.toLowerCase();
  rule(binId, `Enter the ${what} number.`);
  const b = db.get().prepare('SELECT * FROM bins WHERE id = ?').get(binId);
  rule(b && b.active, `That ${what} does not exist or is closed.`);
  rule(b.kind === kind, `${b.bin_no} is a ${KINDS[b.kind].label.toLowerCase()}: ${KINDS[kind].for.toLowerCase()} go in ${what}s.`);
  rule(b.branch_id === branchId, `${label(b)} belongs to another branch.`);
  if (b.capacity) {
    const used = db.get().prepare(`SELECT COUNT(*) n FROM items WHERE (bin_id = ? OR key_bin_id = ?) AND custody_status IN ${HELD} AND id != ?`).get(b.id, b.id, itemId).n;
    rule(used < b.capacity, `${label(b)} is full (${used} of ${b.capacity}). Type another ${what} number.`);
  }
  return b;
}

// ---------- typed bin numbers ----------
// Staff type the bin number (c1, C-1, K-01, y3 ...). Letters are not case sensitive and spaces,
// dashes and leading zeros are ignored when matching, so "k1", "K 01" and "K-01" are the same bin.
function cleanNo(s) { return String(s || '').trim().toUpperCase().replace(/\s+/g, ' '); }
function keyOf(s) { return cleanNo(s).replace(/[\s\-_/.]+/g, '').replace(/\d+/g, (d) => String(Number(d))); }

function findTyped(branchId, text, kind = null) {
  const k = keyOf(text);
  if (!k) return null;
  const rows = db.get().prepare(`SELECT * FROM bins WHERE branch_id = ? ${kind ? 'AND kind = ?' : ''} ORDER BY active DESC, id`).all(...(kind ? [branchId, kind] : [branchId]));
  return rows.find((b) => keyOf(b.bin_no) === k) || null;
}

/**
 * The bin for a typed bin number: an existing bin of that number in the branch, or a new one
 * created on the spot. Refuses a number already used for another kind of bin, a closed bin and
 * a full bin. Returns the bin row.
 */
function resolve(ctx, text, { branchId, kind, itemId = 0 }) {
  const what = KINDS[kind].label.toLowerCase();
  const no = cleanNo(text);
  rule(no, `Enter the ${what} number (for example ${kind === 'store' ? 'C1 or B-012' : kind === 'key' ? 'K-01' : 'Y3'}).`);
  rule(no.length <= 20 && /^[A-Z0-9][A-Z0-9 \-/.]*$/.test(no), `"${String(text).trim()}" is not a valid ${what} number: use letters and numbers, for example C1 or K-01.`);
  let b = findTyped(branchId, no, kind);
  if (!b) {
    const other = findTyped(branchId, no);
    if (other) throw new RuleError(`${other.bin_no} is a ${KINDS[other.kind].label.toLowerCase()}. ${KINDS[kind].for} go in ${what}s: type a ${what} number.`);
    db.get().prepare('INSERT INTO bins(branch_id, kind, bin_no, capacity, description, created_at) VALUES (?,?,?,?,?,?)')
      .run(branchId, kind, no, kind === 'store' ? null : 1, 'Added when first used', dates.nowIso());
    b = findTyped(branchId, no, kind);
    audit.log(ctx, 'bin_created', 'bin', b.id, null, { bin_no: b.bin_no, kind, branch_id: branchId });
  }
  if (!b.active) throw new RuleError(`${label(b)} is closed. Type another ${what} number, or ask the Admin to reopen it.`);
  return checkFree(b.id, { branchId, kind, itemId });
}

// Admin: add a single bin or a numbered range (e.g. B-041 to B-060).
function create(ctx, { branch_id, kind, from, to, bin_no, capacity, description }) {
  requireRole(ctx, 'admin');
  rule(KINDS[kind], 'Choose the bin type.');
  const branch = db.get().prepare('SELECT * FROM branches WHERE id = ?').get(branch_id);
  rule(branch, 'Choose the branch.');
  const cap = capacity ? Number(capacity) : null;
  rule(cap === null || (Number.isInteger(cap) && cap > 0), 'Capacity must be a whole number, or blank for no limit.');
  const numbers = [];
  if (bin_no) {
    const existing = findTyped(branch.id, bin_no);
    rule(!existing, `Bin ${existing && existing.bin_no} already exists in this branch.`);
    numbers.push(cleanNo(bin_no));
  }
  else {
    const a = Number(from), b = Number(to);
    rule(Number.isInteger(a) && Number.isInteger(b) && a > 0 && b >= a && b - a < 500, 'Enter a number range, for example 41 to 60 (up to 500 bins at once).');
    for (let n = a; n <= b; n++) numbers.push(`${KINDS[kind].prefix}-${String(n).padStart(KINDS[kind].pad, '0')}`);
  }
  const ins = db.get().prepare('INSERT OR IGNORE INTO bins(branch_id, kind, bin_no, capacity, description, created_at) VALUES (?,?,?,?,?,?)');
  let added = 0;
  db.get().transaction(() => { for (const no of numbers) added += ins.run(branch.id, kind, no, cap, description || null, dates.nowIso()).changes; })();
  audit.log(ctx, 'bins_create', 'bin', branch.code, null, { kind, numbers: numbers.length > 3 ? `${numbers[0]} to ${numbers.at(-1)}` : numbers, added });
  return { added, skipped: numbers.length - added };
}

function update(ctx, id, { capacity, description, active }) {
  requireRole(ctx, 'admin');
  const b = get(id);
  const cap = capacity === '' || capacity === undefined ? null : Number(capacity);
  rule(cap === null || (Number.isInteger(cap) && cap > 0), 'Capacity must be a whole number, or blank for no limit.');
  const act = active === undefined ? b.active : active ? 1 : 0;
  if (!act) {
    const used = contents(b.id).length;
    if (used) throw new RuleError(`${label(b)} still holds ${used} item(s). Move them before closing the bin.`);
  }
  db.get().prepare('UPDATE bins SET capacity = ?, description = ?, active = ? WHERE id = ?').run(cap, description || null, act, id);
  audit.log(ctx, 'bin_update', 'bin', id, { capacity: b.capacity, description: b.description, active: b.active }, { capacity: cap, description, active: act });
}

// Default numbered bins for a branch that has none yet.
function seedBranch(branchId) {
  if (db.get().prepare('SELECT 1 FROM bins WHERE branch_id = ? LIMIT 1').get(branchId)) return;
  const ins = db.get().prepare('INSERT OR IGNORE INTO bins(branch_id, kind, bin_no, capacity, created_at) VALUES (?,?,?,?,?)');
  const now = dates.nowIso();
  for (let n = 1; n <= 40; n++) ins.run(branchId, 'store', `B-${String(n).padStart(3, '0')}`, null, now);
  for (let n = 1; n <= 20; n++) ins.run(branchId, 'key', `K-${String(n).padStart(2, '0')}`, 1, now);
  for (let n = 1; n <= 10; n++) ins.run(branchId, 'yard', `Y-${String(n).padStart(2, '0')}`, 1, now);
}

// Find a bin by what staff type or scan in the search box: "C1", "b12", "Bin B-012", "Key bin K-3".
function findByText(branchId, text) {
  const t = String(text || '').trim().replace(/^(bin|key bin|yard bay)\s+/i, '');
  if (!t || t.length > 20) return null;
  const k = keyOf(t);
  const rows = db.get().prepare(`SELECT * FROM bins ${branchId ? 'WHERE branch_id = ' + Number(branchId) : ''} ORDER BY active DESC, id`).all();
  return rows.find((b) => keyOf(b.bin_no) === k) || null;
}

module.exports = { KINDS, label, get, forBranch, all, contents, checkFree, resolve, findTyped, keyOf, create, update, seedBranch, findByText };
