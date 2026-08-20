/**
 * Deterministic, seedable PRNG (mulberry32).
 *
 * The whole simulation must be reproducible from a seed, so nothing in src/sim
 * is allowed to call Math.random(), Date.now() or new Date(). Every stochastic
 * decision goes through an Rng instance owned by the Simulation.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    // Force to uint32 so string seeds hashed elsewhere behave predictably.
    this.state = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }
}

/** Stable string hash, so seeds can be given as words on the CLI. */
export function hashSeed(seed: string | number): number {
  if (typeof seed === 'number') return seed >>> 0;
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
