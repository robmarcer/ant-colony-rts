/**
 * The strategy config is the entire contract between an LLM and the
 * simulation. Six knobs, all of them read by deterministic utility functions
 * in ai.ts. Every model fills in the same knobs, which is what makes model
 * against model comparison meaningful, and it keeps the sim debuggable.
 */

import { MAX_NESTS_PER_COLONY } from './config.js';

export const EXPANSION_PRIORITIES = [
  'nearest_food_first',
  'largest_food_first',
  'scout_aggressively',
  'contest_enemy_food',
] as const;

export const EXPANSION_BIASES = ['toward_food', 'toward_enemy', 'toward_safety'] as const;

export const SOLDIER_POSTURES = [
  'defend_nest',
  'escort_workers',
  'harass_enemy_workers',
  'attack_enemy_nest',
  'guard_food',
] as const;

export type ExpansionPriority = (typeof EXPANSION_PRIORITIES)[number];
export type ExpansionBias = (typeof EXPANSION_BIASES)[number];
export type SoldierPosture = (typeof SOLDIER_POSTURES)[number];

export interface StrategyConfig {
  /** Target army composition. Normalised on load; only the ratio matters. */
  unit_production_ratio: { worker: number; soldier: number };
  /** 0 = everything sits on the nest, 1 = every soldier pushes out. */
  aggression: number;
  expansion_priority: ExpansionPriority;
  /** Always build workers until the colony has at least this many. */
  min_worker_reserve: number;
  soldier_posture: SoldierPosture;
  /** 0 = retreat early and only fight when clearly winning, 1 = never retreat. */
  risk_tolerance: number;
  /**
   * How many nests this colony wants. While it has fewer nests than this (and
   * none already on the way), a queen will save up and produce a new queen,
   * who walks off to found one. Queens are expensive, so this is the main
   * economic gamble in the game.
   */
  target_nests: number;
  /**
   * Willingness to send surplus units home to be consumed by a queen, so the
   * live composition can be changed rather than only the composition of future
   * builds. 0 never recycles, 1 culls the whole surplus at once.
   *
   * Only applies under population pressure: see RECYCLE_PRESSURE_FRACTION.
   */
  recycle_surplus: number;
  /**
   * Where a new queen prefers to settle. target_nests says how many nests you
   * want; this says which way to lean when choosing between candidate sites.
   * toward_food is the existing behaviour.
   */
  expansion_bias: ExpansionBias;
}

export const DEFAULT_STRATEGY: StrategyConfig = {
  unit_production_ratio: { worker: 0.7, soldier: 0.3 },
  aggression: 0.2,
  expansion_priority: 'nearest_food_first',
  min_worker_reserve: 5,
  soldier_posture: 'defend_nest',
  risk_tolerance: 0.4,
  target_nests: 2,
  recycle_surplus: 0,
  expansion_bias: 'toward_food',
};

