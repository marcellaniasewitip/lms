'use strict';
// Name comparison used for the two-ID rule, ownership checks and sanctions screening.
function norm(s) { return String(s || '').toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' '); }

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[m][n];
}

// 'match' | 'flagged' (small spelling difference for the CRO to accept or reject) | 'mismatch'
function compare(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return 'mismatch';
  if (x === y) return 'match';
  const dist = levenshtein(x, y);
  const allowed = Math.max(2, Math.floor(Math.max(x.length, y.length) * 0.15));
  if (dist <= allowed) return 'flagged';
  // One name contains all tokens of the other (e.g. a missing middle name)
  const tx = x.split(' '), ty = y.split(' ');
  if (tx.every((t) => ty.includes(t)) || ty.every((t) => tx.includes(t))) return 'flagged';
  return 'mismatch';
}

module.exports = { norm, compare, levenshtein };
