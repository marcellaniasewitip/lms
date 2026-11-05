'use strict';
// Registering a customer over HTTP with different attachments: unaccepted files are refused
// with a message on the form (never the "Something went wrong" page), and nothing is saved.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-upload-'));
process.env.LMS_DATA_DIR = dir;
process.env.LMS_DB_FILE = path.join(dir, 'upload.db');
process.env.LMS_SHOW_CODES = '1';

const app = require('../src/server');
const db = require('../src/db');
const users = require('../src/services/users');
const files = require('../src/services/files');

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(100)]);
const DOCX = Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(100)]);

let server, base, cookie = '';
const keep = (res) => { const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return res; };
const get = async (p) => keep(await fetch(base + p, { headers: { cookie }, redirect: 'manual' }));
// Like a browser on the same site, forms send the page they were on (Referer).
const post = async (p, body, from) => keep(await fetch(base + p, { method: 'POST', headers: { cookie, ...(from ? { referer: base + from } : {}) }, body, redirect: 'manual' }));
const form = (o) => new URLSearchParams(o);
const token = (html) => /name="_csrf" value="([^"]+)"/.exec(html)[1];

test.before(async () => {
  users.create(null, { username: 'teller', full_name: 'Test Teller', role: 'loan_officer', branch_id: 1, mobile: '(+675) 7123-4567', password: 'Right#Pass2026' });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  let html = await (await get('/login')).text();
  await post('/login', form({ _csrf: token(html), username: 'teller', password: 'Right#Pass2026' }));
  html = await (await get('/login/code')).text();
  const code = /class="mono">(\d{6})</.exec(html)[1];
  await post('/login/code', form({ _csrf: token(html), code }));
});
test.after(() => server.close());

let n = 0;
async function register({ photo, residence }) {
  n++;
  const html = await (await get('/customers/new')).text();
  const fd = new FormData();
  const fields = {
    surname: `Kapi${'ABCDEFGH'[n]}`, given_names: 'Rose', dob: `0${n}/03/1991`, sex: 'Female', marital_status: 'Single', citizenship: 'Papua New Guinean',
    home_province: 'Eastern Highlands', home_district: 'Goroka', home_village: 'Asaro', mobile: `(+675) 7345-678${n}`,
    addr_province: 'National Capital District', addr_district: 'Moresby North-East', addr_town: 'Gerehu', addr_section_lot: 'Section 3, Lot 4',
    addr_landmark: 'Near the market', residence_proof_type: 'Utility bill', nok_name: 'Paul Kapi', nok_relationship: 'Brother',
    nok_phone: '(+675) 7456-7890', nok_address: 'Asaro', sms_language: 'en', consent_terms: '1', consent_data: '1', consent_forfeit: '1',
  };
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (photo) fd.append('photo', new Blob([photo.buf], { type: photo.type }), photo.name);
  if (residence) fd.append('residence', new Blob([residence.buf], { type: residence.type }), residence.name);
  const res = await post(`/customers?_csrf=${token(html)}`, fd, '/customers/new');
  const loc = (res.headers.get('location') || '').replace(base, '');
  const page = res.status === 302 ? await (await get(loc)).text() : await res.text();
  return { res, loc, page, surname: fields.surname };
}
const count = () => db.get().prepare('SELECT COUNT(*) n FROM customers').get().n;

test('a JPEG photo (even reported as image/jpg) and a PNG scan register the customer', async () => {
  const { res, page } = await register({ photo: { buf: JPEG, type: 'image/jpg', name: 'IMG_0001.JPG' }, residence: { buf: PNG, type: 'image/png', name: 'bill.png' } });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /\/customers\/\d+$/);
  assert.match(page, /Customer registered/);
  assert.equal(db.get().prepare("SELECT mime FROM files WHERE owner_type = 'customer_photo'").get().mime, 'image/jpeg');
});

test('an iPhone HEIC photo is refused on the form with instructions, and nothing is saved', async () => {
  const before = count();
  const { loc, page } = await register({ photo: { buf: HEIC, type: 'image/heif', name: 'IMG_0002.HEIC' } });
  assert.equal(loc, '/customers/new'); // back on the same form
  assert.match(page, /This file cannot be attached/);
  assert.match(page, /iPhone HEIC\/HEIF photo/);
  assert.match(page, /value="Rose"/); // what was typed is kept
  assert.doesNotMatch(page, /Something went wrong/);
  assert.equal(count(), before);
});

test('a Word document as residence proof is refused with a clear message', async () => {
  const before = count();
  const { page } = await register({ residence: { buf: DOCX, type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', name: 'letter.docx' } });
  assert.match(page, /&#34;letter.docx&#34; is not a photo or PDF/);
  assert.equal(count(), before);
});

test('a file over 10 MB is refused with a message instead of hanging', async () => {
  const { res, page } = await register({ photo: { buf: Buffer.concat([JPEG, Buffer.alloc(10.5 * 1024 * 1024)]), type: 'image/jpeg', name: 'huge.jpg' } });
  assert.equal(res.status, 302);
  assert.match(page, /larger than 10 MB/);
});

test('the security headers let the browser send the page address within the site', async () => {
  const res = await get('/login');
  assert.equal(res.headers.get('referrer-policy'), 'same-origin');
});

test('files are recognised by their content', () => {
  assert.equal(files.sniff(JPEG), 'image/jpeg');
  assert.equal(files.sniff(PNG), 'image/png');
  assert.equal(files.sniff(Buffer.from('%PDF-1.7 rest of the file')), 'application/pdf');
  assert.equal(files.sniff(HEIC), 'heic');
  assert.equal(files.sniff(DOCX), null);
});
