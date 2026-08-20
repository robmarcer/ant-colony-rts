import { NEST_RADIUS, UNIT_STATS } from './config.js';
import { isAnyOf } from './definition.js';
import type { BehaviourDefinition, RuleClause, RuleCondition, RuleMetric } from './definition.js';
import type { StrategyConfig } from './strategy.js';
import type { ColonyId } from './types.js';
import type { Simulation } from './sim.js';

export type Metrics = Record<RuleMetric, number>;

/** Everything a rule can test, computed from one colony's point of view. */
export function computeMetrics(sim: Simulation, colonyId: ColonyId): Metrics {
  const colony = sim.colonies[colonyId];
  const enemy = sim.enemyColony(colonyId);

  let knownFoodAmount = 0;
  for (const known of colony.knownFood.values()) knownFoodAmount += Math.max(0, known.estAmount);

  // "Near a nest" means near any of that colony's nests, so these metrics keep
  // working the same way for a colony that has expanded.
  const nearRadius = NEST_RADIUS + 8;
  let enemiesNearMyNest = 0;
  for (const unit of sim.enemiesOf(colonyId)) {
    if (unit.type === 'queen') continue;
    if (sim.distanceToNearestNest(colonyId, unit) <= nearRadius) enemiesNearMyNest++;
  }
  let myUnitsNearEnemyNest = 0;
  for (const unit of sim.unitsOf(colonyId)) {
    if (unit.type === 'queen') continue;
    if (sim.distanceToNearestNest(enemy.id, unit) <= nearRadius) myUnitsNearEnemyNest++;
  }

  const myWorkers = sim.countUnits(colonyId, 'worker');
  const mySoldiers = sim.countUnits(colonyId, 'soldier');
  const enemyWorkers = sim.countUnits(enemy.id, 'worker');
  const enemySoldiers = sim.countUnits(enemy.id, 'soldier');
  const lost = colony.unitsLost;

  return {
    sim_seconds: sim.simSeconds,
    food_stockpile: colony.food,
    lifetime_food: colony.lifetimeFoodGathered,
    my_workers: myWorkers,
    my_soldiers: mySoldiers,
    my_units: myWorkers + mySoldiers,
    enemy_workers: enemyWorkers,
    enemy_soldiers: enemySoldiers,
    enemy_units: enemyWorkers + enemySoldiers,
    soldier_advantage: mySoldiers - enemySoldiers,
    my_nests: colony.nests.length,
    enemy_nests: enemy.nests.length,
    my_queens: sim.queensOf(colonyId).length,
    enemy_queens: sim.queensOf(enemy.id).length,
    my_founding_queens: sim.foundingQueensOf(colonyId).length,
    enemy_founding_queens: sim.foundingQueensOf(enemy.id).length,
    my_queen_hp_pct: sim.lowestQueenHealth(colonyId) * 100,
    enemy_queen_hp_pct: sim.lowestQueenHealth(enemy.id) * 100,
    known_food_sources: colony.knownFood.size,
    known_food_amount: knownFoodAmount,
    units_lost_total: lost.worker + lost.soldier,
    units_lost_recent: colony.recentLosses,
    kills: colony.kills,
    enemies_near_my_nest: enemiesNearMyNest,
    my_units_near_enemy_nest: myUnitsNearEnemyNest,
  };
}

function conditionHolds(condition: RuleCondition, metrics: Metrics): boolean {
  const actual = metrics[condition.metric];
  // Against another metric when given one, otherwise against the constant.
  const target = condition.metric2 !== undefined ? metrics[condition.metric2] : (condition.value ?? 0);
  switch (condition.op) {
    case 'gt':
      return actual > target;
    case 'gte':
      return actual >= target;
    case 'lt':
      return actual < target;
    case 'lte':
      return actual <= target;
    case 'eq':
      return actual === target;
  }
}

function clauseHolds(clause: RuleClause, metrics: Metrics): boolean {
  if (isAnyOf(clause)) return clause.any_of.some((condition) => conditionHolds(condition, metrics));
  return conditionHolds(clause, metrics);
}

export interface RuleEvaluation {
  strategy: StrategyConfig;
  activeRuleIds: string[];
}

/**
 * Apply every matching rule on top of base, in list order, later wins.
 * Deliberately not first-match-wins: layering lets a definition express
 * "always do X after 3 minutes" and "but if the nest is being hit, do Y".
 *
 * `held` are rules whose conditions no longer hold but whose min_hold_seconds
 * has not expired. They stay in the layering in their original list position,
 * so a hold cannot change the precedence a definition was written to rely on.
 */
export function evaluateRules(
  definition: BehaviourDefinition,
  metrics: Metrics,
  held: ReadonlySet<string> = new Set(),
): RuleEvaluation {
  let strategy: StrategyConfig = { ...definition.base };
  const activeRuleIds: string[] = [];

  definition.rules.forEach((rule, index) => {
    const id = rule.id ?? `rule_${index}`;
    const matches = rule.when.every((clause) => clauseHolds(clause, metrics));
    if (!matches && !held.has(id)) return;
    activeRuleIds.push(id);
    strategy = { ...strategy, ...rule.set };
  });

  return { strategy, activeRuleIds };
}

/** Used by the HUD and the match log to describe a knob set in one line. */
export function describeStrategy(strategy: StrategyConfig): string {
  const ratio = `${strategy.unit_production_ratio.worker.toFixed(2)}w/${strategy.unit_production_ratio.soldier.toFixed(2)}s`;
  return [
    ratio,
    `aggr ${strategy.aggression.toFixed(2)}`,
    strategy.expansion_priority,
    strategy.soldier_posture,
    `reserve ${strategy.min_worker_reserve}`,
    `risk ${strategy.risk_tolerance.toFixed(2)}`,
    `nests ${strategy.target_nests}`,
  ].join(' | ');
}

export { UNIT_STATS };
