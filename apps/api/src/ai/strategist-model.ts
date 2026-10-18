import { object } from '../identity/validation';
import { AiFailure } from './model';
export const STRATEGY_CONFIG = 'openai-responses-strategist-v1';
export const strategyCatalogue = {
  RESERVE_EMPTY: {
    text: 'A reserva escolhida ainda não tem recursos realizados positivos.',
    ref: 'reserve.settled',
  },
  RESERVE_IMPROVING: {
    text: 'As entradas realizadas superaram as saídas na conta escolhida nos últimos sete dias UTC completos.',
    ref: 'reserve.accountMovement',
  },
  RESERVE_DECLINING: {
    text: 'As saídas realizadas superaram as entradas na conta escolhida nos últimos sete dias UTC completos.',
    ref: 'reserve.accountMovement',
  },
  PENDING_OUTGOING: {
    text: 'Há saídas pendentes no horizonte escolhido; elas ainda não comprovam pagamento.',
    ref: 'planning.outgoing',
  },
  OBLIGATIONS_EXCEED_SETTLED: {
    text: 'As saídas pendentes observadas superam os recursos realizados desta conta.',
    ref: 'planning.outgoingVsSettled',
  },
  PENDING_INCOMING: {
    text: 'As entradas previstas permanecem separadas dos recursos recebidos.',
    ref: 'planning.incoming',
  },
  GOAL_DEFICIT: {
    text: 'A meta escolhida ainda tem valor a alcançar com recursos realizados.',
    ref: 'goal.remaining',
  },
  WORK_UNKNOWN: {
    text: 'O perfil de trabalho ainda não oferece uma capacidade declarada conhecida.',
    ref: 'work.capacity',
  },
  CAPACITY_LOW: {
    text: 'A capacidade bruta declarada neste horizonte é menor que o déficit da meta; isso não define um prazo nem garante renda.',
    ref: 'work.capacityVsDeficit',
  },
  CALCULATION_STALE: {
    text: 'O cálculo de renda registrado não corresponde às fontes atuais.',
    ref: 'goal.calculation',
  },
  PRIORITIES_CONFLICT: {
    text: 'Há uma meta a alcançar e saídas pendentes; escolher um foco exige considerar ambos.',
    ref: 'goal.remainingAndPending',
  },
} as const;
export type Signal = keyof typeof strategyCatalogue;
export const strategyLimits = {
  SCOPE:
    'Esta leitura considera somente o foco escolhido, não todas as suas finanças.',
  BASELINE_UNKNOWN:
    'Sem uma base declarada de despesas recorrentes, cobertura e alvo ideal de reserva são desconhecidos.',
  PLANNED:
    'Previsão não é recebimento nem pagamento; a missão usa evidência realizada.',
  CAPACITY:
    'Capacidade declarada não é renda garantida nem alocação exclusiva de trabalho.',
  DECISION:
    'Sugestão de apoio à decisão, sem garantia de resultado; você decide se deseja adotar.',
} as const;
export type StrategyTemplate =
  'WORK_PROFILE' | 'GOAL_TARGET' | 'RESERVE_TARGET';
