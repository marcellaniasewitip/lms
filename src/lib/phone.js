'use strict';
// Papua New Guinea mobile numbers.
//
// Entry format (contact fields): (+675) followed by the 8-digit number, written either as
//   (+675) 71234567   or   (+675) 7123-4567
// Anything else is refused with a message showing this format.
//
// The first two digits identify the network:
//   Digicel   70, 71, 72, 73, 74, 79
//   Telikom   75, 76, 78
//   Vodafone  81, 82, 83
//
// Customer mobiles are stored as the 8 local digits; staff mobiles as +675 plus the digits.
// Numbers are shown as (+675) 7123-4567.
const NETWORKS = {
  Digicel: ['70', '71', '72', '73', '74', '79'],
  Telikom: ['75', '76', '78'],
  Vodafone: ['81', '82', '83'],
};
const NAMES = Object.keys(NETWORKS);
const PREFIX_TEXT = NAMES.map((n) => `${n} ${NETWORKS[n].join('/')}`).join(', ');
const FORMAT = /^\(\+675\) (\d{4})-?(\d{4})$/;
const FORMAT_TEXT = '(+675) 71234567 or (+675) 7123-4567';
// Same rule for the browser's pattern attribute (whole value must match).
const HTML_PATTERN = '\\(\\+675\\) \\d{4}-?\\d{4}';

// Lenient: digits of an already-stored or searched number (internal use, not for entry checks).
function digits(s) {
  let n = String(s || '').replace(/\D/g, '');
  if (n.startsWith('675') && n.length === 11) n = n.slice(3);
  return n;
}
function networkOf(s) {
  const n = digits(s);
  if (!/^\d{8}$/.test(n)) return null;
  return NAMES.find((k) => NETWORKS[k].includes(n.slice(0, 2))) || null;
}
// Lenient: 8 local digits for any stored or searched PNG mobile, or null.
function normalize(s) { return networkOf(s) ? digits(s) : null; }

// Strict: the 8 local digits when the input follows the entry format and has a known prefix.
function parseInput(s) {
  const m = FORMAT.exec(String(s || '').trim());
  if (!m) return null;
  const n = m[1] + m[2];
  return networkOf(n) ? n : null;
}

// What is wrong with an entered number, or null when it is accepted.
function problem(s, label = 'Mobile number') {
  const v = String(s || '').trim();
  if (!v) return `${label} is required.`;
  const m = FORMAT.exec(v);
  if (!m) return `${label} must be written as ${FORMAT_TEXT} (you entered "${v}").`;
  if (!networkOf(m[1] + m[2])) return `${label} ${v} is not a PNG mobile number. Numbers start with ${PREFIX_TEXT}.`;
  return null;
}

// (+675) 7123-4567
function format(s) {
  const n = digits(s);
  return /^\d{8}$/.test(n) ? `(+675) ${n.slice(0, 4)}-${n.slice(4)}` : String(s || '');
}
const display = format;

module.exports = { NETWORKS, NAMES, PREFIX_TEXT, FORMAT, FORMAT_TEXT, HTML_PATTERN, normalize, networkOf, parseInput, problem, format, display };
