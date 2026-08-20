import type { UnitType } from './types.js';

/**
 * All balance numbers live here. These are deliberately rough placeholders,
 * tuned only enough that matches are not degenerate. Expect to change them
 * after a few test matches; nothing else in the sim hardcodes a stat.
 */

export const TICKS_PER_SECOND = 10;
export const DT = 1 / TICKS_PER_SECOND;

/**
 * The map is deliberately large: a colony needs room to found several nests per
 * side, and travel time is what makes expanding toward distant food a real
 * decision rather than a free upgrade.
 */
export const MAP_WIDTH = 200;
export const MAP_HEIGHT = 200;

/**
 * Default match length in sim seconds (25 hours of sim time).
 *
 * Set this high deliberately: the intent is that matches are decided by one
 * colony eliminating the other rather than by the clock running out. See the
 * note in README under Match length for what that means in practice, since the
 * map's food is exhausted long before this limit.
 */
export const DEFAULT_TIME_LIMIT_SECONDS = 90000;

export interface UnitStats {
  maxHp: number;
  /** Cells per sim second. */
  speed: number;
  /** Damage per hit. */
  attack: number;
  /** Seconds between hits. */
  attackCooldown: number;
  /** Cells. */
  attackRange: number;
  /** Cells at which this unit discovers food sources. */
  vision: number;
  carryCapacity: number;
  /** Food gathered per second while standing on a source. */
  gatherRate: number;
  /** Food the queen spends to produce this unit. */
  cost: number;
  /** Sim seconds to produce. */
  buildTime: number;
}

export const UNIT_STATS: Record<UnitType, UnitStats> = {
  queen: {
    maxHp: 500,
    // A new queen walks to a founding site, slowly and vulnerably, then settles
    // and never moves again. The founder of the colony starts already settled.
    speed: 1.1,
    attack: 4,
    attackCooldown: 1.0,
    attackRange: 1.6,
    vision: 12,
    carryCapacity: 0,
    gatherRate: 0,
    // Expensive on both axes. 200 food is 20 workers, and 60 seconds of build
    // time blocks everything else that queen could have produced.
    cost: 200,
    buildTime: 60,
  },
  worker: {
    maxHp: 25,
    speed: 3.6,
    attack: 3,
    attackCooldown: 1.0,
    attackRange: 1.0,
    vision: 12,
    carryCapacity: 10,
    gatherRate: 5,
    cost: 10,
    buildTime: 4,
  },
  soldier: {
    maxHp: 80,
    speed: 2.4,
    attack: 9,
    attackCooldown: 1.0,
    attackRange: 1.5,
    vision: 14,
    carryCapacity: 2,
    gatherRate: 1,
    cost: 30,
    buildTime: 12,
  },
};

/**
 * 1v1 a soldier beats a worker comfortably (3 hits to kill, taking 9 damage
 * back). It takes roughly 4 to 5 workers to kill one soldier, and 4 workers
 * cost 40 food against the soldier's 30, so quality wins the straight fight
 * while numbers stay economically viable. That tradeoff is the point.
 */

/** Radius around a nest that counts as "at home" for deposits and regen. */
export const NEST_RADIUS = 4;
/**
 * Minimum distance between two nests of the same colony when picking a founding
 * site, and minimum distance a new nest must keep from any enemy nest.
 */
export const MIN_NEST_SEPARATION = 34;
export const MIN_ENEMY_NEST_DISTANCE = 30;
/** Cap on nests per colony, a backstop rather than a balance lever. */
export const MAX_NESTS_PER_COLONY = 6;
/**
 * Workers and soldiers each nest can support. This is the second reason to
 * expand, alongside the extra build slot: a colony on one nest hits a hard
 * ceiling no matter how much food it has. Queens do not count against it, and a
 * colony at its ceiling can still build a queen in order to raise it.
 */
export const UNITS_PER_NEST = 40;
export const DEPOSIT_RADIUS = 2.5;
/** Fraction of max hp regenerated per second while inside your own nest. */
export const NEST_REGEN_PER_SECOND = 0.03;

/** Distance at which a unit is considered to have arrived at a move target. */
export const ARRIVE_EPSILON = 0.6;
/** Distance at which a worker can gather from a source. */
export const GATHER_RADIUS = 1.0;
/**
 * How far from its own nests a colony using contest_enemy_food will reach.
 * Without a cap that priority sends workers to whatever food sits closest to
 * the enemy nest, which on a map this size is a walk to a funeral: measured at
 * 370 food hauled in a whole match against an opponent's 18,000. Capping the
 * haul turns it into contesting the middle ground, which is what it should
 * always have meant, and founding a forward nest genuinely extends the reach.
 */
export const CONTEST_MAX_HAUL = 100;

/**
 * Corpses drop this fraction of the unit's food cost, plus whatever it carried.
 *
 * At 1.0 the map is a closed system: the total energy on it never changes. Food
 * moves between four places, and nothing is ever created or destroyed:
 *
 *   food piles on the ground  <->  food carried by workers
 *                             <->  a colony's stockpile
 *                             <->  energy embodied in living units
 *
 * A unit is energy borrowed from the stockpile, and its death returns every
 * point of it to the ground. Anything other than 1.0 makes combat a net drain
 * on the world, so the conservation check in the self test will fail. Change it
 * only if you intend that.
 */
export const CORPSE_VALUE_FRACTION = 1.0;
/**
 * Corpses do not decay. Ground that has been fought over accumulates biomass
 * permanently, which makes an old battlefield worth holding and worth denying.
 *
 * A single worker corpse is only 4 food, so hundreds of individual crumbs would
 * be scattered junk that drags workers into long trips for a fraction of a load.
 * Corpses landing within this radius of an existing pile merge into it instead,
 * so a battle leaves a few substantial piles where the fighting was rather than
 * a hundred specks, and the number of food sources stays bounded.
 */
export const CORPSE_MERGE_RADIUS = 6;

export const STARTING_FOOD = 40;
export const STARTING_WORKERS = 5;

/** Map generation. Scaled with the map area so food density stays comparable. */
export const FOOD_CLUSTER_PAIRS = 30; // mirrored, so 60 sources plus starters
export const FOOD_CLUSTER_MIN = 180;
export const FOOD_CLUSTER_MAX = 520;
/** Each colony gets one guaranteed easy source near its first nest. */
export const STARTER_FOOD_AMOUNT = 260;
export const STARTER_FOOD_DISTANCE = 14;

/**
 * Scoring weights for a match that reaches the time limit.
 *
 * Unspent food is worth very little on purpose. On a map this size a passive
 * colony can bank thousands of food it never converts into anything, and at a
 * weight of 1 that hoard swamped every other term, so the score rewarded
 * hoarding over playing. Food that was actually gathered still counts, through
 * lifetimeFood, and queens are weighted highest because keeping them alive is
 * the real objective.
 */
export const SCORE_WEIGHTS = {
  queenAlive: 150,
  worker: 4,
  soldier: 10,
  foodStockpile: 0.1,
  lifetimeFood: 0.25,
};
