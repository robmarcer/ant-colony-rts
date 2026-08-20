import { Rng } from './rng.js';
import {
  FOOD_CLUSTER_MAX,
  FOOD_CLUSTER_MIN,
  FOOD_CLUSTER_PAIRS,
  MAP_HEIGHT,
  MAP_WIDTH,
  STARTER_FOOD_AMOUNT,
  STARTER_FOOD_DISTANCE,
} from './config.js';
import type { FoodSource, Vec } from './types.js';

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
 * Generate food. Every source is created as a mirrored pair, so the two
 * colonies face an identical problem and any difference in outcome is down to
 * the strategies rather than the map. This matters for model comparison.
 */
export function generateFood(rng: Rng, nextId: () => number): FoodSource[] {
  const sources: FoodSource[] = [];

  const push = (p: Vec, amount: number) => {
    sources.push({
      id: nextId(),
      kind: 'cluster',
      x: p.x,
      y: p.y,
      amount,
      initialAmount: amount,
      deaths: 0,
    });
  };

  // One guaranteed easy source per colony, on the nest-to-centre line.
  for (const nest of HOME_NEST_POSITIONS) {
    const centre = { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 };
    const d = dist(nest, centre);
    const p = {
      x: nest.x + ((centre.x - nest.x) / d) * STARTER_FOOD_DISTANCE,
      y: nest.y + ((centre.y - nest.y) / d) * STARTER_FOOD_DISTANCE,
    };
    push(p, STARTER_FOOD_AMOUNT);
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

    const amount = Math.round(rng.range(FOOD_CLUSTER_MIN, FOOD_CLUSTER_MAX));
    push(p, amount);
    push(m, amount);
    placed++;
  }

  return sources;
}
