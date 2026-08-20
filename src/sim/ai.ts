/**
 * Deterministic unit AI. Every decision here reads the colony's currently
 * effective strategy knobs; no LLM is involved at any point during a match.
 *
 * If you change how a knob is interpreted, update docs/behaviour.md too, since
 * that is what an author reads before writing a definition.
 */
import {
  ARRIVE_EPSILON,
  CONTEST_MAX_HAUL,
  DT,
  GATHER_RADIUS,
  MAP_HEIGHT,
  MAP_WIDTH,
  MAX_NESTS_PER_COLONY,
  MIN_ENEMY_NEST_DISTANCE,
  MIN_NEST_SEPARATION,
  NEST_RADIUS,
  UNITS_PER_NEST,
  UNIT_STATS,
} from './config.js';
import type { StrategyConfig } from './strategy.js';
import type { Colony, Nest, Unit, UnitType, Vec } from './types.js';
import type { Simulation } from './sim.js';

export function runUnitAi(sim: Simulation, unit: Unit): void {
  switch (unit.type) {
    case 'queen':
      return queenAi(sim, unit);
    case 'worker':
      return workerAi(sim, unit);
    case 'soldier':
      return soldierAi(sim, unit);
  }
}

// ------------------------------------------------------------------ production

/**
 * Every settled queen has her own build slot and they all draw on the shared
 * colony stockpile. That is the payoff for expanding: a second nest doubles
 * production throughput as well as shortening hauling trips.
 *
 * Queens are processed in id order, so when two of them could afford the same
 * unit in the same tick the outcome is deterministic.
 */
export function runColonyProduction(sim: Simulation, colony: Colony): void {
  for (const queen of sim.queensOf(colony.id)) {
    // A queen walking to a founding site is not producing anything.
    if (queen.foundingSite !== null) continue;
    runQueenProduction(sim, colony, queen);
  }
}

function runQueenProduction(sim: Simulation, colony: Colony, queen: Unit): void {
  const nest = colony.nests.find((candidate) => candidate.queenId === queen.id);
  if (!nest) return;

  if (queen.build) {
    queen.build.secondsRemaining -= DT;
    if (queen.build.secondsRemaining <= 0) {
      const type = queen.build.type;
      const spawned = sim.spawnUnit(type, colony.id, sim.nestSpawnPoint(nest));
      colony.unitsProduced[type]++;
      queen.build = null;

      if (type === 'queen') {
        // A new queen leaves immediately for a site of her own.
        spawned.foundingSite = chooseFoundingSite(sim, colony, nest);
        spawned.state = 'founding';
        sim.pushEvent(
          'queen_walking',
          colony.id,
          `${colony.name} queen setting out for ${spawned.foundingSite.x.toFixed(0)}, ${spawned.foundingSite.y.toFixed(0)}`,
          true,
        );
      }
    }
    return;
  }

  const want = chooseNextUnit(sim, colony);
  if (want === null) return; // at population capacity and not expanding
  const cost = UNIT_STATS[want].cost;
  if (colony.food < cost) return; // save up rather than build off-plan
  colony.food -= cost;
  queen.build = {
    type: want,
    secondsRemaining: UNIT_STATS[want].buildTime,
    totalSeconds: UNIT_STATS[want].buildTime,
  };
}

/**
 * min_worker_reserve is a hard floor, checked first. Then expansion, but only
 * out of genuine surplus: a queen costs 200 food, and demanding that the
 * stockpile already covers it means a colony never freezes its whole economy
 * saving up. Above that, the queen builds whichever type moves the live army
 * composition toward unit_production_ratio.
 */
