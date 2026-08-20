import { Rng, hashSeed } from './rng.js';
import {
  ARRIVE_EPSILON,
  CORPSE_DENSITY,
  CORPSE_MERGE_RADIUS,
  CORPSE_VALUE_FRACTION,
  DEFAULT_TIME_LIMIT_SECONDS,
  DEPOSIT_RADIUS,
  DT,
  MAP_HEIGHT,
  MAP_WIDTH,
  INTEL_INTERVAL,
  INTEL_MEMORY_SECONDS,
  MAX_NESTS_PER_COLONY,
  NEST_RADIUS,
  NEST_REGEN_PER_SECOND,
  QUEEN_ARMOUR,
  QUEEN_MAX_ATTACKERS,
  SCORE_WEIGHTS,
  SEPARATION_INTERVAL,
  SEPARATION_MAX_STEP,
  SEPARATION_STRENGTH,
  STALEMATE_UNIT_TOLERANCE,
  STALEMATE_WINDOW_SECONDS,
  STARTING_FOOD,
  STARTING_WORKERS,
  TICKS_PER_SECOND,
  UNIT_RADIUS,
  UNIT_STATS,
  type FoodType,
} from './config.js';
import { HOME_NEST_POSITIONS, generateFood } from './world.js';
import { PRESETS, type StrategyConfig } from './strategy.js';
import { RULE_EVAL_INTERVAL_SECONDS, parseDefinition, type BehaviourDefinition } from './definition.js';
import { computeMetrics, describeStrategy, evaluateRules, type Metrics } from './rules.js';
import { runColonyProduction, runRecycling, runUnitAi } from './ai.js';
import type {
  Colony,
  ColonyId,
  FoodSource,
  KnownEnemy,
  KnownNest,
  Nest,
  MatchEvent,
  MatchEventType,
  MatchOutcome,
  ScoreBreakdown,
  Unit,
  UnitType,
  Vec,
} from './types.js';

export interface SimOptions {
  seed?: string | number;
  timeLimitSeconds?: number;
  /** One behaviour file per colony, fixed for the whole match. */
  definitions?: [BehaviourDefinition, BehaviourDefinition];
  /**
   * Sim seconds of no material change before the match is called a stalemate.
   * 0 disables the detector entirely.
   */
  stalemateWindowSeconds?: number;
}

/** One row of the per-colony time series recorded for post-match analysis. */
export interface SeriesSample {
  simSeconds: number;
  food: [number, number];
  lifetimeFood: [number, number];
  workers: [number, number];
  soldiers: [number, number];
  kills: [number, number];
  knownFood: [number, number];
  nests: [number, number];
  queens: [number, number];
}

/** Sim seconds between time series samples. */
export const SERIES_INTERVAL_SECONDS = 5;

/**
 * The match. Pure logic, no DOM and no I/O, so the same class drives the
 * canvas renderer and the headless CLI runner. Given the same seed and the
 * same sequence of applied strategies it produces byte-identical matches.
 */
export class Simulation {
  readonly seed: number;
  readonly rng: Rng;
  readonly timeLimitTicks: number;

  tick = 0;
  units = new Map<number, Unit>();
  food = new Map<number, FoodSource>();
  colonies: [Colony, Colony];
  events: MatchEvent[] = [];
  outcome: MatchOutcome = { status: 'running' };

  /** Per-colony time series, sampled every SERIES_INTERVAL_SECONDS. */
  series: SeriesSample[] = [];

  /** Rebuilt once per tick so AI and combat share one pass over the units. */
  private roster: [Unit[], Unit[]] = [[], []];
  /**
   * Coarse uniform grid of units per colony, rebuilt each tick. Proximity
   * queries run every tick for every unit, so a linear scan was the dominant
   * cost of a match once colonies could reach a couple of hundred units.
   */
  private buckets: [Map<number, Unit[]>, Map<number, Unit[]>] = [new Map(), new Map()];
  /**
   * Per-tick derived state. Every soldier needs its rank within the army (to
   * decide whether it is one of the ones pushing out) and the list of enemies
   * standing in the colony's nests. Both were being recomputed per soldier per
   * tick, which was the single largest cost in a match.
   */
  private soldierRanks: [Map<number, number>, Map<number, number>] = [new Map(), new Map()];
  private soldierCounts: [number, number] = [0, 0];
  private intruders: [Unit[], Unit[]] = [[], []];
  private idCounter = 1;
  private lastNestAlarmTick: [number, number] = [-9999, -9999];
  private lastStarveAlarmTick: [number, number] = [-9999, -9999];
  private queenHpFlag: [number, number] = [1, 1];
  private firstContactSeen = false;
  readonly stalemateWindowTicks: number;
  /** Signature of the strategic position, and the tick it was last seen to move. */
  private positionAnchor: { tick: number; signature: number[] } = { tick: 0, signature: [] };

  constructor(options: SimOptions = {}) {
    this.seed = hashSeed(options.seed ?? 'default');
    this.rng = new Rng(this.seed);
    this.timeLimitTicks = Math.round((options.timeLimitSeconds ?? DEFAULT_TIME_LIMIT_SECONDS) * TICKS_PER_SECOND);
    this.stalemateWindowTicks = Math.round(
      (options.stalemateWindowSeconds ?? STALEMATE_WINDOW_SECONDS) * TICKS_PER_SECOND,
    );

    const definitions: [BehaviourDefinition, BehaviourDefinition] =
      options.definitions ?? [fallbackDefinition('balanced'), fallbackDefinition('balanced')];

    this.colonies = [this.makeColony(0, definitions[0]), this.makeColony(1, definitions[1])];

    for (const source of generateFood(this.rng, () => this.nextId())) {
      this.food.set(source.id, source);
    }

    for (const colony of this.colonies) {
      const queen = this.spawnUnit('queen', colony.id, colony.homeNest);
      const nest = this.foundNest(queen);
      for (let i = 0; i < STARTING_WORKERS; i++) {
        this.spawnUnit('worker', colony.id, this.nestSpawnPoint(nest));
      }
    }

    // Both colonies know where the other started. Anything else has to be seen.
    for (const colony of this.colonies) {
      const enemy = this.enemyColony(colony.id);
      const home = enemy.nests[0];
      if (home) {
        colony.knownEnemyNests.set(home.id, { nestId: home.id, x: home.x, y: home.y, lastSeenTick: 0 });
      }
    }

    this.pushEvent('match_start', null, `Match start, seed ${this.seed}`, true);
    this.rebuildRoster();
  }

