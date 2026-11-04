'use strict';
// Money is stored as integer toea (1 kina = 100 toea) to avoid rounding drift.

function parse(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).replace(/[K,\s]/gi, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  const neg = s.startsWith('-');
  const [k, t = ''] = s.replace('-', '').split('.');
  const toea = Number(k) * 100 + Number((t + '00').slice(0, 2));
  return neg ? -toea : toea;
}

function fmt(toea, { sign = false } = {}) {
  if (toea === null || toea === undefined || toea === '') return '';
  const n = Math.round(Number(toea));
  const neg = n < 0;
  const abs = Math.abs(n);
  const k = Math.floor(abs / 100).toLocaleString('en-US');
  const t = String(abs % 100).padStart(2, '0');
  return `${neg ? '-' : sign ? '+' : ''}K${k}.${t}`;
}
// Plain number without the K, for spreadsheets.
function num(toea) { return Math.round(Number(toea || 0)) / 100; }

// Interest on principal (toea) at an integer weekly percentage, rounded half-up to the toea.
function pct(toea, ratePct) { return Math.round((toea * ratePct) / 100); }

module.exports = { parse, fmt, num, pct };
