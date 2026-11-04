'use strict';
const test = require('node:test');
const assert = require('node:assert');
const phone = require('../src/lib/phone');

test('accepts Digicel, Telikom and Vodafone numbers in any common format', () => {
  assert.equal(phone.normalize('+675 7123 4567'), '71234567'); // Digicel / Telikom
  assert.equal(phone.normalize('675-7123-4567'), '71234567');
  assert.equal(phone.normalize('+675 712 345 678'), '712345678'); // 9-digit Telikom
  assert.equal(phone.normalize('+675 8123 4567'), '81234567'); // Vodafone
  assert.equal(phone.normalize('81234567'), '81234567');
});

test('rejects numbers that are not PNG mobiles', () => {
  for (const bad of ['', '6123 4567', '7123 456', '8123 45678', '91234567', '+61 412 345 678', '325 0000']) assert.equal(phone.normalize(bad), null, bad);
});

test('the number must match the chosen network', () => {
  assert.equal(phone.problem('71234567', 'Digicel'), null);
  assert.equal(phone.problem('71234567', 'Telikom'), null);
  assert.equal(phone.problem('712345678', 'Telikom'), null);
  assert.equal(phone.problem('81234567', 'Vodafone'), null);
  assert.match(phone.problem('81234567', 'Digicel'), /not a Digicel number/);
  assert.match(phone.problem('71234567', 'Vodafone'), /not a Vodafone number/);
  assert.match(phone.problem('712345678', 'Digicel'), /not a Digicel number/);
  assert.deepEqual(phone.networksFor('71234567'), ['Digicel', 'Telikom']);
  assert.deepEqual(phone.networksFor('81234567'), ['Vodafone']);
});

test('display format', () => {
  assert.equal(phone.display('71234567'), '+675 7123 4567');
  assert.equal(phone.display('81234567'), '+675 8123 4567');
  assert.equal(phone.display('712345678'), '+675 712 345 678');
});