  // ---------------------------------------------------------------- lifecycle

  private makeColony(id: ColonyId, definition: BehaviourDefinition): Colony {
    return {
      id,
      name: definition.name,
      homeNest: { ...HOME_NEST_POSITIONS[id] },
      nests: [],
      food: STARTING_FOOD,
      lifetimeFoodGathered: 0,
      definition,
      strategy: { ...definition.base },
      activeRuleIds: [],
      ruleActiveSince: new Map(),
      strategyChangedTick: 0,
      knownFood: new Map(),
      knownEnemies: new Map(),
      knownEnemyNests: new Map(),
      lastSightingTick: -99999,
      unitsProduced: { queen: 1, worker: STARTING_WORKERS, soldier: 0 },
      nestsFounded: 0,
      unitsRecycled: { queen: 0, worker: 0, soldier: 0 },
      foodRelocated: 0,
      queensLostInTransit: 0,
      unitsLost: { queen: 0, worker: 0, soldier: 0 },
      recentLosses: 0,
      kills: 0,
    };
  }

  nextId(): number {
    return this.idCounter++;
  }

  get simSeconds(): number {
    return this.tick / TICKS_PER_SECOND;
  }

  get timeLimitSeconds(): number {
    return this.timeLimitTicks / TICKS_PER_SECOND;
  }

  get finished(): boolean {
    return this.outcome.status === 'finished';
  }

  // ------------------------------------------------------------------ queries

  unitsOf(colony: ColonyId): Unit[] {
    return this.roster[colony];
  }

  enemiesOf(colony: ColonyId): Unit[] {
    return this.roster[colony === 0 ? 1 : 0];
  }

  enemyColony(colony: ColonyId): Colony {
    return this.colonies[colony === 0 ? 1 : 0];
  }

  /** Every living queen of a colony, settled or still walking to a site. */
  queensOf(colony: ColonyId): Unit[] {
    return this.roster[colony].filter((unit) => unit.type === 'queen');
  }

  /** Queens on their way to found a nest, i.e. expansions in flight. */
  foundingQueensOf(colony: ColonyId): Unit[] {
    return this.queensOf(colony).filter((unit) => unit.foundingSite !== null);
  }

  /** A colony is alive while it has at least one queen anywhere on the map. */
  isAlive(colony: ColonyId): boolean {
    return this.queensOf(colony).length > 0;
  }

  /** Lowest health fraction across a colony's queens, 0 if it has none. */
  lowestQueenHealth(colony: ColonyId): number {
    const queens = this.queensOf(colony);
    if (queens.length === 0) return 0;
    return Math.min(...queens.map((queen) => queen.hp / queen.maxHp));
  }

  /** Nearest nest belonging to a colony, or null while it has none. */
  nearestNest(colony: ColonyId, at: Vec): Nest | null {
    let best: Nest | null = null;
    let bestDist = Infinity;
    for (const nest of this.colonies[colony].nests) {
      const d = Math.hypot(nest.x - at.x, nest.y - at.y);
      if (d < bestDist) {
        bestDist = d;
        best = nest;
      }
    }
    return best;
  }

  distanceToNearestNest(colony: ColonyId, at: Vec): number {
    const nest = this.nearestNest(colony, at);
    return nest ? Math.hypot(nest.x - at.x, nest.y - at.y) : Infinity;
  }

  /**
   * Settle a queen where she stands and create her nest. Called once per colony
   * at match start, and again whenever a founding queen reaches her site.
   */
  foundNest(queen: Unit): Nest {
    const colony = this.colonies[queen.owner];
    const nest: Nest = {
      id: this.nextId(),
      owner: queen.owner,
      x: queen.x,
      y: queen.y,
      queenId: queen.id,
      foundedTick: this.tick,
    };
    colony.nests.push(nest);
    queen.nestId = nest.id;
    queen.foundingSite = null;
    queen.state = 'idle';
    if (this.tick > 0) {
      colony.nestsFounded++;
      this.pushEvent(
        'nest_founded',
        colony.id,
        `${colony.name} founded nest ${colony.nests.length} at ${fmt(nest.x)}, ${fmt(nest.y)}`,
        true,
      );
    }
    return nest;
  }

  countUnits(colony: ColonyId, type: UnitType): number {
    let n = 0;
    for (const unit of this.roster[colony]) if (unit.type === type) n++;
    return n;
  }

  /** Nearest living enemy within range, or null. */
  nearestEnemy(unit: Unit, maxRange: number): Unit | null {
    let best: Unit | null = null;
    let bestDist = maxRange;
    for (const enemy of this.near(unit.owner === 0 ? 1 : 0, unit, maxRange)) {
      const d = Math.hypot(enemy.x - unit.x, enemy.y - unit.y);
      if (d < bestDist) {
        bestDist = d;
        best = enemy;
      }
    }
    return best;
  }

  /** Nearest living enemy of a given type within range, or null. */
  nearestEnemyOfType(unit: Unit, type: UnitType, maxRange: number): Unit | null {
    let best: Unit | null = null;
    let bestDist = maxRange;
    for (const enemy of this.near(unit.owner === 0 ? 1 : 0, unit, maxRange)) {
      if (enemy.type !== type) continue;
      const d = Math.hypot(enemy.x - unit.x, enemy.y - unit.y);
      if (d < bestDist) {
        bestDist = d;
        best = enemy;
      }
    }
    return best;
  }

  /** Sum of attack * hp as a crude local strength measure, used by risk_tolerance. */
  localStrength(owner: ColonyId, at: Vec, radius: number): number {
    let total = 0;
    for (const unit of this.near(owner, at, radius)) {
      if (unit.type === 'queen') continue;
      if (Math.hypot(unit.x - at.x, unit.y - at.y) > radius) continue;
      total += UNIT_STATS[unit.type].attack * unit.hp;
    }
    return total;
  }

