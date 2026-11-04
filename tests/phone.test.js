'use strict';
const test = require('node:test');
const assert = require('node:assert');
const phone = require('../src/lib/phone');

test('contact numbers are accepted as (+675) 71234567 or (+675) 7123-4567', () => {
  assert.equal(phone.parseInput('(+675) 71234567'), '71234567');
  assert.equal(phone.parseInput('(+675) 8123-4567'), '81234567');
  assert.equal(phone.parseInput('  (+675) 7812-3456  '), '78123456'); // surrounding spaces are ignored
  assert.equal(phone.problem('(+675) 71234567'), null);
  assert.equal(phone.problem('(+675) 8123-4567'), null);
});

test('any other way of writing the number is refused with the format to use', () => {
  for (const bad of ['71234567', '7123 4567', '7123-4567', '+67571234567', '+675 7123 4567', '+675-7123-4567', '675 71234567',
    '(+675)71234567', '(+675) 7123 4567', '(675) 71234567', '(+675) 712345678', '(+675) 7123456']) {
    assert.equal(phone.parseInput(bad), null, bad);
    assert.match(phone.problem(bad), /must be written as \(\+675\) 71234567 or \(\+675\) 7123-4567/, bad);
  }
});

test('the network comes from the first two digits; unknown prefixes are refused', () => {
  for (const p of ['70', '71', '72', '73', '74', '79']) assert.equal(phone.networkOf(phone.parseInput(`(+675) ${p}12-3456`)), 'Digicel', p);
  for (const p of ['75', '76', '78']) assert.equal(phone.networkOf(phone.parseInput(`(+675) ${p}12-3456`)), 'Telikom', p);
  for (const p of ['81', '82', '83']) assert.equal(phone.networkOf(phone.parseInput(`(+675) ${p}12-3456`)), 'Vodafone', p);
  for (const p of ['77', '80', '84', '61']) {
    assert.equal(phone.parseInput(`(+675) ${p}12-3456`), null, p);
    assert.match(phone.problem(`(+675) ${p}12-3456`), /not a PNG mobile number/, p);
  }
});

test('numbers are shown as (+675) 7123-4567', () => {
  assert.equal(phone.format('71234567'), '(+675) 7123-4567');
  assert.equal(phone.format('+67581234567'), '(+675) 8123-4567');
});

test('the browser pattern matches the same format', () => {
  const re = new RegExp(`^(?:${phone.HTML_PATTERN})$`);
  assert.ok(re.test('(+675) 71234567') && re.test('(+675) 8123-4567'));
  assert.ok(!re.test('71234567') && !re.test('+675 7123 4567'));
});
