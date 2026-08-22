/**
 * Balance fingerprint: a hash over the tunable values in src/sim/config.ts *and*
 * over the source of the simulation itself.
 *
 * A match is only a pure function of (definition, definition, seed) within one
 * set of rules. Recording this hash alongside the app version is what lets a
 * stored match say honestly whether it can still be replayed, and what stops the
 * ladder blending results from two different games into one rating.
 *
 * Hashing the config exports alone was not enough, and that gap produced a real
 * wrong answer: a fix to how workers scouted changed match outcomes without
 * touching a single number, so every stored match still looked comparable and
 * the ladder pooled 72 games from what were really two different simulations.
 * Behaviour lives in code as much as in constants, so the code is hashed too.
 *
 * The cost is accepted deliberately: a comment-only edit to a file in src/sim
 * invalidates stored matches. That is the safe direction to be wrong in. Losing
 * comparability you still had is an inconvenience; claiming comparability you
 * lost is a bad measurement presented as a good one.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as config from '../sim/config.js';

const SIM_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'sim');

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

/**
 * Every simulation source file, sorted by name so directory order cannot affect
 * the hash. Line endings are normalised, because a checkout with different ones
 * is still the same simulation.
 */
export function simulationSources(): Array<{ file: string; text: string }> {
  const CR = String.fromCharCode(13);
  return readdirSync(SIM_DIR)
    .filter((name) => name.endsWith('.ts'))
    .sort()
    .map((file) => ({
      file,
      text: readFileSync(join(SIM_DIR, file), 'utf8').split(CR).join(''),
    }));
}

function fnv1a(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Hash a given list of sources. Takes the list rather than reading the directory
 * so a test can prove the hash actually responds to a change in the code, which
 * is the entire point of hashing it.
 */
export function hashSources(sources: Array<{ file: string; text: string }>): string {
  const text = sources.map(({ file, text: body }) => `${file} ${body}`).join('');
  return fnv1a(text).toString(16).padStart(8, '0');
}

/** Hash of the simulation source alone, exposed so a mismatch can say which half moved. */
export function simulationHash(): string {
  return hashSources(simulationSources());
}

/**
 * Which half of a recorded fingerprint no longer matches. A fingerprint is
 * `<balance>-<simulation>`, so an old single-part hash reports as both.
 */
export function fingerprintDrift(recorded: string): { balance: boolean; simulation: boolean } {
  const [balance, simulation] = recorded.split('-');
  if (simulation === undefined) return { balance: true, simulation: true };
  return { balance: balance !== balanceValuesHash(), simulation: simulation !== simulationHash() };
}

/** Hash of the config exports alone, exposed for the same reason. */
export function balanceValuesHash(): string {
  return fnv1a(canonical(balanceValues())).toString(16).padStart(8, '0');
}

export function balanceFingerprint(): string {
  return `${balanceValuesHash()}-${simulationHash()}`;
}