  /** Units of a colony within radius of a point, used for nest proximity checks. */
  unitsNear(owner: ColonyId, at: Vec, radius: number): Unit[] {
    return this.near(owner, at, radius).filter(
      (unit) => Math.hypot(unit.x - at.x, unit.y - at.y) <= radius,
    );
  }

  // ------------------------------------------------------------------ mutation

  spawnUnit(type: UnitType, owner: ColonyId, at: Vec): Unit {
    const stats = UNIT_STATS[type];
    const unit: Unit = {
      id: this.nextId(),
      type,
      owner,
      x: at.x,
      y: at.y,
      hp: stats.maxHp,
      maxHp: stats.maxHp,
      state: 'idle',
      carrying: 0,
      targetFoodId: null,
      targetEnemyId: null,
      moveTo: null,
      attackCooldown: 0,
      bornTick: this.tick,
      lastDamagedTick: -9999,
      foundingSite: null,
      nestId: null,
      build: null,
      guardFoodId: null,
      recycling: false,
      relocateTo: null,
    };
    this.units.set(unit.id, unit);
    return unit;
  }

  nestSpawnPoint(nest: Nest): Vec {
    const angle = this.rng.range(0, Math.PI * 2);
    const r = this.rng.range(1, NEST_RADIUS);
    return {
      x: clamp(nest.x + Math.cos(angle) * r, 0, MAP_WIDTH),
      y: clamp(nest.y + Math.sin(angle) * r, 0, MAP_HEIGHT),
    };
  }

  /**
   * Re-evaluate both colonies' rule lists. Called on a fixed interval from
   * step(), never from outside: once a match starts, the only thing that can
   * change a colony's behaviour is its own definition file.
   */
  private evaluateBehaviour(): void {
    for (const colony of this.colonies) {
      const metrics = computeMetrics(this, colony.id);

      // Rules still inside their minimum hold stay active even if their
      // condition has lapsed, which is what stops a rule flapping on a
      // threshold the match keeps crossing.
      const held = new Set<string>();
      for (const [ruleId, since] of colony.ruleActiveSince) {
        const rule = colony.definition.rules.find((candidate) => candidate.id === ruleId);
        const hold = rule?.min_hold_seconds ?? 0;
        if (hold > 0 && this.tick < since + hold * TICKS_PER_SECOND) held.add(ruleId);
      }

      const { strategy, activeRuleIds } = evaluateRules(colony.definition, metrics, held);

      const before = colony.activeRuleIds;
      for (const id of activeRuleIds) {
        if (!before.includes(id)) {
          const rule = colony.definition.rules.find((r) => r.id === id);
          this.pushEvent(
            'rule_activated',
            colony.id,
            `${colony.name} rule ${id} on: ${describeRule(rule?.set)}${rule?.note ? ` (${rule.note})` : ''}`,
            true,
          );
        }
      }
      for (const id of before) {
        if (!activeRuleIds.includes(id)) {
          this.pushEvent('rule_deactivated', colony.id, `${colony.name} rule ${id} off`, false);
        }
      }

      if (describeStrategy(strategy) !== describeStrategy(colony.strategy)) {
        colony.strategyChangedTick = this.tick;
        this.pushEvent('strategy_change', colony.id, `${colony.name} now ${describeStrategy(strategy)}`, true);
      }
      colony.strategy = strategy;
      colony.activeRuleIds = activeRuleIds;
      for (const id of activeRuleIds) {
        if (!colony.ruleActiveSince.has(id)) colony.ruleActiveSince.set(id, this.tick);
      }
      for (const id of [...colony.ruleActiveSince.keys()]) {
        if (!activeRuleIds.includes(id)) colony.ruleActiveSince.delete(id);
      }
    }
  }

  /** Snapshot of the rule inputs, exposed so the UI can show why a rule fired. */
  metricsFor(colony: ColonyId): Metrics {
    return computeMetrics(this, colony);
  }

  pushEvent(type: MatchEventType, colony: ColonyId | null, text: string, major = false): void {
    this.events.push({ tick: this.tick, simSeconds: this.simSeconds, type, colony, text, major });
  }

  /**
   * Drop a corpse. Merges into an existing pile within CORPSE_MERGE_RADIUS so a
   * battle leaves a few worthwhile piles instead of a scatter of crumbs.
   */
  addCorpse(at: Vec, value: number): void {
    this.addFoodPile(at, value, 'seeds');
  }

  /**
   * Add energy to the ground, merging into a nearby pile of the same kind. Used
   * by both corpses and relocated loads, so a battlefield and a stockpile
   * someone chose to move behave the same way.
   */
  addFoodPile(at: Vec, value: number, type: FoodType): void {
    if (value <= 0) return;

    for (const source of this.food.values()) {
      if (source.kind !== 'corpse') continue;
      if (Math.hypot(source.x - at.x, source.y - at.y) > CORPSE_MERGE_RADIUS) continue;
      source.amount += value;
      source.deaths++;
      source.initialAmount = Math.max(source.initialAmount, source.amount);
      // Anyone who already knows this pile sees it grow, without needing to
      // walk past again.
      for (const colony of this.colonies) {
        const known = colony.knownFood.get(source.id);
        if (known) known.estAmount = source.amount;
      }
      return;
    }

    const source: FoodSource = {
      id: this.nextId(),
      kind: 'corpse',
      type: 'seeds',
      density: CORPSE_DENSITY,
      x: at.x,
      y: at.y,
      amount: value,
      initialAmount: value,
      deaths: 1,
    };
    this.food.set(source.id, source);
  }

  // ---------------------------------------------------------------------- tick

