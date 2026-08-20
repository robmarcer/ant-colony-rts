/**
 * Balance fingerprint: a hash over every tunable value in src/sim/config.ts.
 *
 * A match is only a pure function of (definition, definition, seed) within a
 * single set of balance numbers. Change the map size, a unit cost or the scoring
 * weights and the same inputs produce a different game. Recording this hash
 * alongside the app version is what lets a stored match say honestly whether it
 * can still be replayed.
 */
import * as config from '../sim/config.js';

/** Stable JSON: object keys sorted at every level, so key order cannot affect the hash. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => typeof v !== 'function')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/** The balance numbers themselves, exposed so a mismatch can be explained. */
export function balanceValues(): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'function') continue;
    values[key] = value;
  }
  return values;
}

export function balanceFingerprint(): string {
  const text = canonical(balanceValues());
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
