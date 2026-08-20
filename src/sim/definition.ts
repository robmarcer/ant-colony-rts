/**
 * A behaviour definition is the complete, self-contained brain of one colony.
 *
 * An LLM writes one of these before a match and then has no further contact
 * with the running game. To let a static file still behave reactively, a
 * definition is a set of base knobs plus an ordered list of conditional rules.
 * Rules are re-evaluated inside the simulation on a fixed interval, so the
 * match stays deterministic and reproducible from (definitionA, definitionB,
 * seed) alone.
 *
 * Rules are declarative data, never code. Nothing here is evaluated as JS.
 */
import {
  DEFAULT_STRATEGY,
  EXPANSION_PRIORITIES,
  SOLDIER_POSTURES,
  sanitiseStrategy,
  type StrategyConfig,
} from './strategy.js';

/** How often the rule list is re-evaluated, in sim seconds. */
export const RULE_EVAL_INTERVAL_SECONDS = 1;

/** Everything a rule is allowed to look at, all from the owning colony's view. */
export const RULE_METRICS = [
  'sim_seconds',
  'food_stockpile',
  'lifetime_food',
  'my_workers',
  'my_soldiers',
  'my_units',
  'enemy_workers',
  'enemy_soldiers',
  'enemy_units',
  'soldier_advantage',
  'my_nests',
  'enemy_nests',
  'my_queens',
  'enemy_queens',
  /** Queens currently walking to a site, i.e. expansions in flight. */
  'my_founding_queens',
  'enemy_founding_queens',
  /** Lowest health percentage among your own queens, 0 if you have none. */
  'my_queen_hp_pct',
  'enemy_queen_hp_pct',
  'known_food_sources',
  'known_food_amount',
  'units_lost_total',
  'units_lost_recent',
  'kills',
  'enemies_near_my_nest',
  'my_units_near_enemy_nest',
] as const;

export type RuleMetric = (typeof RULE_METRICS)[number];

export const RULE_OPS = ['gt', 'gte', 'lt', 'lte', 'eq'] as const;
export type RuleOp = (typeof RULE_OPS)[number];

export interface RuleCondition {
  metric: RuleMetric;
  op: RuleOp;
  value: number;
}

export interface BehaviourRule {
  /** Optional stable id so match logs are readable. Defaults to rule_<index>. */
  id?: string;
  /** Free text, carried into the match log. Say why the rule exists. */
  note?: string;
  /** All conditions must hold. For an OR, write two rules. */
  when: RuleCondition[];
  /** Any subset of the knobs. Later matching rules win. */
  set: Partial<StrategyConfig>;
  /**
   * Once this rule fires, keep it active for at least this many sim seconds even
   * if its condition stops holding. Without it, a rule sitting on a threshold
   * the match keeps crossing will switch on and off repeatedly, and a colony
   * that keeps committing and recalling its army achieves nothing. 0 or absent
   * means no hold, which is the old behaviour.
   */
  min_hold_seconds?: number;
}

export interface BehaviourDefinition {
  /** Filename-safe id. The API derives it from the name if omitted. */
  id: string;
  name: string;
  /** Who or what wrote it, e.g. "claude-opus-5" or "hand". */
  author?: string;
  /** Bump this yourself when you revise, purely informational. */
  version?: number;
  /** Free text. Use it to record the plan and what the last match taught you. */
  notes?: string;
  base: StrategyConfig;
  rules: BehaviourRule[];
  /** Set by the API on write. Not used by the simulation. */
  updatedAt?: string;
}

export interface ValidationIssue {
  path: string;
  message: string;
  /** error means the value was rejected and a fallback used, warning is cosmetic. */
  severity: 'error' | 'warning';
}

export interface ParsedDefinition {
  definition: BehaviourDefinition;
  issues: ValidationIssue[];
}

const KNOB_KEYS = new Set([
  'unit_production_ratio',
  'aggression',
  'expansion_priority',
  'min_worker_reserve',
  'soldier_posture',
  'risk_tolerance',
  'target_nests',
]);

export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'unnamed';
}

/**
 * Coerce arbitrary JSON into a usable definition, collecting every problem
 * rather than throwing on the first one. A definition an LLM wrote badly still
 * runs, and the issue list tells it exactly what was ignored.
 */