  private rebuildRoster(): void {
    this.roster[0] = [];
    this.roster[1] = [];
    this.buckets[0] = new Map();
    this.buckets[1] = new Map();
    for (const unit of this.units.values()) {
      this.roster[unit.owner].push(unit);
      const key = bucketKey(unit.x, unit.y);
      const bucket = this.buckets[unit.owner].get(key);
      if (bucket) bucket.push(unit);
      else this.buckets[unit.owner].set(key, [unit]);
    }

    for (const id of [0, 1] as ColonyId[]) {
      // Roster order follows insertion order, which is id order, so ranking by
      // position in this pass matches sorting by id without the sort.
      const ranks = new Map<number, number>();
      let rank = 0;
      for (const unit of this.roster[id]) {
        if (unit.type === 'soldier') ranks.set(unit.id, rank++);
      }
      this.soldierRanks[id] = ranks;
      this.soldierCounts[id] = rank;

      const found: Unit[] = [];
      const seen = new Set<number>();
      for (const nest of this.colonies[id]?.nests ?? []) {
        for (const enemy of this.near(id === 0 ? 1 : 0, nest, NEST_RADIUS + 2)) {
          if (seen.has(enemy.id)) continue;
          if (Math.hypot(enemy.x - nest.x, enemy.y - nest.y) >= NEST_RADIUS + 2) continue;
          seen.add(enemy.id);
          found.push(enemy);
        }
      }
      this.intruders[id] = found;
    }
  }

  /** This soldier's position in its army, stable within a tick. */
  soldierRank(unit: Unit): number {
    return this.soldierRanks[unit.owner].get(unit.id) ?? 0;
  }

  soldierCount(colony: ColonyId): number {
    return this.soldierCounts[colony];
  }

  /** Enemy units currently standing inside one of this colony's nests. */
  intrudersAtNests(colony: ColonyId): Unit[] {
    return this.intruders[colony];
  }

  /**
   * Every unit of `owner` within `radius` of a point, in a deterministic order.
   * Falls back to a full scan for unbounded radii.
   */
  private near(owner: ColonyId, at: Vec, radius: number): Unit[] {
    if (!Number.isFinite(radius) || radius > BUCKET_SIZE * 8) return this.roster[owner];
    const found: Unit[] = [];
    const minX = Math.floor((at.x - radius) / BUCKET_SIZE);
    const maxX = Math.floor((at.x + radius) / BUCKET_SIZE);
    const minY = Math.floor((at.y - radius) / BUCKET_SIZE);
    const maxY = Math.floor((at.y + radius) / BUCKET_SIZE);
    for (let gx = minX; gx <= maxX; gx++) {
      for (let gy = minY; gy <= maxY; gy++) {
        const bucket = this.buckets[owner].get(gx * BUCKET_STRIDE + gy);
        if (bucket) for (const unit of bucket) found.push(unit);
      }
    }
    return found;
  }

  /** Advance one tick. Safe to call after the match ends; it does nothing. */
  step(): void {
    if (this.finished) return;
    this.tick++;

    this.rebuildRoster();
    // Nothing on the map decays, so there is no per-tick food upkeep pass.
    // Vision does not need to be resolved at full tick rate. Every third tick
    // is a third of a second of latency on spotting food, which no strategy can
    // perceive, and it removes a units-times-sources pass from most ticks.
    if (this.tick % 3 === 0) this.updateKnownFood();
    if (this.tick % INTEL_INTERVAL === 0) this.updateIntel();

    if (this.tick % Math.round(RULE_EVAL_INTERVAL_SECONDS * TICKS_PER_SECOND) === 0) {
      this.evaluateBehaviour();
      for (const colony of this.colonies) runRecycling(this, colony);
    }

    for (const colony of this.colonies) {
      colony.recentLosses = Math.max(0, colony.recentLosses - DT / 30); // ~30s memory
      runColonyProduction(this, colony);
    }

    for (const unit of this.units.values()) {
      if (unit.attackCooldown > 0) unit.attackCooldown -= DT;
      runUnitAi(this, unit);
      this.regenInNest(unit);
    }

    if (this.tick % SEPARATION_INTERVAL === 0) this.applySeparation();
    this.resolveCombat();
    this.checkAlarms();
    this.checkProgress();
    if (this.tick % Math.round(SERIES_INTERVAL_SECONDS * TICKS_PER_SECOND) === 0) this.sample();
    this.checkOutcome();
  }

  /** Advance up to n ticks, stopping early if the match ends. */
  run(ticks: number): void {
    for (let i = 0; i < ticks && !this.finished; i++) this.step();
  }

  private sample(): void {
    this.series.push({
      simSeconds: Math.round(this.simSeconds),
      food: [Math.round(this.colonies[0].food), Math.round(this.colonies[1].food)],
      lifetimeFood: [
        Math.round(this.colonies[0].lifetimeFoodGathered),
        Math.round(this.colonies[1].lifetimeFoodGathered),
      ],
      workers: [this.countUnits(0, 'worker'), this.countUnits(1, 'worker')],
      soldiers: [this.countUnits(0, 'soldier'), this.countUnits(1, 'soldier')],
      kills: [this.colonies[0].kills, this.colonies[1].kills],
      knownFood: [this.colonies[0].knownFood.size, this.colonies[1].knownFood.size],
      nests: [this.colonies[0].nests.length, this.colonies[1].nests.length],
      queens: [this.countUnits(0, 'queen'), this.countUnits(1, 'queen')],
    });
  }

  removeFood(source: FoodSource, announce: boolean): void {
    this.food.delete(source.id);
    for (const colony of this.colonies) {
      if (colony.knownFood.delete(source.id) && announce) {
        this.pushEvent('food_depleted', colony.id, `${colony.name} exhausted a food source`, false);
      }
    }
    for (const unit of this.units.values()) {
      if (unit.targetFoodId === source.id) {
        unit.targetFoodId = null;
        if (unit.state === 'gathering' || unit.state === 'moving') unit.state = 'idle';
      }
      // Soldiers posted here need releasing too, or the field points at a pile
      // that no longer exists.
      if (unit.guardFoodId === source.id) unit.guardFoodId = null;
    }
  }

