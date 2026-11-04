'use strict';
// All business dates are Port Moresby local dates (UTC+10, no daylight saving),
// stored as 'YYYY-MM-DD'. Display format is DD/MM/YYYY.
const OFFSET_MS = 10 * 3600 * 1000;

function today() {
  if (process.env.LMS_TODAY) return process.env.LMS_TODAY; // testing / training override
  return new Date(Date.now() + OFFSET_MS).toISOString().slice(0, 10);
}
function nowIso() { return new Date().toISOString(); }

function toUtcMs(d) { return Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)); }
function fromUtcMs(ms) { return new Date(ms).toISOString().slice(0, 10); }

function addDays(d, n) { return fromUtcMs(toUtcMs(d) + n * 86400000); }
function diffDays(a, b) { return Math.round((toUtcMs(b) - toUtcMs(a)) / 86400000); } // b - a

function addMonths(d, n) {
  let y = +d.slice(0, 4), m = +d.slice(5, 7) - 1 + n;
  const day = +d.slice(8, 10);
  y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return fromUtcMs(Date.UTC(y, m, Math.min(day, last)));
}
function addYears(d, n) { return addMonths(d, 12 * n); }

function ageOn(dob, on) {
  let a = +on.slice(0, 4) - +dob.slice(0, 4);
  if (on.slice(5) < dob.slice(5)) a -= 1;
  return a;
}

function isValidIso(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) return false;
  return fromUtcMs(toUtcMs(d)) === d;
}

// Accepts DD/MM/YYYY (the PNG display format) or YYYY-MM-DD. Returns ISO or null.
function parse(s) {
  if (!s) return null;
  s = String(s).trim();
  let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  let iso = null;
  if (m) iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) iso = s;
  return iso && isValidIso(iso) ? iso : null;
}

function fmt(d) {
  if (!d) return '';
  const s = String(d).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return String(d);
  return `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
}
// Timestamp (UTC ISO) shown in Port Moresby time.
function fmtTs(iso) {
  if (!iso) return '';
  const t = new Date(new Date(iso).getTime() + OFFSET_MS).toISOString();
  return `${fmt(t.slice(0, 10))} ${t.slice(11, 16)}`;
}
// Local date (PNG) of a UTC timestamp.
function localDateOf(iso) { return new Date(new Date(iso).getTime() + OFFSET_MS).toISOString().slice(0, 10); }
function monthOf(d) { return d.slice(0, 7); }

module.exports = { today, nowIso, addDays, diffDays, addMonths, addYears, ageOn, parse, fmt, fmtTs, isValidIso, localDateOf, monthOf };
