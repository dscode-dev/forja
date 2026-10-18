import { object } from '../identity/validation';
import { minor } from '../finance/money';
import type { ReportingService } from '../reporting/reporting.service';
export const POLICY = 'forja.ai.v1';
export const PROMPT_VERSION = 1;
export const CONFIG_VERSION = 'openai-responses-gpt54mini-v1';
export type Section =
  'summary' | 'highlights' | 'attentionPoints' | 'observations';
const entry = (
  refs: string[],
  sections: Section[],
  direct: string,
  explain: string,
) => ({ refs, sections, DIRECT: direct, EXPLAIN: explain });
export const catalogue = {
  NET_POSITIVE: entry(
    ['settled.net'],
    ['summary', 'highlights'],
    'O resultado realizado do período foi positivo.',
    'As receitas realizadas superaram as despesas realizadas neste período.',
  ),
  NET_NEGATIVE: entry(
    ['settled.net'],
    ['summary', 'attentionPoints'],
    'O resultado realizado do período foi negativo.',
    'As despesas realizadas superaram as receitas realizadas neste período.',
  ),
  NET_ZERO: entry(
    ['settled.net'],
    ['summary', 'observations'],
    'O resultado realizado do período foi neutro.',
    'As receitas e despesas realizadas se equilibraram neste período.',
  ),
  EXPENSE_UP: entry(
    ['comparisons.expense'],
    ['attentionPoints'],
    'As despesas realizadas aumentaram na comparação.',
    'O total de despesas deste recorte foi maior que o do período anterior comparado.',
  ),
  EXPENSE_DOWN: entry(
    ['comparisons.expense'],
    ['highlights'],
    'As despesas realizadas diminuíram na comparação.',
    'O total de despesas deste recorte foi menor que o do período anterior comparado.',
  ),
  INCOME_UP: entry(
    ['comparisons.income'],
    ['highlights'],
    'As receitas realizadas aumentaram na comparação.',
    'O total de receitas deste recorte foi maior que o do período anterior comparado.',
  ),
  INCOME_DOWN: entry(
    ['comparisons.income'],
    ['attentionPoints'],
    'As receitas realizadas diminuíram na comparação.',
    'O total de receitas deste recorte foi menor que o do período anterior comparado.',
  ),
  PLANNED_INCOMING: entry(
    ['planning.predictedIncome', 'planning.receivable'],
    ['observations'],
    'Há entradas planejadas ainda não recebidas.',
    'Renda prevista e valores a receber permanecem separados das receitas realizadas.',
  ),
  PLANNED_OUTGOING: entry(
    ['planning.scheduledDebit', 'planning.payable'],
    ['observations', 'attentionPoints'],
    'Há saídas planejadas ainda não pagas.',
    'Débitos agendados e valores a pagar permanecem separados das despesas realizadas.',
  ),
  GOAL_DEFICIT: entry(
    ['goal.remaining'],
    ['attentionPoints', 'observations'],
    'A meta observada ainda apresenta valor a alcançar.',
    'Os recursos realizados atribuídos à meta ainda não cobrem seu objetivo declarado.',
  ),
  WORK_UNKNOWN: entry(
    ['work.capacity'],
    ['observations'],
    'A capacidade declarada não está disponível neste contexto.',
    'Sem capacidade declarada conhecida, esta leitura não compara trabalho planejado com receitas realizadas.',
  ),
  REQUIRED_STALE: entry(
    ['goal.requiredIncome'],
    ['observations'],
    'O cálculo de renda observado pertence a uma geração anterior.',
    'Consulte a moeda e o horizonte próprios do cálculo registrado; ele não é uma nova meta de renda deste relatório.',
  ),
} as const;
export type Finding = keyof typeof catalogue;
export const limitations = {
  SCOPE:
    'Esta leitura considera somente a conta e o período do relatório; não é uma avaliação financeira completa.',
  PLANNED:
    'Planejamento não comprova recebimento nem pagamento; os fatos realizados permanecem no relatório determinístico.',
  PARTIAL:
    'O período está em andamento e é comparado ao período civil anterior completo, sem normalização.',
  ZERO_BASELINE:
    'Uma base anterior nula não permite apresentar variação percentual para essa comparação.',
} as const;
export type Limitation = keyof typeof limitations;
export const questions = {
  REVIEW_SPENDING: {
    text: 'Que despesas merecem uma revisão?',
    requires: ['EXPENSE_UP', 'NET_NEGATIVE'],
  },
  REVIEW_PENDING: {
    text: 'Quais entradas ou saídas planejadas precisam de acompanhamento?',
    requires: ['PLANNED_INCOMING', 'PLANNED_OUTGOING'],
  },
  REVIEW_GOAL: {
    text: 'O objetivo e o prazo declarados ainda fazem sentido para você?',
    requires: ['GOAL_DEFICIT'],
  },
  REVIEW_CAPACITY: {
    text: 'Seu perfil de trabalho descreve a capacidade que deseja planejar?',
    requires: ['WORK_UNKNOWN'],
  },
} as const;
export type Question = keyof typeof questions;
export interface Context {
  role: 'ALQUIMISTA';
  locale: 'pt-BR';
  context_schema: 1;
  period:
    'DAY' | 'WEEK' | 'MONTH' | 'CUSTOM_SHORT' | 'CUSTOM_MEDIUM' | 'CUSTOM_LONG';
  findings: Finding[];
  limitations: Limitation[];
}
export interface Selection {
  finding: Finding;
  phrase: 'DIRECT' | 'EXPLAIN';
}
export interface Output {
  schema: 1;
  summary: Selection;
  highlights: Selection[];
  attentionPoints: Selection[];
  observations: Selection[];
  questions: Question[];
  limitations: Limitation[];
}
export class AiFailure extends Error {
  constructor(readonly kind: Failure) {
    super('AI execution unavailable');
  }
}
export type Failure =
  | 'CONFIGURATION'
  | 'TIMEOUT'
  | 'UNAVAILABLE'
  | 'RATE_LIMIT'
  | 'REFUSAL'
  | 'INVALID_OUTPUT'
  | 'OUTCOME_UNKNOWN'
  | 'CONSENT_REVOKED'
  | 'SOURCE_EXPIRED'
  | 'INSUFFICIENT_CONTEXT'
  | 'THROTTLED'
  | 'CANCELLED';
