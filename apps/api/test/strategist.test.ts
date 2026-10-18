import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strategyFacts, strategySelected } from './fixtures/strategist';
import { strategyMinimize, strategyOutput } from '../src/ai/strategist-model';
test('strategy grounding rejects custom XP, completion/parameters, unsupported evidence and sparse context; pending income is not settled reserve', () => {
  const f = strategyFacts(),
    c = strategyMinimize(f)!;
  const v = strategySelected(c);
  assert.equal(v.proposal?.template, 'RESERVE_TARGET');
  for (const extra of [
    { xp: 100 },
    { completed: true },
    { targetMinor: '100' },
    { code: 'execute' },
  ])
    assert.throws(() =>
      strategyOutput({ ...v, proposal: { ...v.proposal, ...extra } }, c),
    );
  assert.throws(() =>
    strategyOutput({ ...v, summary: 'RESERVE_DECLINING' }, c),
  );
  assert.throws(() =>
    strategyOutput(
      {
        ...v,
        proposal: {
          template: 'RESERVE_TARGET',
          version: 2,
          rationale: 'GOAL_DEFICIT',
        },
      },
      c,
    ),
  );
  f.pending!.incomingMinor = '99999999';
  assert.ok(strategyMinimize(f)!.findings.includes('RESERVE_EMPTY'));
  assert.ok(!strategyMinimize(f)!.findings.includes('RESERVE_IMPROVING'));
  f.goal = null;
  f.focus = 'GENERAL';
  assert.equal(strategyMinimize(f), null);
});
