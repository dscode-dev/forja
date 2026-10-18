import {
  StrategyFacts,
  StrategyContext,
  StrategyOutput,
} from '../../src/ai/strategist-model';
export function strategyFacts(): StrategyFacts {
  return {
    day: '2026-10-18',
    financeCursor: 1,
    focus: 'RESERVE',
    work: { revision: 0, currency: null, totalMinor: null },
    game: { missions: [], awardSequence: 0 },
    goal: {
      id: '11111111-1111-4111-8111-111111111111',
      revision: 1,
      status: 'ACTIVE',
      accountId: '22222222-2222-4222-8222-222222222222',
      accountRevision: 1,
      accountState: 'active',
      currency: 'BRL',
      targetMinor: '900000',
      creditedMinor: '0',
      balanceMinor: '0',
      movementMinor: '0',
      calculation: null,
      calculationStale: false,
      capacityInsufficient: false,
    },
    pending: { incomingMinor: '0', outgoingMinor: '0', references: [] },
  };
}
// Test-only model selection; no runtime fallback.
export function strategySelected(c: StrategyContext): StrategyOutput {
  const t = c.templates.find((x) => x !== 'WORK_PROFILE') ?? c.templates[0];
  const rationale =
    t === 'WORK_PROFILE'
      ? 'WORK_UNKNOWN'
      : c.findings.includes('GOAL_DEFICIT')
        ? 'GOAL_DEFICIT'
        : c.findings[0]!;
  return {
    schema: 1,
    summary: c.findings[0]!,
    focus: c.findings[c.findings.length - 1]!,
    proposal: t ? { template: t, version: 1, rationale } : null,
    limitations: [...c.limitations],
  };
}
export function strategyCases() {
  const cases = [
    'no-reserve',
    'improving-reserve',
    'declining-reserve',
    'major-payable',
    'active-goal',
    'insufficient-capacity',
    'unknown-expense-baseline',
    'conflicting-priorities',
    'no-action',
  ] as const;
  return cases.map((name) => {
    const f = strategyFacts();
    switch (name) {
      case 'improving-reserve':
        f.goal!.balanceMinor = '100';
        f.goal!.creditedMinor = '100';
        f.goal!.movementMinor = '100';
        break;
      case 'declining-reserve':
        f.goal!.balanceMinor = '100';
        f.goal!.creditedMinor = '100';
        f.goal!.movementMinor = '-100';
        break;
      case 'major-payable':
      case 'conflicting-priorities':
        f.pending!.outgoingMinor = '1000000';
        break;
      case 'active-goal':
        f.focus = 'GOAL';
        break;
      case 'insufficient-capacity':
        f.work = { revision: 1, currency: 'BRL', totalMinor: '0' };
        f.goal!.capacityInsufficient = true;
        break;
      case 'no-action':
        f.goal = null;
        f.focus = 'GENERAL';
        f.work = { revision: 1, currency: 'BRL', totalMinor: '20000' };
        break;
    }
    return { name, facts: f };
  });
}
