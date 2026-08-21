import { Rng } from './rng.js';
import {
  OBSTACLE_GAP,
  OBSTACLE_MAX_RADIUS,
  OBSTACLE_MIN_RADIUS,
  OBSTACLE_NEST_CLEARANCE,
  OBSTACLE_PAIRS,
  FOOD_TYPES,
  FOOD_TYPE_STATS,
  FOOD_CLUSTER_MAX,
  FOOD_CLUSTER_MIN,
  FOOD_CLUSTER_PAIRS,
  MAP_HEIGHT,
  MAP_WIDTH,
  STARTER_FOOD_AMOUNT,
  STARTER_FOOD_DISTANCE,
} from './config.js';
import type { FoodSource, Obstacle, Vec } from './types.js';

/** Where each colony's founding queen starts, point mirrored about the centre. */
export const HOME_NEST_POSITIONS: [Vec, Vec] = [
  { x: 40, y: 40 },
  { x: 160, y: 160 },
];

/** Point mirror through the map centre. Nest A maps exactly onto nest B. */
function mirror(p: Vec): Vec {
  return { x: MAP_WIDTH - p.x, y: MAP_HEIGHT - p.y };
}

function dist(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Generate rocks, in mirrored pairs like the food, so both colonies face
 * identical terrain.
 *
 * Rocks never touch and always leave a gap wider than an ant can walk through,
 * which is what guarantees no enclosed pockets and therefore no unreachable
 * ground. Nests get extra clearance so a colony is never born hemmed in.
 */
export function generateObstacles(rng: Rng, nextId: () => number): Obstacle[] {
  const obstacles: Obstacle[] = [];
  let placed = 0;
  let attempts = 0;

  while (placed < OBSTACLE_PAIRS && attempts < 20000) {
    attempts++;
    const radius = rng.range(OBSTACLE_MIN_RADIUS, OBSTACLE_MAX_RADIUS);
    const p: Vec = {
      x: rng.range(radius + 4, MAP_WIDTH - radius - 4),
      y: rng.range(radius + 4, MAP_HEIGHT - radius - 4),
    };
    // One side of the anti-diagonal, so a rock never lands on its own mirror.
    if (p.x + p.y > MAP_WIDTH - 10) continue;
    const m = mirror(p);

    const clearOfNests = HOME_NEST_POSITIONS.every(
      (nest) =>
        dist(p, nest) > radius + OBSTACLE_NEST_CLEARANCE && dist(m, nest) > radius + OBSTACLE_NEST_CLEARANCE,
    );
    if (!clearOfNests) continue;

    const clearOfRocks = obstacles.every(
      (other) =>
        dist(p, other) > radius + other.radius + OBSTACLE_GAP &&
        dist(m, other) > radius + other.radius + OBSTACLE_GAP,
    );
    if (!clearOfRocks) continue;
    if (dist(p, m) < radius * 2 + OBSTACLE_GAP) continue;

    obstacles.push({ id: nextId(), x: p.x, y: p.y, radius });
    obstacles.push({ id: nextId(), x: m.x, y: m.y, radius });
    placed++;
  }

  return obstacles;
}

/**
 * Generate food. Every source is created as a mirrored pair, so the two
 * colonies face an identical problem and any difference in outcome is down to
 * the strategies rather than the map. This matters for model comparison.
 */
export function generateFood(rng: Rng, nextId: () => number, obstacles: Obstacle[] = []): FoodSource[] {
  const sources: FoodSource[] = [];

  const push = (p: Vec, amount: number, type: (typeof FOOD_TYPES)[number]) => {
    const scaled = Math.round(amount * FOOD_TYPE_STATS[type].sizeFactor);
    sources.push({
      id: nextId(),
      kind: 'cluster',
      type,
      density: FOOD_TYPE_STATS[type].density,
      x: p.x,
      y: p.y,
      amount: scaled,
      initialAmount: scaled,
      deaths: 0,
    });
  };

  /** Weighted pick, drawn once per pair so a pile and its mirror twin match. */
  const pickType = (): (typeof FOOD_TYPES)[number] => {
    const total = FOOD_TYPES.reduce((sum, t) => sum + FOOD_TYPE_STATS[t].weight, 0);
    let roll = rng.next() * total;
    for (const type of FOOD_TYPES) {
      roll -= FOOD_TYPE_STATS[type].weight;
      if (roll <= 0) return type;
    }
    return 'seeds';
  };

  // One guaranteed easy source per colony, on the nest-to-centre line.
  for (const nest of HOME_NEST_POSITIONS) {
    const centre = { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 };
    const d = dist(nest, centre);
    const p = {
      x: nest.x + ((centre.x - nest.x) / d) * STARTER_FOOD_DISTANCE,
      y: nest.y + ((centre.y - nest.y) / d) * STARTER_FOOD_DISTANCE,
    };
    // Both starters are seeds, so neither colony opens on a better pile.
    push(p, STARTER_FOOD_AMOUNT, 'seeds');
  }

  const minSeparation = 14;
  const minFromNest = 14;
  let placed = 0;
  let attempts = 0;

  while (placed < FOOD_CLUSTER_PAIRS && attempts < 20000) {
    attempts++;
    const p: Vec = {
      x: rng.range(8, MAP_WIDTH - 8),
      y: rng.range(8, MAP_HEIGHT - 8),
    };
    // Keep candidates strictly on one side of the anti-diagonal so that a
    // point never lands on top of its own mirror image.
    if (p.x + p.y > MAP_WIDTH - 10) continue;
    const m = mirror(p);
    if (HOME_NEST_POSITIONS.some((n) => dist(p, n) < minFromNest || dist(m, n) < minFromNest)) continue;
    if (sources.some((s) => dist(p, s) < minSeparation || dist(m, s) < minSeparation)) continue;
    // Food inside a rock could never be collected.
    if (obstacles.some((o) => dist(p, o) < o.radius + 3 || dist(m, o) < o.radius + 3)) continue;

    const amount = Math.round(rng.range(FOOD_CLUSTER_MIN, FOOD_CLUSTER_MAX));
    const type = pickType();
    push(p, amount, type);
    push(m, amount, type);
    placed++;
  }

  return sources;
}