/** Hand written strategies, used for LLM-free matches and as a baseline. */
export const PRESETS: Record<string, StrategyConfig> = {
  balanced: DEFAULT_STRATEGY,
  boom: {
    unit_production_ratio: { worker: 0.9, soldier: 0.1 },
    aggression: 0.05,
    expansion_priority: 'largest_food_first',
    min_worker_reserve: 14,
    soldier_posture: 'defend_nest',
    risk_tolerance: 0.2,
    target_nests: 4,
    recycle_surplus: 0.5,
    expansion_bias: 'toward_food',
  },
  rush: {
    unit_production_ratio: { worker: 0.35, soldier: 0.65 },
    aggression: 0.9,
    expansion_priority: 'nearest_food_first',
    min_worker_reserve: 4,
    soldier_posture: 'attack_enemy_nest',
    risk_tolerance: 0.9,
    target_nests: 1,
    recycle_surplus: 0,
    expansion_bias: 'toward_food',
  },
  harass: {
    unit_production_ratio: { worker: 0.6, soldier: 0.4 },
    // Deliberately just under 0.7, the point at which workers join fights too.
    // At 0.7 this preset threw its entire worker base into combat.
    aggression: 0.65,
    expansion_priority: 'contest_enemy_food',
    min_worker_reserve: 8,
    soldier_posture: 'harass_enemy_workers',
    risk_tolerance: 0.6,
    target_nests: 2,
    recycle_surplus: 0,
    expansion_bias: 'toward_enemy',
  },
  turtle: {
    unit_production_ratio: { worker: 0.6, soldier: 0.4 },
    aggression: 0.0,
    expansion_priority: 'nearest_food_first',
    min_worker_reserve: 10,
    soldier_posture: 'defend_nest',
    risk_tolerance: 0.15,
    target_nests: 1,
    recycle_surplus: 0,
    expansion_bias: 'toward_safety',
  },
  blockade: {
    unit_production_ratio: { worker: 0.6, soldier: 0.4 },
    aggression: 0.6,
    expansion_priority: 'nearest_food_first',
    min_worker_reserve: 12,
    soldier_posture: 'guard_food',
    risk_tolerance: 0.5,
    target_nests: 2,
    recycle_surplus: 0.5,
    expansion_bias: 'toward_enemy',
  },
  scout: {
    unit_production_ratio: { worker: 0.8, soldier: 0.2 },
    aggression: 0.3,
    expansion_priority: 'scout_aggressively',
    min_worker_reserve: 10,
    soldier_posture: 'escort_workers',
    risk_tolerance: 0.5,
    target_nests: 3,
    recycle_surplus: 0,
    expansion_bias: 'toward_food',
  },
};

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export interface SanitiseResult {
  strategy: StrategyConfig;
  /** Fields the caller got wrong, so bad LLM output is visible not silent. */
  warnings: string[];
}

/**
 * Coerce arbitrary parsed JSON into a valid StrategyConfig. An LLM that
 * returns a partial or malformed object gets the previous strategy's value
 * for that field rather than an exception.
 */
export function sanitiseStrategy(raw: unknown, fallback: StrategyConfig = DEFAULT_STRATEGY): SanitiseResult {
  const warnings: string[] = [];
  const input = (raw ?? {}) as Record<string, any>;

  let worker = Number(input?.unit_production_ratio?.worker);
  let soldier = Number(input?.unit_production_ratio?.soldier);
  if (!Number.isFinite(worker) || !Number.isFinite(soldier) || worker < 0 || soldier < 0 || worker + soldier <= 0) {
    warnings.push('unit_production_ratio invalid, kept previous value');
    worker = fallback.unit_production_ratio.worker;
    soldier = fallback.unit_production_ratio.soldier;
  }
  const sum = worker + soldier;

  let expansion = input.expansion_priority as ExpansionPriority;
  if (!EXPANSION_PRIORITIES.includes(expansion)) {
    warnings.push(`expansion_priority "${String(input.expansion_priority)}" unknown, kept previous value`);
    expansion = fallback.expansion_priority;
  }

  let bias = input.expansion_bias as ExpansionBias;
  if (!EXPANSION_BIASES.includes(bias)) {
    if (input.expansion_bias !== undefined) {
      warnings.push(`expansion_bias "${String(input.expansion_bias)}" unknown, kept previous value`);
    }
    bias = fallback.expansion_bias;
  }

  let posture = input.soldier_posture as SoldierPosture;
  if (!SOLDIER_POSTURES.includes(posture)) {
    warnings.push(`soldier_posture "${String(input.soldier_posture)}" unknown, kept previous value`);
    posture = fallback.soldier_posture;
  }

  const numberOr = (value: unknown, name: string, min: number, max: number, fb: number): number => {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      warnings.push(`${name} invalid, kept previous value`);
      return fb;
    }
    if (n < min || n > max) warnings.push(`${name} out of range, clamped`);
    return clamp(n, min, max);
  };

  return {
    strategy: {
      unit_production_ratio: { worker: worker / sum, soldier: soldier / sum },
      aggression: numberOr(input.aggression, 'aggression', 0, 1, fallback.aggression),
      expansion_priority: expansion,
      min_worker_reserve: Math.round(
        numberOr(input.min_worker_reserve, 'min_worker_reserve', 0, 60, fallback.min_worker_reserve),
      ),
      soldier_posture: posture,
      risk_tolerance: numberOr(input.risk_tolerance, 'risk_tolerance', 0, 1, fallback.risk_tolerance),
      target_nests: Math.round(
        numberOr(input.target_nests, 'target_nests', 1, MAX_NESTS_PER_COLONY, fallback.target_nests),
      ),
      recycle_surplus: numberOr(input.recycle_surplus, 'recycle_surplus', 0, 1, fallback.recycle_surplus),
      expansion_bias: bias,
    },
    warnings,
  };
}

