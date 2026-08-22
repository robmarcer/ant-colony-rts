/**
 * Brood slot pricing and the decision to buy one, as pure functions.
 *
 * Issue #31. Extracted rather than written inline for the reason recorded in
 * guard-score.ts: a decision that only shows up in the aftermath of a match
 * cannot be told apart from the world having moved underneath it. Priced and
 * decided as numbers, it is assertable.
 */
import {
  BROOD_SLOTS_INITIAL,
  BROOD_SLOTS_MAX,
  BROOD_SLOT_BASE_COST,
  BROOD_SLOT_COST_GROWTH,
} from './config.js';

/**
 * What the next slot costs a queen who already has `slots`.
 *
 * Rising, so capacity cannot be bought out entirely: 120, 204, 347, 590, 1003
 * for the five slots above the first. Infinity once at the cap, which callers
 * can compare against without a separate "can I" check.
 */
export function broodSlotCost(slots: number): number {
  if (slots >= BROOD_SLOTS_MAX) return Infinity;
  return Math.round(BROOD_SLOT_BASE_COST * BROOD_SLOT_COST_GROWTH ** (slots - BROOD_SLOTS_INITIAL));
}

/** Everything the purchase depends on. */
export interface BroodContext {
  /** The colony's unspent food. */
  food: number;
  /** Slots this queen already has. */
  slots: number;
  /** capacity_investment, 0 to 1. */
  investment: number;
  /** True while the colony is below min_worker_reserve. */
  belowWorkerFloor: boolean;
  /** True when the colony is at its population ceiling and not expanding. */
  atPopulationCeiling: boolean;
}

/**
 * Whether to spend on capacity instead of on a unit.
 *
 * The threshold falls as investment rises: at 1 a slot is bought the moment it
 * is affordable, at 0.5 it waits until the stockpile is three times the price,
 * and at 0 it never buys at all. Zero being a hard off matters for measurement,
 * because it gives a control that is genuinely unchanged rather than merely
 * slower.
 *
 * Never while below the worker floor. That floor exists so a colony cannot
 * starve its economy, and capacity a colony has no workers to feed is the same
 * mistake in a new place.
 *
 * Zero means never, including at the population ceiling. An earlier version
 * bought a slot at the ceiling whatever the knob said, on the grounds that there
 * was nothing else to spend on. That was wrong twice over. It overrode an
 * explicit instruction, so a definition asking for no capacity bought twenty
 * slots and there was no control left to measure against. And the reasoning was
 * poor anyway: at the ceiling the extra slots only replace losses faster, since
 * the population cannot go above the cap, so it is a marginal gain rather than
 * the obvious one it looked like. A colony that wants it can ask.
 */
export function shouldBuyBroodSlot(context: BroodContext): boolean {
  const cost = broodSlotCost(context.slots);
  if (!Number.isFinite(cost) || context.food < cost) return false;
  if (context.belowWorkerFloor) return false;
  if (context.investment <= 0) return false;
  // At the ceiling there is nothing else to buy, so the usual patience is
  // dropped: any colony willing to invest at all invests now.
  if (context.atPopulationCeiling) return true;
  const threshold = cost * (1 + 4 * (1 - context.investment));
  return context.food >= threshold;
}
