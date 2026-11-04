'use strict';
// Papua New Guinea mobile numbers (country code +675). Every mobile is 8 digits and the
// first two digits identify the network:
//   Digicel   70, 71, 72, 73, 74, 79   e.g. +675 7123 4567
//   Telikom   75, 76, 78               e.g. +675 7812 3456
//   Vodafone  81, 82, 83               e.g. +675 8123 4567
// Numbers are stored as the 8 local digits (no +675) and shown as +675 xxxx xxxx.
const NETWORKS = {
  Digicel: ['70', '71', '72', '73', '74', '79'],
  Telikom: ['75', '76', '78'],
  Vodafone: ['81', '82', '83'],
};
const NAMES = Object.keys(NETWORKS);
const PREFIX_TEXT = NAMES.map((n) => `${n} ${NETWORKS[n].join('/')}`).join(', ');

function digits(s) {
  let n = String(s || '').replace(/\D/g, '');
  if (n.startsWith('675') && n.length === 11) n = n.slice(3);
  return n;
}

// The network a number belongs to, or null if it is not a PNG mobile.
function networkOf(s) {
  const n = digits(s);
  if (!/^\d{8}$/.test(n)) return null;
  return NAMES.find((k) => NETWORKS[k].includes(n.slice(0, 2))) || null;
}

// The 8 local digits for a valid PNG mobile, or null. Accepts spaces, dashes, "+675" or "675".
function normalize(s) { return networkOf(s) ? digits(s) : null; }

// What is wrong with a number, or null when it is a valid PNG mobile.
function problem(s) {
  const n = digits(s);
  if (!n) return 'Mobile number is required.';
  if (n.length !== 8) return `A PNG mobile number has 8 digits after +675 (this one has ${n.length}).`;
  if (!networkOf(n)) return `+675 ${n.slice(0, 4)} ${n.slice(4)} is not a PNG mobile number. Numbers start with ${PREFIX_TEXT}.`;
  return null;
}

function display(s) {
  const n = digits(s);
  return n ? `+675 ${n.slice(0, 4)} ${n.slice(4)}` : '';
}

module.exports = { NETWORKS, NAMES, PREFIX_TEXT, normalize, networkOf, problem, display };
