'use strict';
const test = require('node:test');
const assert = require('node:assert');
const phone = require('../src/lib/phone');

test('the network comes from the first two digits', () => {
  for (const p of ['70', '71', '72', '73', '74', '79']) assert.equal(phone.networkOf(`+675 ${p}12 3456`), 'Digicel', p);
  for (const p of ['75', '76', '78']) assert.equal(phone.networkOf(`+675 ${p}12 3456`), 'Telikom', p);
  for (const p of ['81', '82', '83']) assert.equal(phone.networkOf(`+675 ${p}12 3456`), 'Vodafone', p);
});

test('accepts common ways of writing the number', () => {
  assert.equal(phone.normalize('+675 7123 4567'), '71234567');
  assert.equal(phone.normalize('675-7812-3456'), '78123456');
  assert.equal(phone.normalize('81234567'), '81234567');
});

test('rejects anything that is not an 8-digit PNG mobile with a known prefix', () => {
  for (const bad of ['', '77123456', '80123456', '84123456', '61234567', '7123456', '712345678', '+61 412 345 678', '325 0000']) {
    assert.equal(phone.normalize(bad), null, bad);
    assert.ok(phone.problem(bad), bad);
  }
  assert.match(phone.problem('712345678'), /8 digits/);
  assert.match(phone.problem('77123456'), /not a PNG mobile number/);
});

test('display format', () => {
  assert.equal(phone.display('71234567'), '+675 7123 4567');
  assert.equal(phone.display('81234567'), '+675 8123 4567');
});