  /**
   * Vision pass. Anything a unit can see goes into that colony's shared
   * "known food" list, which is the colony's intel mechanic: workers do not
   * lay literal pheromone trails, they publish to colony memory and other
   * idle workers read from it.
   */
  private updateKnownFood(): void {
    for (const unit of this.units.values()) {
      const vision = UNIT_STATS[unit.type].vision;
      const colony = this.colonies[unit.owner];
      for (const source of this.food.values()) {
        if (Math.hypot(source.x - unit.x, source.y - unit.y) > vision) continue;
        const existing = colony.knownFood.get(source.id);
        if (existing) {
          existing.estAmount = source.amount;
          existing.lastSeenTick = this.tick;
        } else {
          colony.knownFood.set(source.id, {
            foodId: source.id,
            x: source.x,
            y: source.y,
            estAmount: source.amount,
            density: source.density,
            lastSeenTick: this.tick,
            distanceFromNest: this.distanceToNearestNest(colony.id, source),
          });
        }
      }
    }
  }

  /**
   * The visibility pass. Anything an enemy unit or nest is within vision of gets
   * recorded as a belief, with the tick it was seen. Beliefs expire after
   * INTEL_MEMORY_SECONDS so that scouting keeps paying and stale information
   * cannot masquerade as current.
   *
   * This is strategic intelligence only. It does not gate combat: a soldier
   * still fights whatever is in front of it, because that is perception rather
   * than memory.
   */
  private updateIntel(): void {
    const memoryTicks = INTEL_MEMORY_SECONDS * TICKS_PER_SECOND;

    for (const id of [0, 1] as ColonyId[]) {
      const colony = this.colonies[id];
      const enemy = this.enemyColony(id);

      for (const watcher of this.roster[id]) {
        const vision = UNIT_STATS[watcher.type].vision;

        for (const seen of this.near(enemy.id, watcher, vision)) {
          if (Math.hypot(seen.x - watcher.x, seen.y - watcher.y) > vision) continue;
          colony.knownEnemies.set(seen.id, {
            unitId: seen.id,
            type: seen.type,
            x: seen.x,
            y: seen.y,
            hpFraction: seen.hp / seen.maxHp,
            founding: seen.type === 'queen' && seen.foundingSite !== null,
            lastSeenTick: this.tick,
          });
          colony.lastSightingTick = this.tick;
        }

        for (const nest of enemy.nests) {
          if (Math.hypot(nest.x - watcher.x, nest.y - watcher.y) > vision) continue;
          colony.knownEnemyNests.set(nest.id, {
            nestId: nest.id,
            x: nest.x,
            y: nest.y,
            lastSeenTick: this.tick,
          });
        }
      }

      // Forget what has not been seen for a while, and anything we watched die.
      for (const [unitId, belief] of colony.knownEnemies) {
        if (this.tick - belief.lastSeenTick > memoryTicks) colony.knownEnemies.delete(unitId);
      }
      for (const [nestId, belief] of colony.knownEnemyNests) {
        // A nest we can currently see is either there or gone; if we are looking
        // at where it was and it is not there, drop it.
        const stillThere = enemy.nests.some((nest) => nest.id === nestId);
        const watched = this.roster[id].some(
          (watcher) => Math.hypot(belief.x - watcher.x, belief.y - watcher.y) <= UNIT_STATS[watcher.type].vision,
        );
        if (watched && !stillThere) colony.knownEnemyNests.delete(nestId);
      }
    }
  }

  /** Enemy units this colony currently believes exist. */
  believedEnemies(colony: ColonyId): KnownEnemy[] {
    return [...this.colonies[colony].knownEnemies.values()];
  }

  believedEnemyCount(colony: ColonyId, type: UnitType): number {
    let n = 0;
    for (const belief of this.colonies[colony].knownEnemies.values()) if (belief.type === type) n++;
    return n;
  }

  /** Enemy nests this colony knows of. Their home nest is known from the start. */
  believedEnemyNests(colony: ColonyId): KnownNest[] {
    return [...this.colonies[colony].knownEnemyNests.values()];
  }

  nearestBelievedEnemyNest(colony: ColonyId, at: Vec): KnownNest | null {
    let best: KnownNest | null = null;
    let bestDist = Infinity;
    for (const nest of this.colonies[colony].knownEnemyNests.values()) {
      const d = Math.hypot(nest.x - at.x, nest.y - at.y);
      if (d < bestDist) {
        bestDist = d;
        best = nest;
      }
    }
    return best;
  }

  /** Distance to the nearest enemy nest this colony knows about. */
  distanceToBelievedEnemyNest(colony: ColonyId, at: Vec): number {
    const nest = this.nearestBelievedEnemyNest(colony, at);
    return nest ? Math.hypot(nest.x - at.x, nest.y - at.y) : MAP_WIDTH;
  }

  /** Seconds since this colony last laid eyes on any enemy unit. */
  intelAgeSeconds(colony: ColonyId): number {
    const last = this.colonies[colony].lastSightingTick;
    if (last < 0) return this.simSeconds;
    return (this.tick - last) / TICKS_PER_SECOND;
  }

  private regenInNest(unit: Unit): void {
    // Queens do not heal. With nest regen applied to a 500 hp queen the
    // regeneration rate exceeded a soldier's dps and no queen could ever be
    // killed, which removed the primary win condition from the game.
    if (unit.type === 'queen') return;
    if (unit.hp >= unit.maxHp) return;
    if (this.distanceToNearestNest(unit.owner, unit) > NEST_RADIUS) return;
    unit.hp = Math.min(unit.maxHp, unit.hp + unit.maxHp * NEST_REGEN_PER_SECOND * DT);
  }

