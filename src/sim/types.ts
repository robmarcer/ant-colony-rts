import type { FoodType } from './config.js';
import type { BehaviourDefinition } from './definition.js';
import type { StrategyConfig } from './strategy.js';

export type ColonyId = 0 | 1;
export type UnitType = 'queen' | 'worker' | 'soldier';

export type UnitState =
  | 'idle'
  | 'moving'      // travelling to a food target
  | 'gathering'
  | 'returning'   // hauling food home
  | 'fighting'
  | 'retreating'  // hurt, heading home to regen
  | 'scouting'    // heading to an unexplored point
  | 'guarding'    // soldier holding position near a nest
  | 'founding'    // new queen walking to a site to start a nest
  | 'recycling'   // heading home to be consumed by a queen
  | 'relocating'; // carrying food to a safer spot rather than into the stockpile

export interface Vec {
  x: number;
  y: number;
}

export interface Unit {
  id: number;
  type: UnitType;
  owner: ColonyId;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  state: UnitState;
  carrying: number;
  /** Food source (cluster or corpse) this unit is currently working. */
  targetFoodId: number | null;
  targetEnemyId: number | null;
  moveTo: Vec | null;
  /** Seconds until this unit can attack again. */
  attackCooldown: number;
  bornTick: number;
  /** Tick this unit last took damage, used to decide if a worker fights back. */
  lastDamagedTick: number;
  /**
   * Queens only. While set, this queen is walking to found a nest and is
   * mobile and vulnerable. Cleared once the nest exists, after which the queen
   * never moves again.
   */
  foundingSite: Vec | null;
  /** Queens only. The nest this queen sits in, once settled. */
  nestId: number | null;
  /** Queens only. Her own build slot; every queen produces independently. */
  build: BuildJob | null;
  /**
   * Soldiers on guard_food duty: the pile this one is posted to. Sticky, because
   * choosing the post fresh every tick made guards chase whichever pile happened
   * to have the most enemy workers that instant and never actually hold one.
   */
  guardFoodId: number | null;
  /** Marked for recycling: walk home and be consumed, freeing population room. */
  recycling: boolean;
  /**
   * Where this worker is dropping its load as a pile, rather than depositing it.
   * Set when a colony decides a pile is worth moving rather than banking.
   */
  relocateTo: Vec | null;
}

/**
 * A nest. A colony starts with one and can found more by producing new queens.
 * Nests are production sites and drop-off points; the food stockpile itself is
 * shared across the whole colony.
 */
export interface Nest {
  id: number;
  owner: ColonyId;
  x: number;
  y: number;
  /** The queen sitting here. A nest without a queen is destroyed. */
  queenId: number;
  foundedTick: number;
}

/**
 * A pile of food on the map. Corpses are modelled as food sources with
 * kind 'corpse', so worker targeting logic does not need a second code path.
 * Neither kind decays; the only way food leaves the map is a worker hauling it.
 */
export interface FoodSource {
  id: number;
  kind: 'cluster' | 'corpse';
  /** Corpses are always ordinary density; clusters vary by type. */
  type: FoodType;
  /** Energy per unit of a worker's carrying volume. */
  density: number;
  x: number;
  y: number;
  amount: number;
  /** Peak size this pile has reached, used only for rendering depletion. */
  initialAmount: number;
  /** How many units died into this pile. Corpses only, for the match log. */
  deaths: number;
}

/**
 * What a colony believes about one enemy unit it has seen. Beliefs are what rules
 * and state summaries read: they can be stale, and they expire.
 */
export interface KnownEnemy {
  unitId: number;
  type: UnitType;
  x: number;
  y: number;
  hpFraction: number;
  /** True while the unit was a queen walking to found a nest when last seen. */
  founding: boolean;
  lastSeenTick: number;
}

/** A remembered enemy nest. Home nests are known from the start. */
export interface KnownNest {
  nestId: number;
  x: number;
  y: number;
  lastSeenTick: number;
}

/** One entry in a colony's shared memory of where food is. */
export interface KnownFood {
  foodId: number;
  x: number;
  y: number;
  /** What the colony believes is left, refreshed whenever a worker sees it. */
  estAmount: number;
  /** Remembered along with the pile, so targeting can weigh energy per trip. */
  density: number;
  lastSeenTick: number;
  distanceFromNest: number;
}

export interface BuildJob {
  type: UnitType;
  secondsRemaining: number;
  totalSeconds: number;
}

export interface Colony {
  id: ColonyId;
  name: string;
  /** Where this colony's first queen settled. Never changes, used for symmetry. */
  homeNest: Vec;
  nests: Nest[];
  /** Food in the stockpile, spendable by the queen. */
  food: number;
  lifetimeFoodGathered: number;
  /** The behaviour file this colony was handed before the match started. */
  definition: BehaviourDefinition;
  /** Base knobs with all currently matching rules layered on top. */
  strategy: StrategyConfig;
  /** Ids of the rules currently firing, for the HUD and the match log. */
  activeRuleIds: string[];
  /** Tick each active rule first fired, used to honour min_hold_seconds. */
  ruleActiveSince: Map<string, number>;
  strategyChangedTick: number;
  knownFood: Map<number, KnownFood>;
  /** Enemy units this colony has seen and not yet forgotten. */
  knownEnemies: Map<number, KnownEnemy>;
  /** Enemy nests this colony knows about, seeded with their home nest. */
  knownEnemyNests: Map<number, KnownNest>;
  /** Tick of the most recent enemy sighting, for intel age. */
  lastSightingTick: number;
  unitsProduced: Record<UnitType, number>;
  nestsFounded: number;
  /** Own units consumed by a queen to change the army's composition. */
  unitsRecycled: Record<UnitType, number>;
  /** Energy ferried to a safer pile rather than banked. */
  foodRelocated: number;
  /** Queens killed while walking to a site, i.e. expansions that never landed. */
  queensLostInTransit: number;
  unitsLost: Record<UnitType, number>;
  /** Rolling count of losses, decayed each tick, used to trigger LLM re-polls. */
  recentLosses: number;
  kills: number;
}

export type MatchEventType =
  | 'match_start'
  | 'first_contact'
  | 'unit_lost'
  | 'queen_damaged'
  | 'queen_death'
  | 'nest_founded'
  | 'nest_lost'
  | 'queen_walking'
  | 'food_depleted'
  | 'strategy_change'
  | 'rule_activated'
  | 'rule_deactivated'
  | 'nest_under_attack'
  | 'starving'
  | 'stalemate'
  | 'recycled'
  | 'match_end';

export interface MatchEvent {
  tick: number;
  simSeconds: number;
  type: MatchEventType;
  colony: ColonyId | null;
  /** Human readable one-liner for the UI timeline and the LLM state summary. */
  text: string;
  /** Events flagged major show up in the end-of-match timeline. */
  major: boolean;
}

export type MatchOutcome =
  | { status: 'running' }
  | {
      status: 'finished';
      winner: ColonyId | null; // null means a draw on score
      reason: 'colony_eliminated' | 'time_limit' | 'both_colonies_eliminated' | 'stalemate';
      scores: [number, number];
      scoreBreakdown: [ScoreBreakdown, ScoreBreakdown];
    };

export interface ScoreBreakdown {
  queens: number;
  workers: number;
  soldiers: number;
  foodStockpile: number;
  lifetimeFood: number;
  total: number;
}