function chooseNextUnit(sim: Simulation, colony: Colony): UnitType | null {
  const strategy = colony.strategy;
  const workers = sim.countUnits(colony.id, 'worker');
  const soldiers = sim.countUnits(colony.id, 'soldier');
  const total = workers + soldiers;

  // Expansion is always allowed to proceed, even at capacity, because founding
  // a nest is the only way to raise the ceiling.
  const wantsQueen = colony.food >= UNIT_STATS.queen.cost && wantsAnotherNest(sim, colony);
  const atCapacity = total >= colony.nests.length * UNITS_PER_NEST;
  if (atCapacity) return wantsQueen ? 'queen' : null;

  if (workers < strategy.min_worker_reserve) return 'worker';
  if (wantsQueen) return 'queen';

  if (total === 0) return strategy.unit_production_ratio.worker > 0 ? 'worker' : 'soldier';
  return workers / total < strategy.unit_production_ratio.worker ? 'worker' : 'soldier';
}

/** Counts nests that exist, are being walked to, and are being built. */
function wantsAnotherNest(sim: Simulation, colony: Colony): boolean {
  const target = Math.min(colony.strategy.target_nests, MAX_NESTS_PER_COLONY);
  const inFlight = sim.foundingQueensOf(colony.id).length;
  let underConstruction = 0;
  for (const queen of sim.queensOf(colony.id)) {
    if (queen.build?.type === 'queen') underConstruction++;
  }
  return colony.nests.length + inFlight + underConstruction < target;
}

/**
 * Where a new queen goes. Preference is a remembered food cluster that is far
 * enough from the colony's existing nests to open new ground, close enough to
 * the parent nest to be defensible, and not sitting on the enemy's doorstep.
 * risk_tolerance decides how much of that last consideration matters.
 */
function chooseFoundingSite(sim: Simulation, colony: Colony, parent: Nest): Vec {
  const strategy = colony.strategy;
  const enemy = sim.enemyColony(colony.id);

  const farEnoughFromOwn = (point: Vec): boolean =>
    colony.nests.every((nest) => Math.hypot(nest.x - point.x, nest.y - point.y) >= MIN_NEST_SEPARATION);
  const farEnoughFromEnemy = (point: Vec): boolean =>
    enemy.nests.every((nest) => Math.hypot(nest.x - point.x, nest.y - point.y) >= MIN_ENEMY_NEST_DISTANCE);
  const enemyDistance = (point: Vec): number => {
    let best = Infinity;
    for (const nest of enemy.nests) best = Math.min(best, Math.hypot(nest.x - point.x, nest.y - point.y));
    return best === Infinity ? MAP_WIDTH : best;
  };

  let best: Vec | null = null;
  let bestScore = -Infinity;

  for (const known of colony.knownFood.values()) {
    if (known.estAmount < 120) continue;
    // Settle beside the food rather than on top of it, on the side facing home.
    const toParent = { x: parent.x - known.x, y: parent.y - known.y };
    const length = Math.hypot(toParent.x, toParent.y) || 1;
    const site: Vec = {
      x: clamp(known.x + (toParent.x / length) * 5, 2, MAP_WIDTH - 2),
      y: clamp(known.y + (toParent.y / length) * 5, 2, MAP_HEIGHT - 2),
    };
    if (!farEnoughFromOwn(site) || !farEnoughFromEnemy(site)) continue;

    const fromParent = Math.hypot(site.x - parent.x, site.y - parent.y);
    const danger = Math.max(0, 60 - enemyDistance(site)) / 60;
    const score = 0.05 * known.estAmount - 0.5 * fromParent - danger * 60 * (1 - strategy.risk_tolerance);
    if (score > bestScore) {
      bestScore = score;
      best = site;
    }
  }
  if (best) return best;

  // Nothing suitable is known, so head away from the enemy and look around.
  const enemyHome = enemy.homeNest;
  const away = Math.atan2(parent.y - enemyHome.y, parent.x - enemyHome.x);
  const angle = away + sim.rng.range(-0.9, 0.9);
  const radius = MIN_NEST_SEPARATION + sim.rng.range(6, 24);
  return {
    x: clamp(parent.x + Math.cos(angle) * radius, 4, MAP_WIDTH - 4),
    y: clamp(parent.y + Math.sin(angle) * radius, 4, MAP_HEIGHT - 4),
  };
}