  /**
   * Push overlapping units apart. Both colonies at once: an ant gets out of the
   * way of whoever is in front of it, not only of its own side.
   *
   * Strictly two phase. Every displacement is computed from the positions as
   * they are now, then all of them are applied, so the outcome cannot depend on
   * iteration order. A settled queen is an immovable obstacle: she pushes and is
   * not pushed.
   */
  private applySeparation(): void {
    // Units have moved since the roster was built, so refresh the buckets first
    // or neighbour lookups work from stale cells.
    this.rebuildRoster();

    const displacement = new Map<number, { dx: number; dy: number }>();
    const maxRadius = Math.max(...Object.values(UNIT_RADIUS));

    for (const id of [0, 1] as ColonyId[]) {
      for (const unit of this.roster[id]) {
        // A queen only moves while she is walking to found a nest.
        if (unit.type === 'queen' && unit.foundingSite === null) continue;
        const radius = UNIT_RADIUS[unit.type];
        let dx = 0;
        let dy = 0;

        for (const otherOwner of [0, 1] as ColonyId[]) {
          for (const other of this.near(otherOwner, unit, radius + maxRadius)) {
            if (other.id === unit.id) continue;
            const minimum = radius + UNIT_RADIUS[other.type];
            const ox = unit.x - other.x;
            const oy = unit.y - other.y;
            const distance = Math.hypot(ox, oy);
            if (distance >= minimum) continue;

            const overlap = minimum - distance;
            if (distance < 1e-6) {
              // Exactly co-located, so there is no direction to push along.
              // Derive one from the ids, which keeps it deterministic.
              const angle = ((unit.id * 2654435761) % 6283) / 1000;
              dx += Math.cos(angle) * overlap * SEPARATION_STRENGTH;
              dy += Math.sin(angle) * overlap * SEPARATION_STRENGTH;
              continue;
            }
            dx += (ox / distance) * overlap * SEPARATION_STRENGTH;
            dy += (oy / distance) * overlap * SEPARATION_STRENGTH;
          }
        }

        if (dx === 0 && dy === 0) continue;
        const magnitude = Math.hypot(dx, dy);
        if (magnitude > SEPARATION_MAX_STEP) {
          dx = (dx / magnitude) * SEPARATION_MAX_STEP;
          dy = (dy / magnitude) * SEPARATION_MAX_STEP;
        }
        displacement.set(unit.id, { dx, dy });
      }
    }

    for (const [unitId, { dx, dy }] of displacement) {
      const unit = this.units.get(unitId);
      if (!unit) continue;
      unit.x = Math.min(MAP_WIDTH, Math.max(0, unit.x + dx));
      unit.y = Math.min(MAP_HEIGHT, Math.max(0, unit.y + dy));
    }
  }

  private resolveCombat(): void {
    const dead: Array<{ unit: Unit; killer: ColonyId }> = [];

    // Only so many attackers fit around a queen at once. Decided before any
    // damage is applied, in unit id order, so the same units get the slots every
    // tick and the result does not depend on map iteration order.
    const queenSlots = this.assignQueenAttackSlots();

    for (const unit of this.units.values()) {
      if (unit.targetEnemyId === null) continue;
      const target = this.units.get(unit.targetEnemyId);
      if (!target || target.hp <= 0) {
        unit.targetEnemyId = null;
        continue;
      }
      const stats = UNIT_STATS[unit.type];
      if (Math.hypot(target.x - unit.x, target.y - unit.y) > stats.attackRange) continue;
      if (unit.attackCooldown > 0) continue;
      // Standing in the queue counts as being in the fight, but only the units
      // holding a slot land blows.
      if (target.type === 'queen' && !queenSlots.get(target.id)?.has(unit.id)) continue;

      unit.attackCooldown = stats.attackCooldown;
      target.hp -= target.type === 'queen' ? Math.max(1, stats.attack - QUEEN_ARMOUR) : stats.attack;
      target.lastDamagedTick = this.tick;
      if (!this.firstContactSeen) {
        this.firstContactSeen = true;
        this.pushEvent('first_contact', unit.owner, `First contact at ${fmt(unit.x)}, ${fmt(unit.y)}`, true);
      }
      if (target.hp <= 0) dead.push({ unit: target, killer: unit.owner });
    }

    for (const { unit, killer } of dead) {
      if (!this.units.has(unit.id)) continue; // already removed this tick
      this.killUnit(unit, killer);
    }
  }

  /**
   * For each queen under attack, which enemies currently hold one of the limited
   * positions around her. Nearest first, then by id, so the slots are stable
   * while the same units stay in contact.
   */
  private assignQueenAttackSlots(): Map<number, Set<number>> {
    const slots = new Map<number, Set<number>>();
    for (const id of [0, 1] as ColonyId[]) {
      for (const queen of this.queensOf(id)) {
        const contenders: Array<{ id: number; distance: number }> = [];
        for (const enemy of this.near(id === 0 ? 1 : 0, queen, 4)) {
          const range = UNIT_STATS[enemy.type].attackRange;
          const distance = Math.hypot(enemy.x - queen.x, enemy.y - queen.y);
          if (distance <= range) contenders.push({ id: enemy.id, distance });
        }
        if (contenders.length === 0) continue;
        contenders.sort((a, b) => a.distance - b.distance || a.id - b.id);
        slots.set(queen.id, new Set(contenders.slice(0, QUEEN_MAX_ATTACKERS).map((c) => c.id)));
      }
    }
    return slots;
  }

  private killUnit(unit: Unit, killer: ColonyId): void {
    this.units.delete(unit.id);
    const owner = this.colonies[unit.owner];
    owner.unitsLost[unit.type]++;
    owner.recentLosses += 1;
    this.colonies[killer].kills++;

    // A dead ant is food, and returns every point of energy it was built from.
    // A queen also returns whatever she had already invested in the unit she was
    // building; the brood dies with her, but the energy does not vanish.
    let value = UNIT_STATS[unit.type].cost * CORPSE_VALUE_FRACTION + unit.carrying;
    if (unit.build) value += UNIT_STATS[unit.build.type].cost * CORPSE_VALUE_FRACTION;
    this.addCorpse({ x: unit.x, y: unit.y }, value);

    for (const other of this.units.values()) {
      if (other.targetEnemyId === unit.id) other.targetEnemyId = null;
    }

    if (unit.type === 'queen') {
      // Her nest dies with her. Workers heading there will pick another nest,
      // and the colony is only finished when its last queen falls.
      const nestIndex = owner.nests.findIndex((nest) => nest.queenId === unit.id);
      if (nestIndex >= 0) {
        owner.nests.splice(nestIndex, 1);
        this.pushEvent('nest_lost', unit.owner, `${owner.name} lost a nest`, true);
      }
      const remaining = this.queensOf(unit.owner).filter((queen) => queen.id !== unit.id).length;
      if (unit.foundingSite !== null) {
        // Worth calling out separately: 200 food and 60 seconds of build time
        // were intercepted before they ever became a nest.
        owner.queensLostInTransit++;
        this.pushEvent(
          'queen_death',
          unit.owner,
          `${owner.name} lost a queen in transit before she could found a nest, ${remaining} left`,
          true,
        );
      } else {
        this.pushEvent('queen_death', unit.owner, `${owner.name} lost a queen, ${remaining} left`, true);
      }
    } else {
      this.pushEvent('unit_lost', unit.owner, `${owner.name} lost a ${unit.type}`, false);
    }
    this.rebuildRoster();
  }

