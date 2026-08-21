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
 * A match ends as a stalemate when nothing material has changed for this long.
 *
 * "Material" cannot just mean "a unit died": two colonies parked at their
 * population ceiling still trade the odd worker every few minutes while being
 * completely stagnant, so a death-based check would keep resetting and never
 * fire. Instead the detector anchors on a signature of the strategic position
 * (nests, queens, weakest queen health, and unit counts within a tolerance) and
 * fires only when that signature has not moved at all.
 */
export const STALEMATE_WINDOW_SECONDS = 600;
/** Unit count swing, either side, that counts as the position having moved. */
export const STALEMATE_UNIT_TOLERANCE = 2;

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
    maxHp: 2500,
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

/**
 * Killing a queen is meant to be a siege, not a drive-by.
 *
 * Health alone cannot achieve that, because time to kill is health divided by
 * damage per second, so a bigger attacking army simply scales the duration back
 * down. A twelve soldier ball against the old 500 health queen killed her in
 * under five seconds.
 *
 * So the number of attackers that can reach a queen at once is capped: think of
 * it as how many ants fit in the nest entrance. That puts a floor on how long an
 * assault must be sustained, whatever the size of the army outside, and the
 * attacker has to survive at the nest for all of it.
 *
 * Armour is a flat reduction per hit, which mainly matters for workers: it takes
 * a real army to hurt a queen rather than a swarm of labourers.
 */
export const QUEEN_MAX_ATTACKERS = 6;
export const QUEEN_ARMOUR = 2;

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
 * Workers and soldiers each nest can support. Queens do not count against it,
 * and a colony at its ceiling can still build a queen in order to raise it.
 *
 * This is a compute and legibility bound, not a balance lever. Measured on the
 * nine starter definitions over 144 matches, this value at 100 produces an
 * identical field to having no cap at all: same win rates, same 52 eliminations,
 * margins within rounding. What it buys is a bounded worst case. Uncapped, a
 * single match reached 1,169 units in one colony and took 20.9 seconds instead
 * of 3.3, which is unwatchable in the viewer and hurts every round robin.
 *
 * It was previously 40, which did shape the field: worth 19 points of win rate
 * to preset-blockade and 9 to preset-turtle. That is a lot of influence for a
 * number originally chosen to stop the frame rate dying, so expansion is now
 * decisive because of the mechanics it was given deliberately, the extra build
 * slot and the shorter haul, rather than because of a headcount.
 */
export const UNITS_PER_NEST = 100;
/**
 * Recycling only happens under population pressure, at or above this fraction of
 * the ceiling.
 *
 * Below the ceiling, converting workers into soldiers by culling them is
 * strictly worse than just building soldiers: you throw away the build time
 * already spent. Recycling is only the right move when you cannot build what you
 * want because you have no room, which is exactly the situation this gates on.
 * It also stops the knob being a footgun early on, when a colony of five workers
 * would otherwise cull itself to hit a 50/50 target.
 */
export const RECYCLE_PRESSURE_FRACTION = 0.9;
/** How far composition must be off target before anything is culled. */
export const RECYCLE_TOLERANCE_FRACTION = 0.05;
/**
 * Units sent to be recycled per decision at recycle_surplus 1.0, scaled down by
 * the knob. This is what stops a colony mass culling itself in one second, and
 * it is why the knob reads as a rate rather than a switch.
 */
export const RECYCLE_MAX_PER_DECISION = 4;
export const DEPOSIT_RADIUS = 2.5;
/** Fraction of max hp regenerated per second while inside your own nest. */
export const NEST_REGEN_PER_SECOND = 0.03;

/**
 * Ants take up space and push each other aside.
 *
 * Separation steering rather than hard collision: each unit is nudged away from
 * neighbours it overlaps, blended with wherever it was already going. Hard
 * collision jams at chokepoints and can deadlock, which matters because every
 * colony funnels its workers into a deposit radius of 2.5 cells.
 *
 * Displacements are computed for every unit before any of them are applied. Done
 * in place, the result would depend on the order units happened to be iterated,
 * and determinism is the property this whole project rests on.
 */
/**
 * Ants have to turn around.
 *
 * Movement used to step straight at a target, so a unit could reverse direction
 * between two ticks for free. Now it turns toward the bearing it wants at a
 * limited rate and travels along the heading it actually has, which costs tempo:
 * a target behind you takes time to face, journeys are slightly longer than the
 * straight line, and a soldier reacting to a new attacker pays for the swing.
 *
 * Radians per second. A worker turns quickly, a soldier is more committed, and a
 * founding queen is ponderous.
 */
export const TURN_RATE: Record<UnitType, number> = {
  queen: 0.8,
  worker: 4.5,
  soldier: 2.6,
};
/**
 * Speed is scaled by how well a unit is aligned with where it wants to go, so it
 * slows into a turn. Without this a unit that cannot turn tightly enough orbits
 * a nearby target forever, which is the classic failure of a turn rate.
 */
export const TURN_SPEED_FLOOR = 0.35;

