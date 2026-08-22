/**
 * Guard post scoring, extracted as a pure function of numbers.
 *
 * It used to live inside the AI, reading simulation state, which meant the only
 * way to see what it did was to run a match and inspect the aftermath. That is
 * not good enough: posts are held until the pile is exhausted, so a pile that was
 * safe when chosen can end up beside a nest founded later, and end-state
 * inspection cannot tell "the caution term did nothing" apart from "the caution
 * term worked and the world moved". Measured over 150 posts, average distance to
 * a known enemy nest did not vary with risk_tolerance in any consistent
 * direction, and four attempts to assert otherwise failed.
 *
 * As a function of numbers, the question is decidable in one line of test.
 */
import {
  GUARD_DENIAL_CAP,
  GUARD_MAX_RANGE,
  GUARD_OWN_HALF_PENALTY_CAP,
} from './config.js';

/** Everything the decision depends on, and nothing else. */
export interface GuardCandidate {
  /** Energy believed to be left in the pile. */
  amount: number;
  /** Energy per unit of carrying volume, so 1 is ordinary. */
  density: number;
  /** Distance to this colony's nearest nest. */
  fromOwnNest: number;
  /** Distance to the nearest enemy nest this colony knows about. */
  fromEnemyNest: number;
  /** Enemy workers seen within GUARD_ACTIVITY_RADIUS of the pile. */
  enemyWorkersPresent: number;
}

/** Named so a caller, or a test, can see which term did the work. */
export interface GuardScoreTerms {
  activity: number;
  size: number;
  density: number;
  denial: number;
  distance: number;
  outOfRange: number;
  exposure: number;
  total: number;
}

/**
 * Score a candidate pile. Higher is a better place to stand.
 *
 * `exposure` is the term under question: it should make a colony with low
 * risk_tolerance avoid piles close to an enemy nest. It competes with
 * `activity`, which is deliberately the strongest signal, because a guard on a
 * pile nobody is working denies nothing however safe it is.
 */
export function scoreGuardPost(candidate: GuardCandidate, riskTolerance: number): GuardScoreTerms {
  // Positive when the pile is closer to them than to us, which is the food worth
  // taking off them. Capped both ways: uncapped, the best denial score always
  // belongs to the pile touching their nest, and supportability has to win.
  const denialRaw = Math.max(
    -GUARD_OWN_HALF_PENALTY_CAP,
    Math.min(GUARD_DENIAL_CAP, candidate.fromOwnNest - candidate.fromEnemyNest),
  );
  const exposureFraction = Math.max(0, 60 - candidate.fromEnemyNest) / 60;

  const terms: GuardScoreTerms = {
    activity: 1.5 * candidate.enemyWorkersPresent,
    size: 0.04 * candidate.amount,
    // Denial is a rate, not a total: a dense pile hands the enemy more energy
    // per trip, so it is worth more to stand on than a bigger thin one.
    density: 8 * (candidate.density - 1),
    /*
     * Scaled by risk_tolerance, which it was not before, and that was the whole
     * problem behind issue #27.
     *
     * Denial rewards a pile for being deep in their half. Exposure punishes a
     * pile for exactly the same thing. Both keyed off the same distance with
     * only exposure gated by risk, so the two fought each other: at risk 0
     * exposure won and the colony stayed home, but from about risk 0.5 upward
     * denial won and it happily posted next to their nest. Nobody designed that
     * crossover, and it is why measuring across risk values found no consistent
     * relationship. Gating both by risk makes the knob mean one thing: how deep
     * into their half am I willing to stand.
     *
     * The coefficient doubled from 0.5 to 1.0 at the same time, so that a
     * risk_tolerance of 0.5 reproduces the old ungated weight exactly. Gating at
     * the old coefficient was measured against an ungated control over the same
     * 180 matches and cost preset-blockade three wins, 20-16 down to 17-19, with
     * every other definition unmoved. Halving the reward for the default
     * definition was a side effect of the fix rather than part of it, so it was
     * scaled out instead of accepted.
     */
    denial: 1.0 * denialRaw * riskTolerance,
    distance: -0.35 * candidate.fromOwnNest,
    outOfRange: -5 * Math.max(0, candidate.fromOwnNest - GUARD_MAX_RANGE),
    exposure: -exposureFraction * 60 * (1 - riskTolerance),
    total: 0,
  };
  terms.total =
    terms.activity + terms.size + terms.density + terms.denial + terms.distance + terms.outOfRange + terms.exposure;
  return terms;
}

/**
 * How many enemy workers on a pile it takes for the activity term to outweigh
 * the caution term at a given risk_tolerance. Answers the question the issue
 * actually asked: is caution being drowned out, and if so, from what point.
 */
export function workersToOutweighCaution(fromEnemyNest: number, riskTolerance: number): number {
  const exposureFraction = Math.max(0, 60 - fromEnemyNest) / 60;
  const penalty = exposureFraction * 60 * (1 - riskTolerance);
  return penalty / 1.5;
}
