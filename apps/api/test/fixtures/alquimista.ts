import { catalogue, Context, Output, Finding } from '../../src/ai/model';
import type { ReportingService } from '../../src/reporting/reporting.service';
export type Facts = Awaited<ReturnType<ReportingService['alchemistFacts']>>;
export function facts(): Facts {
  return {
    reportVersion: 1,
    period: {
      type: 'DAILY',
      from: '2026-03-08',
      through: '2026-03-08',
      partial: false,
    },
    currency: 'BRL',
    settled: {
      incomeMinor: '20000',
      expenseMinor: '10000',
      netMinor: '10000',
      openingMinor: '0',
      closingMinor: '10000',
      baselineChangeMinor: '0',
    },
    comparisons: {
      income: {
        deltaMinor: '1000',
        percentageBasisPoints: '1000',
        reason: 'ABSOLUTE_PREVIOUS_DENOMINATOR',
      },
      expense: {
        deltaMinor: '1000',
        percentageBasisPoints: '1000',
        reason: 'ABSOLUTE_PREVIOUS_DENOMINATOR',
      },
      net: {
        deltaMinor: '0',
        percentageBasisPoints: '0',
        reason: 'ABSOLUTE_PREVIOUS_DENOMINATOR',
      },
    },
    planning: {
      predictedIncomeMinor: '0',
      receivableMinor: '0',
      payableMinor: '0',
      scheduledDebitMinor: '0',
      plannedNetMinor: '0',
    },
    goal: null,
    work: null,
    game: { xpGained: 0, missionsCompleted: 0, currentLevel: 1 },
  };
}
// Test-only selection double; production never fabricates provider output.
export function selected(c: Context, preferred?: Finding): Output {
  const finding = c.findings[0]!,
    other =
      preferred && preferred !== finding
        ? preferred
        : c.findings.find((x) => x !== finding)!,
    section = catalogue[other].sections[0];
  const result: Output = {
    schema: 1,
    summary: { finding, phrase: 'EXPLAIN' },
    highlights: [],
    attentionPoints: [],
    observations: [],
    questions: [],
    limitations: [...c.limitations],
  };
  if (!section || section === 'summary')
    throw new Error('Test fixture requires distinct non-summary finding');
  result[section].push({ finding: other, phrase: 'DIRECT' });
  return result;
}
export function evaluationCases() {
  const positive = facts(),
    negative = facts(),
    expenses = facts(),
    zero = facts(),
    planned = facts(),
    goal = facts(),
    unknown = facts(),
    empty = facts();
  negative.settled.expenseMinor = '30000';
  negative.settled.netMinor = '-10000';
  negative.settled.closingMinor = '-10000';
  zero.comparisons.income = {
    deltaMinor: '20000',
    percentageBasisPoints: null,
    reason: 'ZERO_BASELINE',
  };
  planned.planning.predictedIncomeMinor = '987654321';
  planned.planning.plannedNetMinor = '987654321';
  goal.goal = {
    status: 'ACTIVE',
    remainingMinor: '123456789',
    requiredIncome: null,
    requiredIncomeCurrency: null,
    requiredIncomePeriod: null,
    calculationStale: true,
  };
  empty.settled = {
    incomeMinor: '0',
    expenseMinor: '0',
    netMinor: '0',
    openingMinor: '0',
    closingMinor: '0',
    baselineChangeMinor: '0',
  };
  return [
    { name: 'positive-net', input: positive, expected: 'NET_POSITIVE' },
    { name: 'negative-net', input: negative, expected: 'NET_NEGATIVE' },
    { name: 'expenses-increased', input: expenses, expected: 'EXPENSE_UP' },
    { name: 'zero-previous-baseline', input: zero, expected: 'NET_POSITIVE' },
    {
      name: 'planned-not-received',
      input: planned,
      expected: 'PLANNED_INCOMING',
    },
    { name: 'goal-deficit', input: goal, expected: 'GOAL_DEFICIT' },
    { name: 'unknown-work', input: unknown, expected: 'WORK_UNKNOWN' },
    { name: 'no-meaningful-activity', input: empty, expected: null },
  ] as const;
}
