'use strict';
// The pledge ticket over HTTP: printing or downloading the PDF for signing unlocks the release.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-ticket-'));
process.env.LMS_DATA_DIR = dir;
process.env.LMS_DB_FILE = path.join(dir, 'ticket.db');
process.env.LMS_SHOW_CODES = '1';
process.env.LMS_TODAY = '2026-11-06';

const app = require('../src/server');
const db = require('../src/db');
const users = require('../src/services/users');
const customers = require('../src/services/customers');
const items = require('../src/services/items');
const loans = require('../src/services/loans');
const fx = require('../scripts/fixtures');

const mk = (u, role) => users.get(users.create(null, { username: u, full_name: u === 'teller' ? 'Samantha Garry' : u, role, branch_id: 1, mobile: '(+675) 7100-0001', password: 'Right#Pass2026' }));
let server, base, cookie = '', loanId;
const keep = (res) => { const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return res; };
const get = async (p) => keep(await fetch(base + p, { headers: { cookie }, redirect: 'manual' }));
const post = async (p, body) => keep(await fetch(base + p, { method: 'POST', headers: { cookie }, body: new URLSearchParams(body), redirect: 'manual' }));
const token = (html) => /name="_csrf" value="([^"]+)"/.exec(html)[1];

test.before(async () => {
  const lo = mk('teller', 'loan_officer'), cro = mk('cro1', 'cro');
  const t = '2026-11-06';
  const cust = fx.makeCustomer({ db, customers, items }, lo, cro, t, { surname: 'Arua', given: 'John Junior', dob: '08/10/1996', mobile: '82134228', nid: '9582850', second: 'B71942' });
  const it = fx.makeItem({ db, customers, items }, lo, t, cust, 'phone', { owner: 'John Junior Arua', imei: '356938035643809', brand: 'Samsung', model: 'Galaxy A24 5G' });
  loanId = loans.createApplication(fx.ctxFor(lo, t), { customer_id: cust, item_ids: [it], requested_amount: '140' });
  loans.submit(fx.ctxFor(lo, t), loanId);
  loans.valuate(fx.ctxFor(cro, t), loanId, it, fx.valuationData({ items }, 'phone', { grade: 'C', market: '1,000' }));
  loans.decide(fx.ctxFor(cro, t), loanId, { decision: 'approve', amount: '140', rate: 20 });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  let html = await (await get('/login')).text();
  await post('/login', { _csrf: token(html), username: 'teller', password: 'Right#Pass2026' });
  html = await (await get('/login/code')).text();
  await post('/login/code', { _csrf: token(html), code: /class="mono">(\d{6})</.exec(html)[1] });
});
test.after(() => server.close());

test('the release stays locked until the ticket is printed for signing', async () => {
  const html = await (await get(`/loans/${loanId}`)).text();
  assert.match(html, /Print pledge ticket/);
  assert.match(html, /Download PDF/);
  const res = await post(`/loans/${loanId}/release`, { _csrf: token(html), channel: 'cash', agreement_signed: '1' });
  assert.equal(res.status, 302);
  const page = await (await get(`/loans/${loanId}`)).text();
  assert.match(page, /Print the pledge ticket first/);
  assert.equal(loans.get(loanId).status, 'approved');
});

test('the ticket downloads as a 4-page PDF and counts as printed for signing', async () => {
  const res = await get(`/loans/${loanId}/ticket/pdf?print=1`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.match(res.headers.get('content-disposition'), /pledge-ticket-\d+\.pdf/);
  const pdf = Buffer.from(await res.arrayBuffer());
  assert.equal(pdf.slice(0, 5).toString(), '%PDF-');
  assert.equal((pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length, 4); // ticket + Disclosure Statement, two copies
  assert.equal(loans.get(loanId).ticket_printed_on, '2026-11-06');
});

test('the printed ticket shows the Kinaboy heading and this customer\'s details', async () => {
  const html = await (await get(`/loans/${loanId}/ticket`)).text();
  assert.match(html, /KINABOY<\/span><span class="bar">\|<\/span><span class="slogan">When it matters/);
  assert.match(html, /ID #: 9582850 \/ B71942/);
  assert.match(html, /Signed by: John Junior ARUA/);
  assert.match(html, /Signed by: Samantha Garry/);
  assert.match(html, /ELECTRONIC PHONE, Samsung Galaxy A24 5G/);
});

test('once printed and signed, the money can be released', async () => {
  const html = await (await get(`/loans/${loanId}`)).text();
  await post(`/loans/${loanId}/release`, { _csrf: token(html), channel: 'cash', agreement_signed: '1' });
  assert.equal(loans.get(loanId).status, 'active');
});