// ----------------------------------------------------------------------- queen

function queenAi(sim: Simulation, unit: Unit): void {
  const stats = UNIT_STATS.queen;

  if (unit.foundingSite !== null) {
    // Slow, undefended and carrying 200 food of investment. She fights only
    // what is already on top of her, and otherwise keeps walking.
    const contact = sim.nearestEnemy(unit, stats.attackRange);
    if (contact) {
      unit.targetEnemyId = contact.id;
      unit.state = 'fighting';
      return;
    }
    unit.targetEnemyId = null;
    unit.state = 'founding';
    if (moveToward(unit, unit.foundingSite, stats.speed)) sim.foundNest(unit);
    return;
  }

  const enemy = sim.nearestEnemy(unit, stats.attackRange);
  unit.targetEnemyId = enemy ? enemy.id : null;
  unit.state = enemy ? 'fighting' : 'idle';
}

// ---------------------------------------------------------------------- worker

function workerAi(sim: Simulation, unit: Unit): void {
  const colony = sim.colonies[unit.owner];
  const strategy = colony.strategy;
  const stats = UNIT_STATS.worker;
  const home = sim.nearestNest(unit.owner, unit);

  // With no nest left there is nowhere to haul to, so fight or forage on.
  if (!home) {
    const enemy = sim.nearestEnemy(unit, 6);
    if (enemy) return engage(sim, unit, enemy);
    unit.state = 'idle';
    return;
  }

  // Hurt workers run home and regenerate. risk_tolerance 1 never retreats.
  if (unit.hp < unit.maxHp * retreatThreshold(strategy) && !sim.atNest(unit)) {
    unit.state = 'retreating';
    unit.targetEnemyId = null;
    if (moveToward(unit, home, stats.speed)) {
      if (unit.carrying > 0) sim.depositFood(unit);
      unit.state = 'idle';
    }
    return;
  }
  if (unit.state === 'retreating') {
    // Sit in the nest until mostly healed, then go back to work.
    if (unit.hp < unit.maxHp * 0.9) return;
    unit.state = 'idle';
  }

  const threat = workerFightTarget(sim, unit, strategy);
  if (threat) return engage(sim, unit, threat);
  unit.targetEnemyId = null;

  if (unit.carrying >= stats.carryCapacity) unit.state = 'returning';

  if (unit.state === 'returning') {
    if (moveToward(unit, home, stats.speed) || sim.atNest(unit)) {
      sim.depositFood(unit);
      unit.state = 'idle';
      unit.targetFoodId = null;
    }
    return;
  }

  if (unit.targetFoodId !== null) {
    const source = sim.food.get(unit.targetFoodId);
    if (!source) {
      unit.targetFoodId = null;
      // Do not waste a part load: over half full, take it home.
      unit.state = unit.carrying > stats.carryCapacity * 0.5 ? 'returning' : 'idle';
      return;
    }
    if (Math.hypot(source.x - unit.x, source.y - unit.y) <= GATHER_RADIUS) {
      unit.state = 'gathering';
      const take = Math.min(stats.gatherRate * DT, stats.carryCapacity - unit.carrying, source.amount);
      source.amount -= take;
      unit.carrying += take;
      const known = colony.knownFood.get(source.id);
      if (known) known.estAmount = source.amount;
      if (source.amount <= 0) sim.removeFood(source, source.kind === 'cluster');
      if (unit.carrying >= stats.carryCapacity) unit.state = 'returning';
    } else {
      unit.state = 'moving';
      moveToward(unit, source, stats.speed);
    }
    return;
  }

  if (unit.state === 'scouting' && unit.moveTo) {
    if (moveToward(unit, unit.moveTo, stats.speed)) {
      unit.moveTo = null;
      unit.state = 'idle';
    } else {
      return;
    }
  }

  chooseWorkerJob(sim, unit, colony, strategy);
}

/**
 * Workers are poor fighters, so they only commit when it matters:
 * already in contact, defending a nest, avenging a hit, or ordered to swarm
 * by a very aggressive strategy.
 */