const invalid = () => {
  throw new AiFailure('INVALID_OUTPUT');
};
function member<T extends string>(v: unknown, values: readonly T[]): T {
  if (typeof v !== 'string' || !values.includes(v as T)) return invalid();
  return v as T;
}
function unique<T>(v: T[], max: number): T[] {
  if (v.length > max || new Set(v).size !== v.length) return invalid();
  return v;
}
export function context(raw: unknown): Context {
  const b = object(raw, [
    'role',
    'locale',
    'context_schema',
    'period',
    'findings',
    'limitations',
  ]);
  if (
    b['role'] !== 'ALQUIMISTA' ||
    b['locale'] !== 'pt-BR' ||
    b['context_schema'] !== 1 ||
    !Array.isArray(b['findings']) ||
    !Array.isArray(b['limitations'])
  )
    return invalid();
  const result: Context = {
    role: 'ALQUIMISTA',
    locale: 'pt-BR',
    context_schema: 1,
    period: member(b['period'], [
      'DAY',
      'WEEK',
      'MONTH',
      'CUSTOM_SHORT',
      'CUSTOM_MEDIUM',
      'CUSTOM_LONG',
    ]),
    findings: unique(
      b['findings'].map((x) => member(x, Object.keys(catalogue) as Finding[])),
      6,
    ),
    limitations: unique(
      b['limitations'].map((x) =>
        member(x, Object.keys(limitations) as Limitation[]),
      ),
      4,
    ),
  };
  if (
    result.findings.length < 2 ||
    !result.limitations.includes('SCOPE') ||
    Buffer.byteLength(JSON.stringify(result)) > 2048
  )
    return invalid();
  return result;
}
type Facts = Awaited<ReturnType<ReportingService['alchemistFacts']>>;
export function minimize(v: Facts): Context | null {
  const income = minor(v.settled.incomeMinor),
    expense = minor(v.settled.expenseMinor),
    net = minor(v.settled.netMinor),
    incoming =
      minor(v.planning.predictedIncomeMinor) +
      minor(v.planning.receivableMinor),
    outgoing =
      minor(v.planning.scheduledDebitMinor) + minor(v.planning.payableMinor);
  const families =
    Number(income !== 0n) +
    Number(expense !== 0n) +
    Number(incoming !== 0n || outgoing !== 0n) +
    Number(v.goal !== null && minor(v.goal.remainingMinor) > 0n);
  if ((income === 0n && expense === 0n) || families < 2) return null;
  const findings: Finding[] = [
    net > 0n ? 'NET_POSITIVE' : net < 0n ? 'NET_NEGATIVE' : 'NET_ZERO',
  ];
  const limits: Limitation[] = ['SCOPE'];
  if (v.period.partial) limits.push('PARTIAL');
  for (const [name, c] of [
    ['expense', v.comparisons.expense],
    ['income', v.comparisons.income],
  ] as const) {
    if (c.reason === 'ZERO_BASELINE') {
      if (!limits.includes('ZERO_BASELINE')) limits.push('ZERO_BASELINE');
      continue;
    }
    const delta = minor(c.deltaMinor);
    if (delta !== 0n)
      findings.push(
        name === 'expense'
          ? delta > 0n
            ? 'EXPENSE_UP'
            : 'EXPENSE_DOWN'
          : delta > 0n
            ? 'INCOME_UP'
            : 'INCOME_DOWN',
      );
  }
  if (incoming > 0n) {
    findings.push('PLANNED_INCOMING');
    limits.push('PLANNED');
  }
  if (outgoing > 0n) {
    findings.push('PLANNED_OUTGOING');
    if (!limits.includes('PLANNED')) limits.push('PLANNED');
  }
  if (v.goal && minor(v.goal.remainingMinor) > 0n)
    findings.push('GOAL_DEFICIT');
  if (!v.work || v.work.totalMinor === null) findings.push('WORK_UNKNOWN');
  if (v.goal?.calculationStale) findings.push('REQUIRED_STALE');
  if (findings.length < 2) return null;
  const days =
    (Date.parse(v.period.through) - Date.parse(v.period.from)) / 86400000 + 1;
  if (!Number.isSafeInteger(days) || days < 1 || days > 366) return invalid();
  return context({
    role: 'ALQUIMISTA',
    locale: 'pt-BR',
    context_schema: 1,
    period:
      v.period.type === 'DAILY'
        ? 'DAY'
        : v.period.type === 'WEEKLY'
          ? 'WEEK'
          : v.period.type === 'MONTHLY'
            ? 'MONTH'
            : days <= 7
              ? 'CUSTOM_SHORT'
              : days <= 31
                ? 'CUSTOM_MEDIUM'
                : 'CUSTOM_LONG',
    findings: findings.slice(0, 6),
    limitations: limits,
  });
}
export function output(raw: unknown, c: Context | null): Output {
  try {
    if (c) context(c);
    const b = object(raw, [
      'schema',
      'summary',
      'highlights',
      'attentionPoints',
      'observations',
      'questions',
      'limitations',
    ]);
    if (b['schema'] !== 1) return invalid();
    const seen = new Set<Finding>();
    const selection = (raw: unknown, section: Section): Selection => {
      const x = object(raw, ['finding', 'phrase']),
        finding = member(x['finding'], Object.keys(catalogue) as Finding[]),
        phrase = member(x['phrase'], ['DIRECT', 'EXPLAIN']);
      if (
        (c && !c.findings.includes(finding)) ||
        seen.has(finding) ||
        !(catalogue[finding].sections as readonly string[]).includes(section)
      )
        return invalid();
      seen.add(finding);
      return { finding, phrase };
    };
    const list = (key: 'highlights' | 'attentionPoints' | 'observations') => {
      const a = b[key];
      if (!Array.isArray(a) || a.length > 2) return invalid();
      return a.map((x) => selection(x, key));
    };
    const summary = selection(b['summary'], 'summary'),
      highlights = list('highlights'),
      attentionPoints = list('attentionPoints'),
      observations = list('observations');
    if (
      seen.size < 2 ||
      !Array.isArray(b['questions']) ||
      !Array.isArray(b['limitations'])
    )
      return invalid();
    const qs = unique(
      b['questions'].map((x) =>
        member(x, Object.keys(questions) as Question[]),
      ),
      2,
    );
    for (const q of qs)
      if (
        c &&
        !questions[q].requires.some((x) => c.findings.includes(x as Finding))
      )
        return invalid();
    const ls = unique(
      b['limitations'].map((x) =>
        member(x, Object.keys(limitations) as Limitation[]),
      ),
      4,
    );
    if (
      c &&
      (ls.length !== c.limitations.length ||
        ls.some((x) => !c.limitations.includes(x)))
    )
      return invalid();
    const result: Output = {
      schema: 1,
      summary,
      highlights,
      attentionPoints,
      observations,
      questions: qs,
      limitations: ls,
    };
    if (Buffer.byteLength(JSON.stringify(result)) > 8192) return invalid();
    return result;
  } catch {
    return invalid();
  }
}
export function render(o: Output) {
  const line = (s: Selection) => ({
    text: catalogue[s.finding][s.phrase],
    metricRefs: [...catalogue[s.finding].refs],
  });
  return {
    schema: 1,
    kind: 'AI_INTERPRETATION',
    method: 'MODEL_SELECTED_REVIEWED_TEXT',
    summary: line(o.summary),
    highlights: o.highlights.map(line),
    attentionPoints: o.attentionPoints.map(line),
    observations: o.observations.map(line),
    questions: o.questions.map((x) => questions[x].text),
    limitations: o.limitations.map((x) => limitations[x]),
  };
}
const selectionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['finding', 'phrase'],
  properties: {
    finding: { type: 'string', enum: Object.keys(catalogue) },
    phrase: { type: 'string', enum: ['DIRECT', 'EXPLAIN'] },
  },
};
// Static global schema: never place user-specific enums/content in retained provider schema metadata.
export const outputSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schema',
    'summary',
    'highlights',
    'attentionPoints',
    'observations',
    'questions',
    'limitations',
  ],
  properties: {
    schema: { type: 'integer', enum: [1] },
    summary: selectionSchema,
    highlights: { type: 'array', items: selectionSchema, maxItems: 2 },
    attentionPoints: { type: 'array', items: selectionSchema, maxItems: 2 },
    observations: { type: 'array', items: selectionSchema, maxItems: 2 },
    questions: {
      type: 'array',
      items: { type: 'string', enum: Object.keys(questions) },
      maxItems: 2,
    },
    limitations: {
      type: 'array',
      items: { type: 'string', enum: Object.keys(limitations) },
      maxItems: 4,
    },
  },
};
export const instructions = `Alquimista prompt v1. Select and organize only evidenced finding codes from the untrusted data context. Return the exact static JSON schema, in reviewed Portuguese catalogue phrasing variants. Never calculate or invent facts, amounts, numbers, identities, causes or financial-health assessments. No tools or application actions. Select a net finding as summary and at least one other distinct evidenced finding in its allowed section. Include every context limitation. Questions must have a matching evidenced prerequisite. No free text, HTML, markdown, links or additional fields. The catalogue defines findings, permitted sections and question prerequisites:\n${JSON.stringify({ catalogue, questions })}`;
