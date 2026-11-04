'use strict';
const db = require('../db');
const START = { customer: 10000, loan: 1000, item: 100000, receipt: 100000 };

// Issues the next number in a named sequence (atomic inside better-sqlite3's single connection).
function next(name) {
  const d = db.get();
  const row = d.prepare('SELECT value FROM sequences WHERE name = ?').get(name);
  const value = row ? row.value + 1 : (START[name] || 1) + 1;
  d.prepare('INSERT INTO sequences(name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value').run(name, value);
  return value;
}
const customerNo = () => 'C' + next('customer');
const loanNo = () => String(next('loan')); // contract number on the pledge ticket
const itemNo = () => 'IT' + next('item'); // barcode tag
const receiptNo = () => 'R' + next('receipt');
module.exports = { next, customerNo, loanNo, itemNo, receiptNo };
