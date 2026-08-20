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
  | 'founding';   // new queen walking to a site to start a nest

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
  x: number;
  y: number;
  amount: number;
  /** Peak size this pile has reached, used only for rendering depletion. */
  initialAmount: number;
  /** How many units died into this pile. Corpses only, for the match log. */
  deaths: number;
}

/** One entry in a colony's shared memory of where food is. */
export interface KnownFood {
  foodId: number;
  x: number;
  y: number;
  /** What the colony believes is left, refreshed whenever a worker sees it. */
  estAmount: number;
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
  strategyChangedTick: number;
  knownFood: Map<number, KnownFood>;
  unitsProduced: Record<UnitType, number>;
  nestsFounded: number;
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