export function parseDefinition(raw: unknown, fallbackId = 'unnamed'): ParsedDefinition {
  const issues: ValidationIssue[] = [];
  const input = (raw ?? {}) as Record<string, any>;

  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : fallbackId;
  const id = slugify(typeof input.id === 'string' && input.id.trim() ? input.id : name);

  const baseResult = sanitiseStrategy(input.base, DEFAULT_STRATEGY);
  for (const warning of baseResult.warnings) {
    issues.push({ path: 'base', message: warning, severity: 'error' });
  }
  if (input.base === undefined) {
    issues.push({ path: 'base', message: 'no base knobs given, using defaults', severity: 'warning' });
  }

  const rules: BehaviourRule[] = [];
  const rawRules = Array.isArray(input.rules) ? input.rules : [];
  if (input.rules !== undefined && !Array.isArray(input.rules)) {
    issues.push({ path: 'rules', message: 'rules must be an array, ignored', severity: 'error' });
  }

  rawRules.forEach((rawRule: any, index: number) => {
    const path = `rules[${index}]`;
    const ruleId = typeof rawRule?.id === 'string' && rawRule.id.trim() ? rawRule.id.trim() : `rule_${index}`;

    const rawWhen = Array.isArray(rawRule?.when) ? rawRule.when : [];
    if (!Array.isArray(rawRule?.when)) {
      issues.push({ path: `${path}.when`, message: 'when must be an array of conditions, rule dropped', severity: 'error' });
      return;
    }
    const when: RuleCondition[] = [];
    let conditionsOk = true;
    rawWhen.forEach((rawCondition: any, ci: number) => {
      const cPath = `${path}.when[${ci}]`;
      if (!RULE_METRICS.includes(rawCondition?.metric)) {
        issues.push({
          path: `${cPath}.metric`,
          message: `unknown metric "${String(rawCondition?.metric)}", rule dropped`,
          severity: 'error',
        });
        conditionsOk = false;
        return;
      }
      if (!RULE_OPS.includes(rawCondition?.op)) {
        issues.push({
          path: `${cPath}.op`,
          message: `unknown op "${String(rawCondition?.op)}", rule dropped`,
          severity: 'error',
        });
        conditionsOk = false;
        return;
      }
      const value = Number(rawCondition?.value);
      if (!Number.isFinite(value)) {
        issues.push({ path: `${cPath}.value`, message: 'value must be a number, rule dropped', severity: 'error' });
        conditionsOk = false;
        return;
      }
      when.push({ metric: rawCondition.metric, op: rawCondition.op, value });
    });
    if (!conditionsOk) return;
    if (when.length === 0) {
      issues.push({ path: `${path}.when`, message: 'rule has no conditions, it would always fire, dropped', severity: 'error' });
      return;
    }

    const rawSet = (rawRule?.set ?? {}) as Record<string, any>;
    const set: Partial<StrategyConfig> = {};
    for (const key of Object.keys(rawSet)) {
      if (!KNOB_KEYS.has(key)) {
        issues.push({ path: `${path}.set.${key}`, message: 'not a knob, ignored', severity: 'error' });
      }
    }
    // Sanitise the overrides by merging onto the base and keeping only the
    // keys the rule actually mentioned.
    const merged = sanitiseStrategy({ ...baseResult.strategy, ...pickKnobs(rawSet) }, baseResult.strategy);
    for (const warning of merged.warnings) {
      issues.push({ path: `${path}.set`, message: warning, severity: 'error' });
    }
    for (const key of Object.keys(pickKnobs(rawSet)) as Array<keyof StrategyConfig>) {
      (set as any)[key] = merged.strategy[key];
    }
    if (Object.keys(set).length === 0) {
      issues.push({ path: `${path}.set`, message: 'rule sets nothing, dropped', severity: 'error' });
      return;
    }

    let hold: number | undefined;
    if (rawRule?.min_hold_seconds !== undefined) {
      const raw = Number(rawRule.min_hold_seconds);
      if (!Number.isFinite(raw) || raw < 0) {
        issues.push({ path: `${path}.min_hold_seconds`, message: 'must be a number of seconds >= 0, ignored', severity: 'error' });
      } else {
        if (raw > 3600) issues.push({ path: `${path}.min_hold_seconds`, message: 'over 3600, clamped', severity: 'error' });
        hold = Math.min(3600, Math.round(raw));
      }
    }

    rules.push({
      id: ruleId,
      note: typeof rawRule?.note === 'string' ? rawRule.note : undefined,
      when,
      set,
      min_hold_seconds: hold,
    });
  });

  if (rules.length > 40) {
    issues.push({ path: 'rules', message: 'more than 40 rules, extras dropped', severity: 'error' });
    rules.length = 40;
  }

  return {
    definition: {
      id,
      name,
      author: typeof input.author === 'string' ? input.author : undefined,
      version: Number.isFinite(Number(input.version)) ? Number(input.version) : 1,
      notes: typeof input.notes === 'string' ? input.notes : undefined,
      base: baseResult.strategy,
      rules,
      updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : undefined,
    },
    issues,
  };
}

function pickKnobs(raw: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const key of Object.keys(raw)) if (KNOB_KEYS.has(key)) out[key] = raw[key];
  return out;
}

/** Machine readable contract, served at GET /api/schema for whoever is authoring. */
export const DEFINITION_DOC = {
  knobs: {
    unit_production_ratio: 'object {worker, soldier}, relative weights, normalised',
    aggression: 'number 0..1',
    expansion_priority: EXPANSION_PRIORITIES,
    min_worker_reserve: 'integer 0..60',
    soldier_posture: SOLDIER_POSTURES,
    risk_tolerance: 'number 0..1',
    target_nests: 'integer 1..6',
  },
  rule_metrics: RULE_METRICS,
  rule_ops: RULE_OPS,
  rule_eval_interval_seconds: RULE_EVAL_INTERVAL_SECONDS,
  evaluation:
    'Every rule whose conditions all hold is applied in list order on top of base. Later rules override earlier ones. Nothing else changes the knobs during a match. A rule with min_hold_seconds stays active for at least that long after it first fires, even if its condition lapses.',
} as const;
