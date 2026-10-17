import { test } from 'node:test';
import assert from 'node:assert/strict';
import { definitions, progression, template } from '../src/game/model';
test('virtual curve 1 is exact at level boundaries and safe bounds', () => {
  for (const xp of [
    0,
    20,
    50,
    99,
    100,
    101,
    199,
    200,
    10000,
    Number.MAX_SAFE_INTEGER - 100,
  ]) {
    const v = progression(xp);
    const level = 1n + BigInt(xp) / 100n;
    assert.equal(v.level, Number(level));
    assert.equal(v.xpToNextLevel, Number(100n * level - BigInt(xp)));
  }
  assert.throws(() => progression(-1));
  assert.throws(() => progression(0.5));
  assert.throws(() => progression(Number.MAX_SAFE_INTEGER));
});
test('only three versioned templates, no model-defined reward/executable code', () => {
  assert.equal(definitions.GOAL_TARGET.xp, 50);
  assert.equal(definitions.RESERVE_TARGET.xp, 50);
  assert.equal(definitions.WORK_PROFILE.xp, 20);
  assert.throws(() => template('STRATEGIST_AI'));
  assert.throws(() => template('toString'));
});