export const UNIT_RADIUS: Record<UnitType, number> = {
  queen: 1.6,
  worker: 0.45,
  soldier: 0.6,
};
/** How hard an overlap pushes, as a fraction of the overlap per application. */
export const SEPARATION_STRENGTH = 0.5;
/** Cap per application, so a dense crowd cannot fling a unit across the map. */
export const SEPARATION_MAX_STEP = 0.35;
/** Ticks between separation passes. Every other tick is smooth enough. */
export const SEPARATION_INTERVAL = 2;

/**
 * Fog of war: how long a colony remembers something it has stopped seeing.
 *
 * Beliefs expire so that scouting keeps paying. Without expiry a single early
 * sighting would be remembered for the rest of the match, and stale information
 * would be indistinguishable from current information.
 */
export const INTEL_MEMORY_SECONDS = 120;
/** Ticks between visibility passes. Vision does not need resolving every tick. */
export const INTEL_INTERVAL = 3;

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
 * How far from its own nests a colony will post soldiers on guard_food duty.
 * Guards do not haul, so they can range further than workers, but a guard
 * standing on a pile 150 cells from home is a soldier that will be killed alone
 * and never supported. Same lesson as CONTEST_MAX_HAUL above.
 */
export const GUARD_MAX_RANGE = 110;
/** Below this, a pile is not worth posting a soldier on. */
export const GUARD_MIN_FOOD = 40;
/** Soldiers assigned per guarded pile, so a guard is not killed alone. */
export const GUARDS_PER_PILE = 2;
/**
 * Most piles a colony will spread guards across at once. Coverage scales with
 * army size up to this: guarding three piles out of the sixty on the map denies
 * an opponent essentially nothing, which is what the first version of this
 * posture measured.
 */
export const MAX_GUARDED_PILES = 6;
/** Radius in which enemy workers count as using a pile. */
export const GUARD_ACTIVITY_RADIUS = 15;
/**
 * How far from its post a guard will fight. This is a leash, and it is the whole
 * point of the posture: without it a guard chases the first worker it sees and
 * drifts across the map, which measured at 2 of 17 soldiers actually standing on
 * the pile they were meant to be denying, several of them 11 cells from the
 * enemy nest.
 */
export const GUARD_LEASH = 12;
/**
 * A guard this close to its post has arrived and stops.
 *
 * Without it, every guard drives at the exact centre of the pile, separation
 * pushes them apart, and they walk straight back in: they oscillate instead of
 * intercepting. The index-based ring offset this replaces was doing more than
 * stopping them drawing on top of each other, it was giving each guard a
 * distinct destination. This does the same job as a behaviour rather than as
 * arithmetic on a unit id.
 */
export const GUARD_HOLD_RADIUS = 3;
/**
 * Caps on how much the denial term can swing a post choice. Uncapped, the pile
 * with the highest denial value is always the one touching the enemy's nest,
 * which is not a guard post, it is a funeral. Supportability has to dominate.
 */
export const GUARD_DENIAL_CAP = 40;
export const GUARD_OWN_HALF_PENALTY_CAP = 30;

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

/**
 * Food types, differing in energy density.
 *
 * Density is energy per unit of carrying volume, so a worker fills the same
 * capacity and brings home more from a rich pile. It is deliberately not a
 * multiplier applied at deposit: that would create energy out of nothing and
 * break the closed system the self test asserts. The pile loses exactly what the
 * worker delivers.
 *
 * Richer types come in smaller piles, so "a small rich pile nearby against a big
 * thin one further out" is a real decision rather than an obvious one.
 */
export interface FoodTypeStats {
  /** Energy per unit of a worker's carrying volume. */
  density: number;
  /** Multiplier on the generated pile size. */
  sizeFactor: number;
  /** Share of generated piles, need not sum to exactly 1. */
  weight: number;
}

export const FOOD_TYPES = ['leaf_litter', 'seeds', 'honeydew'] as const;
export type FoodType = (typeof FOOD_TYPES)[number];

export const FOOD_TYPE_STATS: Record<FoodType, FoodTypeStats> = {
  leaf_litter: { density: 0.6, sizeFactor: 1.6, weight: 0.35 },
  seeds: { density: 1.0, sizeFactor: 1.0, weight: 0.45 },
  honeydew: { density: 1.9, sizeFactor: 0.5, weight: 0.2 },
};

/**
 * Ferrying a pile somewhere safer instead of hauling it home.
 *
 * It must not beat hauling on efficiency, or it is a free upgrade rather than a
 * choice: a relocating worker makes the same trip and ends with the food still
 * on the ground, so it is strictly slower in calories per second. What it buys is
 * risk. Food beyond hauling range, or sitting where the enemy will take it, is
 * worth moving somewhere your workers can come back to.
 */
export const RELOCATE_MIN_PILE = 60;
/** How close to a nest a relocated pile is dropped. */
export const RELOCATE_DROP_DISTANCE = 14;
/** A pile this far from our nests is a candidate for moving closer. */
export const RELOCATE_MIN_DISTANCE = CONTEST_MAX_HAUL;

/** Corpses are flesh: ordinary density, so a battlefield is worth a normal trip. */
export const CORPSE_DENSITY = 1.0;

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
