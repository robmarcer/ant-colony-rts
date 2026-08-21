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
  GUARDS_PER_PILE,
  GUARD_ACTIVITY_RADIUS,
  GUARD_DENIAL_CAP,
  GUARD_HOLD_RADIUS,
  GUARD_LEASH,
  GUARD_MAX_RANGE,
  GUARD_MIN_FOOD,
  GUARD_OWN_HALF_PENALTY_CAP,
  MAX_GUARDED_PILES,
  GATHER_RADIUS,
  MAP_HEIGHT,
  MAP_WIDTH,
  MAX_NESTS_PER_COLONY,
  MIN_ENEMY_NEST_DISTANCE,
  MIN_NEST_SEPARATION,
  NEST_RADIUS,
  TURN_RATE,
  UNIT_RADIUS,
  TURN_SPEED_FLOOR,
  RELOCATE_DROP_DISTANCE,
  RELOCATE_MIN_DISTANCE,
  RELOCATE_MIN_PILE,
  RECYCLE_MAX_PER_DECISION,
  RECYCLE_PRESSURE_FRACTION,
  RECYCLE_TOLERANCE_FRACTION,
  UNITS_PER_NEST,
  UNIT_STATS,
} from './config.js';
import type { StrategyConfig } from './strategy.js';
import type { Colony, Nest, Unit, UnitType, Vec } from './types.js';
import type { Simulation } from './sim.js';

