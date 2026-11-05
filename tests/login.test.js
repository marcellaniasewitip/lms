'use strict';
// Sign-in over HTTP: wrong username / wrong password messages appear on the login page,
// and an expired sign-in form goes back to the login page instead of an error page.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-login-'));
process.env.LMS_DATA_DIR = dir;
process.env.LMS_DB_FILE = path.join(dir, 'login.db');

const app = require('../src/server');
const users = require('../src/services/users');

let server, base;
test.before(async () => {
  users.create(null, { username: 'teller', full_name: 'Test Teller', role: 'loan_officer', branch_id: 1, mobile: '(+675) 7123-4567', password: 'Right#Pass2026' });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

// Minimal browser: keeps the session cookie and the form token.
function browser() {
  let cookie = '';
  const keep = (res) => { const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return res; };
  return {
    get: async (p) => keep(await fetch(base + p, { headers: { cookie }, redirect: 'manual' })),
    post: async (p, body) => keep(await fetch(base + p, {
      method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body),
    })),
    token: async function () { const html = await (await this.get('/login')).text(); return /name="_csrf" value="([^"]+)"/.exec(html)[1]; },
    loginPage: async function () { return (await this.get('/login')).text(); },
  };
}

test('wrong username shows "Wrong username" on the login page', async () => {
  const b = browser();
  const res = await b.post('/login', { _csrf: await b.token(), username: 'nobody', password: 'Right#Pass2026' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login');
  const html = await b.loginPage();
  assert.match(html, /Wrong username\. There is no account with that username\./);
  assert.match(html, /name="username" value="nobody"/); // username kept, password not
});

test('wrong password shows "Wrong password" with the attempts left', async () => {
  const b = browser();
  const res = await b.post('/login', { _csrf: await b.token(), username: 'teller', password: 'Nope#Pass2026' });
  assert.equal(res.headers.get('location'), '/login');
  const html = await b.loginPage();
  assert.match(html, /Wrong password\. 4 attempts left before the account is locked\./);
  assert.match(html, /name="username" value="teller"/);
});

test('an expired sign-in form returns to the login page with a message, not an error page', async () => {
  const b = browser();
  // No session at all (cookie expired or dropped by a proxy) and a stale token from an old page.
  const res = await b.post('/login', { _csrf: 'stale-token', username: 'teller', password: 'Nope#Pass2026' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login');
  const html = await b.loginPage();
  assert.match(html, /The sign-in page had expired/);
  assert.doesNotMatch(html, /ReferenceError|is not defined/);
});

test('other expired forms show the normal error page, never a stack trace', async () => {
  const b = browser();
  const res = await b.post('/logout', { _csrf: 'stale-token' });
  assert.equal(res.status, 403);
  const html = await res.text();
  assert.match(html, /This form has expired/);
  assert.doesNotMatch(html, /ReferenceError|is not defined|at eval/);
});

test('the right password moves on to the SMS code step', async () => {
  const b = browser();
  const res = await b.post('/login', { _csrf: await b.token(), username: 'teller', password: 'Right#Pass2026' });
  assert.equal(res.headers.get('location'), '/login/code');
});