  private checkAlarms(): void {
    for (const colony of this.colonies) {
      const frac = this.lowestQueenHealth(colony.id);
      if (this.isAlive(colony.id)) {
        for (const threshold of [0.9, 0.6, 0.3]) {
          if (this.queenHpFlag[colony.id] > threshold && frac <= threshold) {
            this.queenHpFlag[colony.id] = threshold;
            this.pushEvent(
              'queen_damaged',
              colony.id,
              `a ${colony.name} queen is down to ${Math.round(frac * 100)}% health`,
              true,
            );
          }
        }
      }

      let enemiesAtHome = 0;
      const seen = new Set<number>();
      for (const nest of colony.nests) {
        for (const enemy of this.unitsNear(colony.id === 0 ? 1 : 0, nest, NEST_RADIUS + 6)) {
          if (!seen.has(enemy.id)) {
            seen.add(enemy.id);
            enemiesAtHome++;
          }
        }
      }
      if (enemiesAtHome >= 2 && this.tick - this.lastNestAlarmTick[colony.id] > 20 * TICKS_PER_SECOND) {
        this.lastNestAlarmTick[colony.id] = this.tick;
        this.pushEvent('nest_under_attack', colony.id, `${enemiesAtHome} enemies inside a ${colony.name} nest`, true);
      }

      const workers = this.countUnits(colony.id, 'worker');
      if (
        colony.food < 5 &&
        workers <= 2 &&
        this.tick - this.lastStarveAlarmTick[colony.id] > 30 * TICKS_PER_SECOND
      ) {
        this.lastStarveAlarmTick[colony.id] = this.tick;
        this.pushEvent('starving', colony.id, `${colony.name} is starving: ${workers} workers, ${Math.floor(colony.food)} food`, true);
      }
    }
  }

  // --------------------------------------------------------------- deposit hook

  /**
   * A queen consumes one of her own units. Its full food cost, plus anything it
   * was carrying, goes straight back to the stockpile, so the map stays a closed
   * system and this is a conversion rather than a loss. It is not a death: no
   * corpse, no kill for the enemy, and it is not counted as a loss.
   */
  recycleUnit(unit: Unit): void {
    const colony = this.colonies[unit.owner];
    colony.food += UNIT_STATS[unit.type].cost + unit.carrying;
    colony.unitsRecycled[unit.type]++;
    this.units.delete(unit.id);
    for (const other of this.units.values()) {
      if (other.targetEnemyId === unit.id) other.targetEnemyId = null;
    }
    this.rebuildRoster();
  }

  /**
   * Called by ai.ts when a hauling worker reaches a nest. The stockpile is
   * shared across the colony rather than held per nest, so the value of a new
   * nest is a shorter round trip and an extra build slot, not a separate purse.
   */
  /**
   * Drop a carried load on the ground as a pile instead of banking it.
   *
   * A relocation, not a deposit: the energy stays on the map and merges into any
   * pile already there. Nothing is created or destroyed, so the closed system is
   * untouched, and it is strictly slower than hauling because the same trip ends
   * with the food still needing collecting.
   */
  dropAsPile(unit: Unit): void {
    if (unit.carrying <= 0) return;
    const colony = this.colonies[unit.owner];
    colony.foodRelocated += unit.carrying;
    this.addFoodPile({ x: unit.x, y: unit.y }, unit.carrying, 'seeds');
    unit.carrying = 0;
    unit.relocateTo = null;
  }

  depositFood(unit: Unit): void {
    const colony = this.colonies[unit.owner];
    colony.food += unit.carrying;
    colony.lifetimeFoodGathered += unit.carrying;
    unit.carrying = 0;
  }

  atNest(unit: Unit): boolean {
    return this.distanceToNearestNest(unit.owner, unit) <= DEPOSIT_RADIUS;
  }

  // ------------------------------------------------------------------- scoring

  /**
   * Score, used when a match reaches the time limit. Stated in the UI and the
   * match summary so it is never a mystery why a colony won.
   *   150 per living queen, so a colony that expanded scores for every queen
   *   +4 per worker, +10 per soldier
   *   +0.1 per food in the stockpile, deliberately low so hoarding does not win
   *   +0.25 per food gathered over the whole match
   */
  scoreOf(colony: ColonyId): ScoreBreakdown {
    const c = this.colonies[colony];
    const queens = this.queensOf(colony).length * SCORE_WEIGHTS.queenAlive;
    const workers = this.countUnits(colony, 'worker') * SCORE_WEIGHTS.worker;
    const soldiers = this.countUnits(colony, 'soldier') * SCORE_WEIGHTS.soldier;
    const foodStockpile = c.food * SCORE_WEIGHTS.foodStockpile;
    const lifetimeFood = c.lifetimeFoodGathered * SCORE_WEIGHTS.lifetimeFood;
    return {
      queens,
      workers,
      soldiers,
      foodStockpile,
      lifetimeFood,
      total: queens + workers + soldiers + foodStockpile + lifetimeFood,
    };
  }

  /**
   * A snapshot of everything that has to change for a match to be going
   * anywhere. Unit counts are included, but only a swing beyond the tolerance
   * counts, so a colony that loses a worker and rebuilds it has not progressed.
   */
  private positionSignature(): number[] {
    const signature: number[] = [];
    for (const id of [0, 1] as ColonyId[]) {
      signature.push(
        this.colonies[id].nests.length,
        this.queensOf(id).length,
        Math.round(this.lowestQueenHealth(id) * 100),
        this.countUnits(id, 'worker') + this.countUnits(id, 'soldier'),
      );
    }
    return signature;
  }