export function runUnitAi(sim: Simulation, unit: Unit): void {
  if (unit.type !== 'queen' && handleRecycling(sim, unit)) return;
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
/**
 * Decide whether to send surplus units home to be eaten, so the army the colony
 * already has can be reshaped rather than only the army it builds next.
 *
 * Gated on population pressure: with room to spare, building the type you want
 * beats culling to make space for it, since culling throws away build time
 * already spent. Called on the same interval as rule evaluation rather than
 * every tick.
 */
export function runRecycling(sim: Simulation, colony: Colony): void {
  const strategy = colony.strategy;
  if (strategy.recycle_surplus <= 0) return;
  if (colony.nests.length === 0) return;

  const workers = sim.countUnits(colony.id, 'worker');
  const soldiers = sim.countUnits(colony.id, 'soldier');
  const population = workers + soldiers;
  const capacity = colony.nests.length * UNITS_PER_NEST;
  if (population < capacity * RECYCLE_PRESSURE_FRACTION) return;

  const tolerance = Math.max(1, population * RECYCLE_TOLERANCE_FRACTION);
  const targetWorkers = population * strategy.unit_production_ratio.worker;

  let type: 'worker' | 'soldier';
  let surplus: number;
  if (workers - targetWorkers > tolerance) {
    type = 'worker';
    surplus = workers - targetWorkers - tolerance;
    // Never cull below the worker floor the strategy itself asked for.
    surplus = Math.min(surplus, Math.max(0, workers - strategy.min_worker_reserve));
  } else if (targetWorkers - workers > tolerance) {
    type = 'soldier';
    surplus = targetWorkers - workers - tolerance;
  } else {
    return;
  }

  // The knob sets the rate, not just the switch. A flat cap scaled by nothing
  // made 0.5 and 1.0 behave identically, since any real surplus saturated it.
  const perDecision = Math.max(1, Math.round(RECYCLE_MAX_PER_DECISION * strategy.recycle_surplus));
  const wanted = Math.min(perDecision, Math.floor(surplus));
  if (wanted <= 0) return;

  // Take the ones already closest to a nest: they are the cheapest to recall and
  // spend the least time walking instead of working.
  const candidates = sim
    .unitsOf(colony.id)
    .filter((unit) => unit.type === type && !unit.recycling)
    .map((unit) => ({ unit, distance: sim.distanceToNearestNest(colony.id, unit) }))
    .sort((a, b) => a.distance - b.distance || a.unit.id - b.unit.id)
    .slice(0, wanted);

  for (const { unit } of candidates) {
    unit.recycling = true;
    unit.targetFoodId = null;
    unit.targetEnemyId = null;
    unit.guardFoodId = null;
    unit.state = 'recycling';
  }
  if (candidates.length > 0) {
    sim.pushEvent(
      'recycled',
      colony.id,
      `${colony.name} is recycling ${candidates.length} ${type}${candidates.length === 1 ? '' : 's'} at its population ceiling`,
      true,
    );
  }
}

/**
 * Walk home and be consumed. Returns true when the unit handled this tick, so
 * the normal AI is skipped.
 */
function handleRecycling(sim: Simulation, unit: Unit): boolean {
  if (!unit.recycling) return false;
  const home = sim.nearestNest(unit.owner, unit);
  if (!home) {
    // Nowhere left to go home to, so carry on being useful instead.
    unit.recycling = false;
    return false;
  }
  unit.state = 'recycling';
  if (moveToward(sim, unit, home, UNIT_STATS[unit.type].speed) || sim.atNest(unit)) {
    sim.recycleUnit(unit);
  }
  return true;
}

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
  // A founding queen is sent somewhere that looks safe from what the colony
  // knows. Settling next to a nest it never scouted is a real risk of not
  // scouting.
  const farEnoughFromEnemy = (point: Vec): boolean =>
    sim
      .believedEnemyNests(colony.id)
      .every((nest) => Math.hypot(nest.x - point.x, nest.y - point.y) >= MIN_ENEMY_NEST_DISTANCE);
  const enemyDistance = (point: Vec): number => sim.distanceToBelievedEnemyNest(colony.id, point);

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
    // A nest inside a rock would be unreachable and unbuildable.
    if (sim.blocked(site.x, site.y, NEST_RADIUS)) continue;

    const fromParent = Math.hypot(site.x - parent.x, site.y - parent.y);
    const dEnemy = enemyDistance(site);
    const danger = Math.max(0, 60 - dEnemy) / 60;
    let score = 0.05 * known.estAmount - 0.5 * fromParent - danger * 60 * (1 - strategy.risk_tolerance);

    // Which way to lean between otherwise comparable sites.
    if (strategy.expansion_bias === 'toward_enemy') score -= 0.35 * dEnemy;
    else if (strategy.expansion_bias === 'toward_safety') score += 0.35 * dEnemy;
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
    if (moveToward(sim, unit, unit.foundingSite, stats.speed)) sim.foundNest(unit);
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
    if (moveToward(sim, unit, home, stats.speed)) {
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

  // Ferrying a load to safer ground rather than banking it.
  if (unit.state === 'relocating' && unit.relocateTo) {
    if (moveToward(sim, unit, unit.relocateTo, stats.speed)) {
      sim.dropAsPile(unit);
      unit.state = 'idle';
      unit.targetFoodId = null;
    }
    return;
  }

  if (unit.state === 'returning') {
    if (moveToward(sim, unit, home, stats.speed) || sim.atNest(unit)) {
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
      // Capacity is volume; a pile's density turns that into energy. A worker
      // fills the same volume either way and carries home more from a rich
      // pile. The pile loses exactly what the worker gains, so nothing is
      // created: density is never applied again at deposit.
      const capacity = stats.carryCapacity * source.density;
      const take = Math.min(stats.gatherRate * source.density * DT, capacity - unit.carrying, source.amount);
      source.amount -= take;
      unit.carrying += take;
      const known = colony.knownFood.get(source.id);
      if (known) known.estAmount = source.amount;
      if (source.amount <= 0) sim.removeFood(source, source.kind === 'cluster');
      if (unit.carrying >= capacity - 1e-9) {
        const relocation = relocationTarget(sim, unit, colony, strategy, source);
        if (relocation) {
          unit.relocateTo = relocation;
          unit.state = 'relocating';
        } else {
          unit.state = 'returning';
        }
      }
    } else {
      unit.state = 'moving';
      moveToward(sim, unit, source, stats.speed);
    }
    return;
  }

  if (unit.state === 'scouting' && unit.moveTo) {
    if (moveToward(sim, unit, unit.moveTo, stats.speed)) {
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
  // The priority sets a floor, the knob can raise it. Adding them stacked
  // instead, which took preset-scout to 78% of decisions spent exploring: it
  // could not feed itself and lost 36 of 36 matches. A floor keeps the old
  // scout_aggressively behaviour exactly and lets the knob go further.
  const scoutChance = Math.max(
    strategy.scout_ratio,
    strategy.expansion_priority === 'scout_aggressively' ? 0.45 : 0,
  );

  if (known.length === 0 || sim.rng.next() < scoutChance) {
    unit.state = 'scouting';
    unit.moveTo = scoutPoint(sim, colony, strategy);
    moveToward(sim, unit, unit.moveTo, UNIT_STATS.worker.speed);
    return;
  }

  let best = known[0];
  let bestScore = -Infinity;
  for (const candidate of known) {
    const dWorker = Math.hypot(candidate.x - unit.x, candidate.y - unit.y);
    // Distances are measured to the closest nest, so founding a nest near food
    // immediately makes that food look more attractive to every worker.
    const dNest = sim.distanceToNearestNest(colony.id, candidate);
    // Believed, not actual: a colony discounts food near where it thinks their
    // nests are, which is the only thing it could reasonably act on.
    const dEnemyNest = sim.distanceToBelievedEnemyNest(colony.id, candidate);

    // Energy per trip, not just proximity: a rich pile is worth walking past a
    // thin one for. Density 1 is neutral so this changes nothing for corpses or
    // ordinary seeds.
    const densityBonus = (candidate.density - 1) * 12;

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

    score += densityBonus;

    // No crowding penalty here any more: workers physically queue at a busy
    // pile now, so congestion is real and counting it twice would over-correct.

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

/**
 * Should this load be ferried somewhere safer instead of banked?
 *
 * Only for piles worth the trouble that are beyond comfortable hauling range or
 * sitting closer to the enemy than to us. It is never the efficient choice: the
 * worker walks the same distance and the food still needs collecting afterwards.
 * What it buys is denying the enemy a pile they were better placed to take, and
 * shortening every future trip to what is left of it.
 */
function relocationTarget(
  sim: Simulation,
  unit: Unit,
  colony: Colony,
  strategy: StrategyConfig,
  source: { x: number; y: number; amount: number },
): Vec | null {
  if (strategy.relocate_food <= 0) return null;
  // Nothing left worth moving, so just take it home.
  if (source.amount < RELOCATE_MIN_PILE) return null;

  const fromUs = sim.distanceToNearestNest(colony.id, source);
  const fromThem = sim.distanceToBelievedEnemyNest(colony.id, source);
  const contested = fromThem < fromUs;
  if (fromUs < RELOCATE_MIN_DISTANCE && !contested) return null;

  // The knob is a probability, so a colony can hedge rather than commit.
  if (sim.rng.next() > strategy.relocate_food) return null;

  const home = sim.nearestNest(colony.id, unit);
  if (!home) return null;
  // Drop it short of the nest: close enough to be safe and cheap to collect,
  // far enough that it is a staging pile rather than a deposit by another name.
  const dx = source.x - home.x;
  const dy = source.y - home.y;
  const length = Math.hypot(dx, dy) || 1;
  return {
    x: clamp(home.x + (dx / length) * RELOCATE_DROP_DISTANCE, 1, MAP_WIDTH - 1),
    y: clamp(home.y + (dy / length) * RELOCATE_DROP_DISTANCE, 1, MAP_HEIGHT - 1),
  };
}

/**
 * Where a scout goes.
 *
 * A ring around our own nests finds food but never finds the enemy: the nests
 * are 170 cells apart and the ring reaches 110, so measured at 300 seconds a
 * colony scouting hard still believed nothing at all about its opponent. Part of
 * the scouting effort is therefore aimed down the line toward their territory,
 * in proportion to scout_ratio, which is what makes the knob buy intelligence
 * rather than only calories.
 */
function scoutPoint(sim: Simulation, colony: Colony, strategy: StrategyConfig): Vec {
  const from = colony.nests.length > 0 ? sim.rng.pick(colony.nests) : colony.homeNest;

  // The harder a colony scouts, the more of that effort probes toward them.
  if (sim.rng.next() < strategy.scout_ratio) {
    const target = sim.nearestBelievedEnemyNest(colony.id, from) ?? sim.enemyColony(colony.id).homeNest;
    const dx = target.x - from.x;
    const dy = target.y - from.y;
    const length = Math.hypot(dx, dy) || 1;
    // Somewhere along the way, with enough spread to sweep rather than beeline.
    const along = sim.rng.range(0.45, 1.0);
    const spread = sim.rng.range(-40, 40);
    return {
      x: clamp(from.x + dx * along - (dy / length) * spread, 1, MAP_WIDTH - 1),
      y: clamp(from.y + dy * along + (dx / length) * spread, 1, MAP_HEIGHT - 1),
    };
  }

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
    moveToward(sim, unit, anchor, stats.speed);
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

  // Guarding is not a push, it is a post. Handled separately because a guard
  // must not chase: it fights what comes to the pile and then goes back.
  if (pushing && strategy.soldier_posture === 'guard_food') {
    const post = guardPost(sim, unit, strategy);
    let target: Unit | null = null;
    let bestDist = Infinity;
    for (const enemy of sim.unitsNear(unit.owner === 0 ? 1 : 0, post, GUARD_LEASH)) {
      if (enemy.type === 'queen') continue;
      const d = Math.hypot(enemy.x - unit.x, enemy.y - unit.y);
      if (d < bestDist) {
        bestDist = d;
        target = enemy;
      }
    }
    if (target) return engage(sim, unit, target);

    // Walk to the pile, then hold. Guards used to be fanned around a ring by
    // unit index; separation spreads them now, but only if they stop driving at
    // the same point once they are there.
    unit.targetEnemyId = null;
    unit.state = 'guarding';
    if (Math.hypot(post.x - unit.x, post.y - unit.y) > GUARD_HOLD_RADIUS) {
      moveToward(sim, unit, post, stats.speed);
    }
    return;
  }

  if (pushing) {
    const opportunistic = sim.nearestEnemy(unit, 12);
    if (opportunistic && willEngage(sim, unit, strategy)) return engage(sim, unit, opportunistic);

    const target = pushTarget(sim, unit, strategy);
    unit.state = 'moving';
    unit.targetEnemyId = null;
    moveToward(sim, unit, target, stats.speed);
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

  // Hold just outside the nest. No ring offset: separation spreads defenders
  // around the anchor without the index arithmetic that used to fake it.
  const toAnchor = Math.hypot(anchor.x - unit.x, anchor.y - unit.y);
  const station: Vec =
    toAnchor > NEST_RADIUS + 2
      ? anchor
      : { x: unit.x, y: unit.y };
  unit.targetEnemyId = null;
  unit.state = 'guarding';
  moveToward(sim, unit, station, stats.speed);
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
    case 'guard_food':
      return guardPost(sim, unit, strategy);
    case 'harass_enemy_workers': {
      // Hunting from memory, not omniscience. A queen walking to a site is the
      // best prize on the map, so she is preferred if one has been seen.
      let best: Vec | null = null;
      let bestDist = 90;
      for (const belief of sim.believedEnemies(unit.owner)) {
        if (!belief.founding) continue;
        const d = Math.hypot(belief.x - unit.x, belief.y - unit.y);
        if (d < bestDist) {
          bestDist = d;
          best = { x: belief.x, y: belief.y };
        }
      }
      if (best) return best;

      let prey: Vec | null = null;
      let preyDist = Infinity;
      for (const belief of sim.believedEnemies(unit.owner)) {
        if (belief.type !== 'worker') continue;
        const d = Math.hypot(belief.x - unit.x, belief.y - unit.y);
        if (d < preyDist) {
          preyDist = d;
          prey = { x: belief.x, y: belief.y };
        }
      }
      if (prey) return prey;
      return sim.nearestBelievedEnemyNest(unit.owner, unit) ?? enemyColony.homeNest;
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
      // The closest nest we know of, which may be out of date. Marching on a
      // nest that has since been abandoned is a real cost of poor scouting.
      const nest = sim.nearestBelievedEnemyNest(unit.owner, unit);
      return nest ?? enemyColony.homeNest;
    }
  }
}

/**
 * Area denial. Pick a food pile the enemy is better placed to reach than we are,
 * stand on it, and kill their workers when they arrive.
 *
 * The pile has to be worth denying and reachable enough to be supportable: a
 * guard parked 150 cells from home just dies alone, which is the same mistake
 * contest_enemy_food used to make with workers. risk_tolerance decides how close
 * to the enemy a colony is willing to post a guard.
 *
 * Guards are spread across a few piles in pairs rather than stacked on one,
 * because a lone soldier loses to four or five massed workers.
 */
function guardPost(sim: Simulation, unit: Unit, strategy: StrategyConfig): Vec {
  const colony = sim.colonies[unit.owner];
  const enemy = sim.enemyColony(colony.id);

  // Hold the assigned post until the pile is actually gone. A guard that
  // re-picks every tick is not guarding anything.
  if (unit.guardFoodId !== null) {
    const held = sim.food.get(unit.guardFoodId);
    if (held && held.amount >= GUARD_MIN_FOOD) return { x: held.x, y: held.y };
    unit.guardFoodId = null;
  }

  const scored: Array<{ point: Vec; score: number; id: number }> = [];
  for (const known of colony.knownFood.values()) {
    if (known.estAmount < GUARD_MIN_FOOD) continue;
    const fromUs = sim.distanceToNearestNest(colony.id, known);
    const fromThem = sim.distanceToBelievedEnemyNest(colony.id, known);
    // Positive when the pile is closer to them than to us, which is the food
    // worth taking off them. Capped both ways: uncapped, the best denial score
    // always belongs to the pile touching their nest, and supportability has to
    // win that argument.
    const denial = Math.max(-GUARD_OWN_HALF_PENALTY_CAP, Math.min(GUARD_DENIAL_CAP, fromUs - fromThem));
    const exposure = Math.max(0, 60 - fromThem) / 60;

    // The strongest signal by far: enemy workers actually working this pile. A
    // guard on a pile nobody wants denies nothing, however valuable the pile.
    let activity = 0;
    for (const worker of sim.unitsNear(enemy.id, known, GUARD_ACTIVITY_RADIUS)) {
      if (worker.type === 'worker') activity++;
    }

    const score =
      1.5 * activity +
      0.04 * known.estAmount +
      // Denial is a rate, not a total. A dense pile hands the enemy more energy
      // per trip, so it is worth more to stand on than a bigger thin one, which
      // scoring on amount alone got backwards once food types existed.
      8 * (known.density - 1) +
      0.5 * denial -
      0.35 * fromUs -
      5 * Math.max(0, fromUs - GUARD_MAX_RANGE) -
      exposure * 60 * (1 - strategy.risk_tolerance);
    scored.push({ point: { x: known.x, y: known.y }, score, id: known.foodId });
  }

  if (scored.length === 0) {
    // Nothing known worth guarding, so hold the nest rather than wander.
    unit.guardFoodId = null;
    return sim.nearestNest(colony.id, unit) ?? colony.homeNest;
  }

  // Sort by value, then by id so equal scores resolve the same way every tick.
  scored.sort((a, b) => b.score - a.score || a.id - b.id);
  // Cover as many piles as the army can actually hold in pairs.
  const coverage = Math.max(1, Math.min(MAX_GUARDED_PILES, Math.floor(sim.soldierCount(colony.id) / GUARDS_PER_PILE)));
  const piles = scored.slice(0, coverage);
  const slot = Math.floor(sim.soldierRank(unit) / GUARDS_PER_PILE) % piles.length;
  unit.guardFoodId = piles[slot].id;
  return piles[slot].point;
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
  if (d > stats.attackRange * 0.85) moveToward(sim, unit, enemy, stats.speed);
}

/**
 * Adjust a desired bearing to get around a rock.
 *
 * Samples a fan of headings either side of where the unit wants to go and takes
 * the closest one that is clear, which is sliding along the edge it bumped into.
 * With convex rocks that always makes progress, so there is nothing to get stuck
 * on and no flow field is needed. If every heading is blocked, which the
 * generation gaps should prevent, it keeps the original bearing rather than
 * freezing in place.
 */
function steerAround(
  sim: Simulation,
  unit: Unit,
  wanted: number,
  speed: number,
  distance: number,
): number {
  const margin = UNIT_RADIUS[unit.type];
  // Far enough ahead that the turn rate has time to act, but never past the
  // destination. Probing beyond it had workers veering around rocks that were
  // not on their way at all, which cost far more throughput than the rocks did.
  const probe = Math.min(distance, Math.max(4, speed * DT * 20));
  const ahead = (angle: number) => ({
    x: unit.x + Math.cos(angle) * probe,
    y: unit.y + Math.sin(angle) * probe,
  });

  if (!sim.blocked(ahead(wanted).x, ahead(wanted).y, margin)) return wanted;

  for (let step = 1; step <= 12; step++) {
    const offset = (step * Math.PI) / 24;
    for (const candidate of [wanted + offset, wanted - offset]) {
      const point = ahead(candidate);
      if (!sim.blocked(point.x, point.y, margin)) return candidate;
    }
  }
  return wanted;
}

/**
 * Turn toward the target, then travel along the heading actually held.
 *
 * Terrain is open, so there is still no pathfinding, but a unit can no longer
 * reverse for free: it turns at a limited rate and its speed is scaled by how
 * well it is aligned, so it slows into a turn. That scaling is what stops a unit
 * orbiting a target it cannot turn tightly enough to reach.
 */
function moveToward(sim: Simulation, unit: Unit, target: Vec, speed: number): boolean {
  const dx = target.x - unit.x;
  const dy = target.y - unit.y;
  const d = Math.hypot(dx, dy);
  if (d <= ARRIVE_EPSILON) return true;

  const wanted = steerAround(sim, unit, Math.atan2(dy, dx), speed, d);
  // Shortest signed turn into (-pi, pi], so a unit never turns the long way.
  let delta = wanted - unit.heading;
  delta = Math.atan2(Math.sin(delta), Math.cos(delta));
  const maxTurn = TURN_RATE[unit.type] * DT;
  unit.heading += Math.abs(delta) <= maxTurn ? delta : Math.sign(delta) * maxTurn;
  unit.heading = Math.atan2(Math.sin(unit.heading), Math.cos(unit.heading));

  // Aligned units move at full speed; a unit mid-turn is slowed but never
  // stopped, so it always makes some progress and cannot deadlock.
  const alignment = Math.max(TURN_SPEED_FLOOR, Math.cos(delta));
  const step = Math.min(speed * alignment * DT, d);
  const margin = UNIT_RADIUS[unit.type] * 0.5;
  const nextX = clamp(unit.x + Math.cos(unit.heading) * step, 0, MAP_WIDTH);
  const nextY = clamp(unit.y + Math.sin(unit.heading) * step, 0, MAP_HEIGHT);

  if (!sim.blocked(nextX, nextY, margin)) {
    unit.x = nextX;
    unit.y = nextY;
  } else {
    // Touching a rock: slide along its surface rather than stopping. Stopping
    // dead is what made workers crawl, since the heading only turns free slowly
    // and nothing moved in the meantime. Sliding always makes progress around a
    // convex rock.
    const rock = sim.nearestObstacle(unit.x, unit.y);
    if (rock) {
      const nx = unit.x - rock.x;
      const ny = unit.y - rock.y;
      const length = Math.hypot(nx, ny) || 1;
      const tangents = [
        { x: -ny / length, y: nx / length },
        { x: ny / length, y: -nx / length },
      ];
      const want = { x: Math.cos(unit.heading), y: Math.sin(unit.heading) };
      // Whichever tangent points more like where the unit wants to go.
      tangents.sort((a, b) => b.x * want.x + b.y * want.y - (a.x * want.x + a.y * want.y));
      for (const tangent of tangents) {
        const slideX = clamp(unit.x + tangent.x * step, 0, MAP_WIDTH);
        const slideY = clamp(unit.y + tangent.y * step, 0, MAP_HEIGHT);
        if (!sim.blocked(slideX, slideY, margin)) {
          unit.x = slideX;
          unit.y = slideY;
          // Face the way it is actually travelling, so it comes off the rock
          // pointing sensibly rather than still aimed into it.
          unit.heading = Math.atan2(tangent.y, tangent.x);
          break;
        }
      }
    }
  }
  return Math.hypot(target.x - unit.x, target.y - unit.y) <= ARRIVE_EPSILON;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