function workerFightTarget(sim: Simulation, unit: Unit, strategy: StrategyConfig): Unit | null {
  const enemy = sim.nearestEnemy(unit, 8);
  if (!enemy) return null;
  const d = Math.hypot(enemy.x - unit.x, enemy.y - unit.y);
  const enemyAtHome = sim.distanceToNearestNest(unit.owner, enemy) < NEST_RADIUS + 8;

  if (d <= UNIT_STATS.worker.attackRange + 0.4) return enemy;
  if (enemyAtHome) return enemy;
  if (strategy.aggression >= 0.7 && d < 5) return enemy;
  if (sim.tick - unit.lastDamagedTick < 20 && d < 4) return enemy;
  return null;
}

/** Pick a food source from colony memory, or go exploring. */
function chooseWorkerJob(sim: Simulation, unit: Unit, colony: Colony, strategy: StrategyConfig): void {
  const known = [...colony.knownFood.values()].filter((k) => k.estAmount > 0.5);
  const scoutChance = strategy.expansion_priority === 'scout_aggressively' ? 0.45 : 0.12;

  if (known.length === 0 || sim.rng.next() < scoutChance) {
    unit.state = 'scouting';
    unit.moveTo = scoutPoint(sim, colony);
    moveToward(unit, unit.moveTo, UNIT_STATS.worker.speed);
    return;
  }

  const assigned = new Map<number, number>();
  for (const other of sim.unitsOf(colony.id)) {
    if (other.targetFoodId === null) continue;
    assigned.set(other.targetFoodId, (assigned.get(other.targetFoodId) ?? 0) + 1);
  }

  let best = known[0];
  let bestScore = -Infinity;
  for (const candidate of known) {
    const dWorker = Math.hypot(candidate.x - unit.x, candidate.y - unit.y);
    // Distances are measured to the closest nest, so founding a nest near food
    // immediately makes that food look more attractive to every worker.
    const dNest = sim.distanceToNearestNest(colony.id, candidate);
    const dEnemyNest = sim.distanceToNearestNest(sim.enemyColony(colony.id).id, candidate);

    let score: number;
    switch (strategy.expansion_priority) {
      case 'nearest_food_first':
        score = -dWorker - 0.5 * dNest;
        break;
      case 'largest_food_first':
        score = candidate.estAmount * 0.12 - 0.6 * dWorker - 0.3 * dNest;
        break;
      case 'scout_aggressively':
        score = -dWorker + candidate.estAmount * 0.04;
        break;
      case 'contest_enemy_food':
        // Deny them the middle ground, but stay within hauling range of one of
        // our own nests. Founding a nest toward the enemy is what unlocks
        // contesting food deeper in their half.
        score =
          -0.5 * dWorker - 0.9 * dEnemyNest - 5 * Math.max(0, dNest - CONTEST_MAX_HAUL);
        break;
    }

    // Crowding penalty, so a colony spreads over several sources.
    score -= (assigned.get(candidate.foodId) ?? 0) * 3;

    // risk_tolerance also governs economic risk: cautious colonies discount
    // food that sits in the enemy's back yard.
    const danger = Math.max(0, 40 - dEnemyNest) / 40;
    score -= danger * 30 * (1 - strategy.risk_tolerance);

    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  unit.targetFoodId = best.foodId;
  unit.state = 'moving';
}

/** Explore outward from one of the colony's nests, chosen at random. */
function scoutPoint(sim: Simulation, colony: Colony): Vec {
  const from = colony.nests.length > 0 ? sim.rng.pick(colony.nests) : colony.homeNest;
  const angle = sim.rng.range(0, Math.PI * 2);
  const radius = sim.rng.range(20, 110);
  return {
    x: clamp(from.x + Math.cos(angle) * radius, 1, MAP_WIDTH - 1),
    y: clamp(from.y + Math.sin(angle) * radius, 1, MAP_HEIGHT - 1),
  };
}

// --------------------------------------------------------------------- soldier

function soldierAi(sim: Simulation, unit: Unit): void {
  const colony = sim.colonies[unit.owner];
  const strategy = colony.strategy;
  const stats = UNIT_STATS.soldier;

  // Defenders anchor on whichever asset is closest: a nest, or a queen still
  // walking to her site. That makes escorting an expansion emergent rather than
  // another posture to choose.
  const anchor = defendAnchor(sim, unit);

  if (anchor && unit.hp < unit.maxHp * retreatThreshold(strategy) && !sim.atNest(unit)) {
    unit.state = 'retreating';
    unit.targetEnemyId = null;
    moveToward(unit, anchor, stats.speed);
    return;
  }
  if (unit.state === 'retreating') {
    if (unit.hp < unit.maxHp * 0.85) return;
    unit.state = 'idle';
  }

  // aggression decides how much of the army leaves home. Ranking by unit id
  // keeps the split deterministic and stable between ticks.
  const index = sim.soldierRank(unit);
  const pushCount = Math.round(sim.soldierCount(unit.owner) * strategy.aggression);
  const pushing = strategy.soldier_posture !== 'defend_nest' && index < pushCount;
  const defendRadius = 8 + 30 * strategy.aggression;

  // Anything in contact, or anything inside one of our nests, is fought
  // regardless of posture or the odds. The queens come first.
  const contact = sim.nearestEnemy(unit, stats.attackRange + 0.6);
  if (contact) return engage(sim, unit, contact);
  const intruders = sim.intrudersAtNests(unit.owner);
  if (intruders.length > 0) {
    let closest = intruders[0];
    let closestDist = Infinity;
    for (const enemy of intruders) {
      const d = Math.hypot(enemy.x - unit.x, enemy.y - unit.y);
      if (d < closestDist) {
        closestDist = d;
        closest = enemy;
      }
    }
    return engage(sim, unit, closest);
  }

  if (pushing) {
    const opportunistic = sim.nearestEnemy(unit, 12);
    if (opportunistic && willEngage(sim, unit, strategy)) return engage(sim, unit, opportunistic);

    const target = pushTarget(sim, unit, strategy);
    unit.state = 'moving';
    unit.targetEnemyId = null;
    moveToward(unit, target, stats.speed);
    return;
  }

  if (!anchor) {
    const enemy = sim.nearestEnemy(unit, 40);
    if (enemy) return engage(sim, unit, enemy);
    unit.state = 'idle';
    return;
  }

  // Defender: intercept the nearest enemy that has come within the defend
  // radius of the anchor, otherwise hold a station on a ring around it.
  let intercept: Unit | null = null;
  let bestDist = Infinity;
  for (const enemy of sim.enemiesOf(unit.owner)) {
    if (Math.hypot(enemy.x - anchor.x, enemy.y - anchor.y) > defendRadius) continue;
    const d = Math.hypot(enemy.x - unit.x, enemy.y - unit.y);
    if (d < bestDist) {
      bestDist = d;
      intercept = enemy;
    }
  }
  if (intercept && willEngage(sim, unit, strategy)) return engage(sim, unit, intercept);

  const station: Vec = {
    x: anchor.x + Math.cos(index * 2.4) * (NEST_RADIUS + 2),
    y: anchor.y + Math.sin(index * 2.4) * (NEST_RADIUS + 2),
  };
  unit.targetEnemyId = null;
  unit.state = 'guarding';
  moveToward(unit, station, stats.speed);
}

/** Nearest own nest, or a founding queen if she is closer and needs cover. */
function defendAnchor(sim: Simulation, unit: Unit): Vec | null {
  let best: Vec | null = sim.nearestNest(unit.owner, unit);
  let bestDist = best ? Math.hypot(best.x - unit.x, best.y - unit.y) : Infinity;
  for (const queen of sim.foundingQueensOf(unit.owner)) {
    const d = Math.hypot(queen.x - unit.x, queen.y - unit.y);
    if (d < bestDist) {
      bestDist = d;
      best = { x: queen.x, y: queen.y };
    }
  }
  return best;
}

function pushTarget(sim: Simulation, unit: Unit, strategy: StrategyConfig): Vec {
  const enemyColony = sim.enemyColony(unit.owner);
  switch (strategy.soldier_posture) {
    case 'harass_enemy_workers': {
      // A queen walking to a founding site is the best prize on the map: 200
      // food and 60 seconds of build time, slow, and usually unescorted. A
      // harasser goes for her over a worker whenever one is within reach.
      let bestQueen: Unit | null = null;
      let bestDist = 90;
      for (const queen of sim.foundingQueensOf(enemyColony.id)) {
        const d = Math.hypot(queen.x - unit.x, queen.y - unit.y);
        if (d < bestDist) {
          bestDist = d;
          bestQueen = queen;
        }
      }
      if (bestQueen) return { x: bestQueen.x, y: bestQueen.y };

      const prey = sim.nearestEnemyOfType(unit, 'worker', Infinity);
      if (prey) return { x: prey.x, y: prey.y };
      return sim.nearestNest(enemyColony.id, unit) ?? enemyColony.homeNest;
    }
    case 'escort_workers': {
      const home = sim.nearestNest(unit.owner, unit) ?? sim.colonies[unit.owner].homeNest;
      let furthest: Unit | null = null;
      let bestDist = -1;
      for (const own of sim.unitsOf(unit.owner)) {
        if (own.type !== 'worker') continue;
        const d = sim.distanceToNearestNest(unit.owner, own);
        if (d > bestDist) {
          bestDist = d;
          furthest = own;
        }
      }
      return furthest ? { x: furthest.x, y: furthest.y } : home;
    }
    case 'attack_enemy_nest':
    default: {
      // Go for the closest enemy nest rather than always the original one, so
      // a push does not walk past a nearer target on the way to the far one.
      const nest = sim.nearestNest(enemyColony.id, unit);
      if (nest) return nest;
      const queen = sim.queensOf(enemyColony.id)[0];
      return queen ? { x: queen.x, y: queen.y } : enemyColony.homeNest;
    }
  }
}

/**
 * Local strength check gated by risk_tolerance. At 0 a soldier wants a 1.5x
 * local advantage before committing; at 1 it will attack into a 2:1 deficit.
 */
function willEngage(sim: Simulation, unit: Unit, strategy: StrategyConfig): boolean {
  const radius = 14;
  const own = sim.localStrength(unit.owner, unit, radius);
  const foe = sim.localStrength(unit.owner === 0 ? 1 : 0, unit, radius);
  if (foe <= 0) return true;
  return own >= foe * (1.5 - strategy.risk_tolerance);
}

// ---------------------------------------------------------------------- shared

/** risk_tolerance 0 retreats below 60% health, 1 never retreats. */
function retreatThreshold(strategy: StrategyConfig): number {
  return (1 - strategy.risk_tolerance) * 0.6;
}

function engage(sim: Simulation, unit: Unit, enemy: Unit): void {
  const stats = UNIT_STATS[unit.type];
  unit.targetEnemyId = enemy.id;
  unit.targetFoodId = null;
  unit.state = 'fighting';
  if (unit.type === 'queen') return; // settled queens never move
  const d = Math.hypot(enemy.x - unit.x, enemy.y - unit.y);
  if (d > stats.attackRange * 0.85) moveToward(unit, enemy, stats.speed);
}

/** Straight line movement. Terrain is open in v1, so there is no pathfinding. */
function moveToward(unit: Unit, target: Vec, speed: number): boolean {
  const dx = target.x - unit.x;
  const dy = target.y - unit.y;
  const d = Math.hypot(dx, dy);
  if (d <= ARRIVE_EPSILON) return true;
  const step = Math.min(speed * DT, d);
  unit.x = clamp(unit.x + (dx / d) * step, 0, MAP_WIDTH);
  unit.y = clamp(unit.y + (dy / d) * step, 0, MAP_HEIGHT);
  return false;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