  private checkProgress(): void {
    if (this.stalemateWindowTicks <= 0) return;
    const current = this.positionSignature();
    const anchor = this.positionAnchor.signature;
    if (anchor.length === 0) {
      this.positionAnchor = { tick: this.tick, signature: current };
      return;
    }
    // Indices 3 and 7 are unit counts, which get a tolerance. Everything else
    // must match exactly.
    let moved = false;
    for (let i = 0; i < current.length; i++) {
      const isUnitCount = i === 3 || i === 7;
      const delta = Math.abs(current[i] - anchor[i]);
      if (isUnitCount ? delta > STALEMATE_UNIT_TOLERANCE : delta > 0) {
        moved = true;
        break;
      }
    }
    if (moved) this.positionAnchor = { tick: this.tick, signature: current };
  }

  private checkOutcome(): void {
    const aAlive = this.isAlive(0);
    const bAlive = this.isAlive(1);
    const breakdown: [ScoreBreakdown, ScoreBreakdown] = [this.scoreOf(0), this.scoreOf(1)];
    const scores: [number, number] = [breakdown[0].total, breakdown[1].total];

    const finish = (
      winner: ColonyId | null,
      reason: 'colony_eliminated' | 'time_limit' | 'both_colonies_eliminated' | 'stalemate',
    ) => {
      this.outcome = { status: 'finished', winner, reason, scores, scoreBreakdown: breakdown };
      const label =
        winner === null ? 'Draw' : `${this.colonies[winner].name} wins`;
      this.pushEvent(
        'match_end',
        winner,
        `${label} by ${reason.replace(/_/g, ' ')} (${scores[0].toFixed(0)} vs ${scores[1].toFixed(0)})`,
        true,
      );
    };

    if (!aAlive && !bAlive) {
      finish(scores[0] === scores[1] ? null : scores[0] > scores[1] ? 0 : 1, 'both_colonies_eliminated');
      return;
    }
    if (!aAlive) return finish(1, 'colony_eliminated');
    if (!bAlive) return finish(0, 'colony_eliminated');
    if (this.tick >= this.timeLimitTicks) {
      finish(scores[0] === scores[1] ? null : scores[0] > scores[1] ? 0 : 1, 'time_limit');
      return;
    }
    // Neither colony can make progress, so the clock is only burning compute.
    // Resolved on score exactly as the time limit would be.
    if (this.stalemateWindowTicks > 0 && this.tick - this.positionAnchor.tick >= this.stalemateWindowTicks) {
      this.pushEvent(
        'stalemate',
        null,
        `no material change for ${Math.round(this.stalemateWindowTicks / TICKS_PER_SECOND)}s, calling it a stalemate`,
        true,
      );
      finish(scores[0] === scores[1] ? null : scores[0] > scores[1] ? 0 : 1, 'stalemate');
    }
  }

  /**
   * Total energy on the map: food on the ground, food in transit, food banked,
   * and the energy embodied in every living unit and every part-built one.
   *
   * With CORPSE_VALUE_FRACTION at 1.0 this is invariant for the whole match.
   * The self test asserts that, which is what makes "closed system" a checked
   * property rather than an intention.
   */
  totalEnergy(): number {
    let total = 0;
    for (const source of this.food.values()) total += source.amount;
    for (const colony of this.colonies) total += colony.food;
    for (const unit of this.units.values()) {
      total += UNIT_STATS[unit.type].cost + unit.carrying;
      if (unit.build) total += UNIT_STATS[unit.build.type].cost;
    }
    return total;
  }

  /** Cheap state fingerprint, used by the self test to prove determinism. */
  fingerprint(): string {
    let h = 2166136261;
    const mix = (n: number) => {
      h ^= Math.round(n * 1000) | 0;
      h = Math.imul(h, 16777619);
    };
    mix(this.tick);
    for (const colony of this.colonies) {
      mix(colony.food);
      mix(colony.lifetimeFoodGathered);
      mix(colony.kills);
      mix(colony.nests.length);
      for (const nest of colony.nests) {
        mix(nest.id);
        mix(nest.x);
        mix(nest.y);
      }
    }
    for (const unit of [...this.units.values()].sort((a, b) => a.id - b.id)) {
      mix(unit.id);
      mix(unit.x);
      mix(unit.y);
      mix(unit.hp);
      mix(unit.carrying);
    }
    for (const source of [...this.food.values()].sort((a, b) => a.id - b.id)) {
      mix(source.id);
      mix(source.amount);
    }
    return (h >>> 0).toString(16);
  }
}

/** Grid cell size in map cells, and a stride large enough to avoid key collisions. */
const BUCKET_SIZE = 16;
const BUCKET_STRIDE = 4096;

function bucketKey(x: number, y: number): number {
  return Math.floor(x / BUCKET_SIZE) * BUCKET_STRIDE + Math.floor(y / BUCKET_SIZE);
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function fmt(n: number): string {
  return n.toFixed(0);
}

function describeRule(set?: Partial<StrategyConfig>): string {
  if (!set) return 'no change';
  return Object.entries(set)
    .map(([key, value]) =>
      typeof value === 'object' && value !== null
        ? `${key}=${(value as any).worker?.toFixed?.(2)}w/${(value as any).soldier?.toFixed?.(2)}s`
        : `${key}=${typeof value === 'number' ? Number(value).toFixed(2).replace(/\.00$/, '') : String(value)}`,
    )
    .join(' ');
}

/** Used when a caller does not supply definitions, e.g. quick smoke tests. */
export function fallbackDefinition(preset: keyof typeof PRESETS): BehaviourDefinition {
  return parseDefinition({
    id: preset,
    name: `preset:${preset}`,
    author: 'hand',
    notes: 'built-in preset, no rules',
    base: PRESETS[preset],
    rules: [],
  }).definition;
}

export { ARRIVE_EPSILON, DT, MAP_HEIGHT, MAP_WIDTH };