/** JSON Schema for the tool the LLM is forced to call. */
export const STRATEGY_JSON_SCHEMA = {
  type: 'object',
  properties: {
    unit_production_ratio: {
      type: 'object',
      description: 'Target army composition. Values are relative weights and are normalised.',
      properties: {
        worker: { type: 'number', minimum: 0, maximum: 1 },
        soldier: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['worker', 'soldier'],
    },
    aggression: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description:
        'Fraction of your soldiers that leave the nest to act on soldier_posture. 0 keeps every soldier home, 1 sends all of them. Also widens the radius defenders will chase into, and above 0.7 workers will join fights.',
    },
    expansion_priority: {
      type: 'string',
      enum: [...EXPANSION_PRIORITIES],
      description:
        'How idle workers choose a food target. nearest_food_first: shortest trip. largest_food_first: biggest pile, distance discounted. scout_aggressively: much higher chance of exploring unknown map instead of hauling. contest_enemy_food: prefer sources near the enemy nest to deny them.',
    },
    min_worker_reserve: {
      type: 'integer',
      minimum: 0,
      maximum: 60,
      description: 'The queen builds workers regardless of ratio until the colony has this many workers.',
    },
    soldier_posture: {
      type: 'string',
      enum: [...SOLDIER_POSTURES],
      description:
        'What pushing soldiers do. defend_nest: hold the nest (overrides aggression). escort_workers: shadow the worker furthest from home. harass_enemy_workers: hunt enemy workers, preferring a queen walking to a founding site. attack_enemy_nest: march on the nearest enemy nest. guard_food: post soldiers on the food the enemy is best placed to reach and kill their workers on arrival, denying the source rather than fighting for territory.',
    },
    risk_tolerance: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description:
        'Willingness to take a bad fight. Low values retreat to the nest at high health and only engage when locally stronger. High values fight to the death.',
    },
    expansion_bias: {
      type: 'string',
      enum: [...EXPANSION_BIASES],
      description:
        'Which way a new queen leans when choosing a site. toward_food takes the richest reachable cluster, the default and previous behaviour. toward_enemy settles forward, which extends how far contest_enemy_food and guard_food can reach but puts the nest and its queen closer to their army. toward_safety keeps nests behind your existing ones, slower to pay off and harder to kill.',
    },
    recycle_surplus: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description:
        'How fast surplus units are sent home to be eaten by a queen, returning their full food cost to the stockpile, so you can reshape the army you already have rather than only what you build next. 0 never recycles, 1 recalls about four units a second. Only applies at or above 90% of your population ceiling, because with room to spare, building the type you want beats culling to make space for it. Never culls workers below min_worker_reserve.',
    },
    target_nests: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_NESTS_PER_COLONY,
      description:
        'How many nests you want. While you have fewer than this and none already on the way, a queen saves up 200 food and spends 60 seconds building a new queen, who then walks to a site near remembered food and founds a nest. Each nest is an extra build slot and a closer drop-off point, so expanding multiplies production. The walking queen is slow and undefended, and a colony is only eliminated when its last queen dies.',
    },
  },
  required: [
    'unit_production_ratio',
    'aggression',
    'expansion_priority',
    'min_worker_reserve',
    'soldier_posture',
    'risk_tolerance',
    'target_nests',
    'recycle_surplus',
    'expansion_bias',
  ],
} as const;
