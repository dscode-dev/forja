import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  minor,
  add,
  currency,
  currencyDigits,
  moneyLimit,
} from '../src/finance/money';
test('exact minor-unit arithmetic rejects fractional, unsafe JSON numbers, noncanonical and overflow inputs', () => {
  assert.equal(add('9007199254740993', '7'), '9007199254741000');
  assert.equal(add('100000', '50000'), '150000');
  assert.equal(add('-10', '9'), '-1');
  assert.equal(minor(moneyLimit.toString()), moneyLimit);
  for (const value of [
    1.01,
    1,
    '1.01',
    '01',
    '+1',
    '-0',
    '1e2',
    '1000000000000000000',
    null,
  ])
    assert.throws(() => minor(value));
  assert.throws(() => minor('0', true));
  assert.throws(() => add(moneyLimit.toString(), '1'));
  assert.throws(() => currency('XXX'));
  assert.equal(currencyDigits[currency('JPY')], 0);
  assert.equal(currencyDigits[currency('KWD')], 3);
});
