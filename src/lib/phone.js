'use strict';
// Papua New Guinea mobile numbers (country code +675) for the three networks:
//   Digicel   +675 7xxx xxxx    — 8 digits starting with 7
//   Telikom   +675 7xxx xxxx(x) — starts with 7; 8 digits, and 9-digit numbers are accepted too
//   Vodafone  +675 8xxx xxxx    — 8 digits starting with 8
// Numbers are stored as local digits (no +675) and shown as +675 xxxx xxxx.
const NETWORKS = {
  Digicel: { pattern: /^7\d{7}$/, example: '+675 7xxx xxxx' },
  Telikom: { pattern: /^7\d{7,8}$/, example: '+675 7xxx xxxx' },
  Vodafone: { pattern: /^8\d{7}$/, example: '+675 8xxx xxxx' },
};
const NAMES = Object.keys(NETWORKS);

// Local digits for any valid PNG mobile, or null. Accepts spaces, dashes, "+675" or "675".
function normalize(s) {
  let n = String(s || '').replace(/\D/g, '');
  if (n.startsWith('675') && (n.length === 11 || n.length === 12)) n = n.slice(3);
  return NAMES.some((k) => NETWORKS[k].pattern.test(n)) ? n : null;
}

// Networks a number can belong to (Digicel and Telikom share the 7 prefix).
function networksFor(s) {
  const n = normalize(s);
  return n ? NAMES.filter((k) => NETWORKS[k].pattern.test(n)) : [];
}

function validFor(network, s) {
  const n = normalize(s);
  return !!(n && NETWORKS[network] && NETWORKS[network].pattern.test(n));
}

// Problem with a number for the chosen network, or null when it is fine.
function problem(s, network) {
  const n = normalize(s);
  if (!n) return 'Mobile number must be a PNG mobile: Digicel or Telikom +675 7xxx xxxx, or Vodafone +675 8xxx xxxx.';
  if (network && NETWORKS[network] && !NETWORKS[network].pattern.test(n)) {
    return `${network} numbers look like ${NETWORKS[network].example}; +675 ${display(n).slice(5)} is not a ${network} number.`;
  }
  if (network && !NETWORKS[network]) return 'Choose the mobile network: Digicel, Telikom or Vodafone.';
  return null;
}

function display(s) {
  const n = normalize(s) || String(s || '').replace(/\D/g, '');
  if (!n) return '';
  if (n.length === 9) return `+675 ${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
  return `+675 ${n.slice(0, 4)} ${n.slice(4)}`;
}

module.exports = { NETWORKS, NAMES, normalize, networksFor, validFor, problem, display };