export interface StrategyContext {
  role: 'ESTRATEGISTA';
  locale: 'pt-BR';
  context_schema: 1;
  period: 'WEEK';
  findings: Signal[];
  limitations: (keyof typeof strategyLimits)[];
  templates: StrategyTemplate[];
}
export interface StrategyOutput {
  schema: 1;
  summary: Signal;
  focus: Signal;
  proposal: {
    template: StrategyTemplate;
    version: 1;
    rationale: Signal;
  } | null;
  limitations: (keyof typeof strategyLimits)[];
}
export interface StrategyFacts {
  day: string;
  financeCursor: number;
  work: {
    revision: number;
    currency: string | null;
    totalMinor: string | null;
  };
  game: {
    missions: {
      id: string;
      sourceId: string;
      revision: number;
      template: string;
      state: string;
    }[];
    awardSequence: number;
  };
  goal: null | {
    id: string;
    revision: number;
    status: string;
    accountId: string;
    accountRevision: number;
    accountState: string;
    currency: string;
    targetMinor: string;
    creditedMinor: string;
    balanceMinor: string;
    movementMinor: string | null;
    calculation: unknown;
    calculationStale: boolean;
    capacityInsufficient: boolean;
  };
  pending: null | {
    incomingMinor: string;
    outgoingMinor: string;
    references: unknown;
  };
  focus: 'GENERAL' | 'GOAL' | 'RESERVE';
}
function reject(): never {
  throw new AiFailure('INVALID_OUTPUT');
}
function code<T extends string>(x: unknown, allowed: readonly T[]): T {
  if (typeof x !== 'string' || !allowed.includes(x as T)) return reject();
  return x as T;
}
export function strategyContext(raw: unknown): StrategyContext {
  const b = object(raw, [
    'role',
    'locale',
    'context_schema',
    'period',
    'findings',
    'limitations',
    'templates',
  ]);
  if (
    b['role'] !== 'ESTRATEGISTA' ||
    b['locale'] !== 'pt-BR' ||
    b['context_schema'] !== 1 ||
    b['period'] !== 'WEEK'
  )
    return reject();
  function list<T extends string>(
    v: unknown,
    allowed: readonly T[],
    max: number,
  ) {
    if (!Array.isArray(v) || v.length > max) return reject();
    const r = v.map((x) => code(x, allowed));
    if (new Set(r).size !== r.length) return reject();
    return r;
  }
  const c: StrategyContext = {
    role: 'ESTRATEGISTA',
    locale: 'pt-BR',
    context_schema: 1,
    period: 'WEEK',
    findings: list(
      b['findings'],
      Object.keys(strategyCatalogue) as Signal[],
      8,
    ),
    limitations: list(
      b['limitations'],
      Object.keys(strategyLimits) as (keyof typeof strategyLimits)[],
      5,
    ),
    templates: list(
      b['templates'],
      ['WORK_PROFILE', 'GOAL_TARGET', 'RESERVE_TARGET'],
      2,
    ),
  };
  if (
    c.findings.length < 2 ||
    c.limitations.length !== 5 ||
    Buffer.byteLength(JSON.stringify(c)) > 2048
  )
    return reject();
  return c;
}
export function strategyMinimize(f: StrategyFacts): StrategyContext | null {
  const findings: Signal[] = [],
    templates: StrategyTemplate[] = [],
    g = f.goal;
  if (g && f.focus === 'RESERVE') {
    if (BigInt(g.balanceMinor) <= 0n) findings.push('RESERVE_EMPTY');
    if (g.movementMinor !== null && BigInt(g.movementMinor) !== 0n)
      findings.push(
        BigInt(g.movementMinor) > 0n
          ? 'RESERVE_IMPROVING'
          : 'RESERVE_DECLINING',
      );
  }
  const deficit =
    g && g.status === 'ACTIVE' && g.accountState === 'active'
      ? BigInt(g.targetMinor) - BigInt(g.creditedMinor)
      : 0n;
  if (deficit > 0n) findings.push('GOAL_DEFICIT');
  const outgoing = BigInt(f.pending?.outgoingMinor ?? '0'),
    incoming = BigInt(f.pending?.incomingMinor ?? '0');
  if (outgoing > 0n) {
    findings.push('PENDING_OUTGOING');
    if (g && outgoing > BigInt(g.balanceMinor))
      findings.push('OBLIGATIONS_EXCEED_SETTLED');
  }
  if (incoming > 0n) findings.push('PENDING_INCOMING');
  if (!f.work.revision || f.work.totalMinor === null)
    findings.push('WORK_UNKNOWN');
  else if (g?.capacityInsufficient && !g.calculationStale)
    findings.push('CAPACITY_LOW');
  if (g?.calculationStale) findings.push('CALCULATION_STALE');
  if (deficit > 0n && outgoing > 0n) findings.push('PRIORITIES_CONFLICT');
  if (!f.work.revision && !f.game.missions.some((m) => m.sourceId !== g?.id))
    templates.push('WORK_PROFILE');
  if (g && deficit > 0n && !f.game.missions.some((m) => m.sourceId === g.id))
    templates.push(f.focus === 'RESERVE' ? 'RESERVE_TARGET' : 'GOAL_TARGET');
  // Require two independent fact families; no action/only future incoming never creates an issue.
  const families =
    Number(!!g && deficit > 0n) +
    Number(outgoing > 0n) +
    Number(f.work.revision === 0 || f.work.totalMinor !== null);
  if (
    families < 2 ||
    findings.length < 2 ||
    (!templates.length &&
      outgoing === 0n &&
      !(
        g &&
        f.focus === 'RESERVE' &&
        g.movementMinor !== null &&
        BigInt(g.movementMinor) < 0n
      ))
  )
    return null;
  return strategyContext({
    role: 'ESTRATEGISTA',
    locale: 'pt-BR',
    context_schema: 1,
    period: 'WEEK',
    findings: findings.slice(0, 8),
    limitations: Object.keys(strategyLimits),
    templates,
  });
}
export function strategyOutput(
  raw: unknown,
  c: StrategyContext | null,
): StrategyOutput {
  try {
    const b = object(raw, [
      'schema',
      'summary',
      'focus',
      'proposal',
      'limitations',
    ]);
    if (b['schema'] !== 1) return reject();
    const pick = (x: unknown) => {
      const v = code(x, Object.keys(strategyCatalogue) as Signal[]);
      if (c && !c.findings.includes(v)) return reject();
      return v;
    };
    const summary = pick(b['summary']),
      focus = pick(b['focus']);
    let proposal: StrategyOutput['proposal'] = null;
    if (b['proposal'] !== null) {
      const p = object(b['proposal'], ['template', 'version', 'rationale']);
      const t = code(p['template'], [
          'WORK_PROFILE',
          'GOAL_TARGET',
          'RESERVE_TARGET',
        ] as const),
        rationale = pick(p['rationale']);
      if (p['version'] !== 1 || (c && !c.templates.includes(t)))
        return reject();
      if (
        t === 'WORK_PROFILE'
          ? rationale !== 'WORK_UNKNOWN'
          : !['GOAL_DEFICIT', 'RESERVE_EMPTY', 'RESERVE_DECLINING'].includes(
              rationale,
            )
      )
        return reject();
      proposal = { template: t, version: 1, rationale };
    }
    if (!Array.isArray(b['limitations'])) return reject();
    const limits = b['limitations'].map((x) =>
      code(x, Object.keys(strategyLimits) as (keyof typeof strategyLimits)[]),
    );
    if (new Set(limits).size !== 5 || limits.length !== 5) return reject();
    return { schema: 1, summary, focus, proposal, limitations: limits };
  } catch {
    return reject();
  }
}
export function strategyRender(v: StrategyOutput) {
  const line = (s: Signal) => ({
    text: strategyCatalogue[s].text,
    metricRefs: [strategyCatalogue[s].ref],
  });
  return {
    schema: 1,
    kind: 'AI_STRATEGY',
    method: 'MODEL_SELECTED_REVIEWED_TEXT',
    summary: line(v.summary),
    focus: line(v.focus),
    proposal: v.proposal
      ? {
          template: v.proposal.template,
          version: 1,
          rationale: line(v.proposal.rationale),
        }
      : null,
    limitations: v.limitations.map((x) => strategyLimits[x]),
  };
}
const signalSchema = { type: 'string', enum: Object.keys(strategyCatalogue) };
export const strategySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schema', 'summary', 'focus', 'proposal', 'limitations'],
  properties: {
    schema: { type: 'integer', enum: [1] },
    summary: signalSchema,
    focus: signalSchema,
    proposal: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['template', 'version', 'rationale'],
          properties: {
            template: {
              type: 'string',
              enum: ['WORK_PROFILE', 'GOAL_TARGET', 'RESERVE_TARGET'],
            },
            version: { type: 'integer', enum: [1] },
            rationale: signalSchema,
          },
        },
      ],
    },
    limitations: {
      type: 'array',
      items: { type: 'string', enum: Object.keys(strategyLimits) },
      minItems: 5,
      maxItems: 5,
    },
  },
};
export const strategyInstructions = `Estrategista prompt v1. Select only evidenced findings from the untrusted enum context, and optionally one currently allowed version-1 mission template. Never calculate or invent amounts, urgency, causes, personal behavior, certainty, coverage, investment advice, financial actions, reward/XP or completion rules. No tools. No free text. User decides adoption; backend validates. WORK_PROFILE rationale must be WORK_UNKNOWN; goal/reserve rationale must be GOAL_DEFICIT, RESERVE_EMPTY or RESERVE_DECLINING. Return strict schema with all limitations. Reviewed catalogue: ${JSON.stringify(strategyCatalogue)}`;
