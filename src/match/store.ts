/**
 * File backed store. Definitions are plain JSON files an LLM (or a human) can
 * also edit directly on disk; match records are write-once JSON plus an
 * append-only index for cheap listing.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_STRATEGY, PRESETS } from '../sim/strategy.js';
import { parseDefinition, slugify, type BehaviourDefinition, type ValidationIssue } from '../sim/definition.js';
import type { MatchRecord, MatchSummaryRow } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = process.env.ANT_DATA_DIR ? resolve(process.env.ANT_DATA_DIR) : resolve(here, '../..');
export const DEFINITIONS_DIR = join(ROOT, 'definitions');
export const MATCHES_DIR = join(ROOT, 'matches');
const MATCH_INDEX = join(MATCHES_DIR, 'index.jsonl');

function ensureDirs(): void {
  mkdirSync(DEFINITIONS_DIR, { recursive: true });
  mkdirSync(MATCHES_DIR, { recursive: true });
}

/** Ids are used as filenames, so they must be slugs and nothing else. */
export function assertSafeId(id: string): string {
  const slug = slugify(id);
  if (slug !== id) throw new Error(`invalid id "${id}", expected slug form like "${slug}"`);
  return id;
}

// ------------------------------------------------------------------ definitions

export function definitionPath(id: string): string {
  return join(DEFINITIONS_DIR, `${assertSafeId(id)}.json`);
}

export function listDefinitionIds(): string[] {
  ensureDirs();
  return readdirSync(DEFINITIONS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

export function readDefinitionRaw(id: string): unknown {
  const path = definitionPath(id);
  if (!existsSync(path)) throw new NotFound(`definition "${id}" not found`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

export interface LoadedDefinition {
  definition: BehaviourDefinition;
  issues: ValidationIssue[];
}

export function loadDefinition(id: string): LoadedDefinition {
  const parsed = parseDefinition(readDefinitionRaw(id), id);
  // The file's own id wins over whatever the name slugified to.
  parsed.definition.id = id;
  return { definition: parsed.definition, issues: parsed.issues };
}

export function loadAllDefinitions(): LoadedDefinition[] {
  return listDefinitionIds().map((id) => loadDefinition(id));
}

/**
 * Validate, stamp and write. Returns the stored form plus any issues, so a
 * caller always learns what was corrected instead of guessing later.
 */
export function saveDefinition(raw: unknown, idHint?: string): LoadedDefinition {
  ensureDirs();
  const parsed = parseDefinition(raw, idHint);
  if (idHint) parsed.definition.id = assertSafeId(slugify(idHint));
  parsed.definition.updatedAt = new Date().toISOString();
  writeFileSync(definitionPath(parsed.definition.id), `${JSON.stringify(parsed.definition, null, 2)}\n`);
  return { definition: parsed.definition, issues: parsed.issues };
}

export function deleteDefinition(id: string): void {
  const path = definitionPath(id);
  if (!existsSync(path)) throw new NotFound(`definition "${id}" not found`);
  unlinkSync(path);
}

// --------------------------------------------------------------------- matches

export function matchPath(id: string): string {
  // Match ids contain timestamps, so allow dots and colons-turned-dashes.
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(id)) throw new Error(`invalid match id "${id}"`);
  return join(MATCHES_DIR, `${id}.json`);
}

export function saveMatch(record: MatchRecord): MatchRecord {
  ensureDirs();
  writeFileSync(matchPath(record.id), `${JSON.stringify(record, null, 2)}\n`);
  const row: MatchSummaryRow = {
    id: record.id,
    createdAt: record.createdAt,
    seed: record.seed,
    a: record.colonies[0].definitionId,
    b: record.colonies[1].definitionId,
    winner: record.result.winnerName,
    reason: record.result.reason,
    scores: record.result.scores,
    durationSeconds: record.durationSeconds,
  };
  appendFileSync(MATCH_INDEX, `${JSON.stringify(row)}\n`);
  return record;
}

export function readMatch(id: string): MatchRecord {
  const path = matchPath(id);
  if (!existsSync(path)) throw new NotFound(`match "${id}" not found`);
  return JSON.parse(readFileSync(path, 'utf8')) as MatchRecord;
}

export interface ListMatchesQuery {
  limit?: number;
  /** Only matches involving this definition id, on either side. */
  definition?: string;
}

export function listMatches(query: ListMatchesQuery = {}): MatchSummaryRow[] {
  ensureDirs();
  if (!existsSync(MATCH_INDEX)) return [];
  const rows = readFileSync(MATCH_INDEX, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as MatchSummaryRow)
    .reverse(); // newest first
  const filtered = query.definition ? rows.filter((r) => r.a === query.definition || r.b === query.definition) : rows;
  return filtered.slice(0, query.limit ?? 50);
}

export class NotFound extends Error {}

// -------------------------------------------------------------- starter content

/** Written on first run so there is always something to play against. */
export function ensureStarterDefinitions(): string[] {
  ensureDirs();
  const created: string[] = [];
  const starters: Array<Record<string, unknown>> = Object.entries(PRESETS).map(([key, base]) => ({
    id: `preset-${key}`,
    name: `preset-${key}`,
    author: 'hand',
    version: 1,
    notes: `Built-in ${key} preset. Static knobs, no rules. Useful as a baseline opponent.`,
    base,
    rules: [],
  }));

  // One worked example with rules, so an author can see the shape.
  starters.push({
    id: 'example-adaptive',
    name: 'example-adaptive',
    author: 'hand',
    version: 1,
    notes:
      'Worked example. Expand early, then build an army, with a panic clause. Copy this and change it rather than starting from a blank file.',
    base: {
      unit_production_ratio: { worker: 0.85, soldier: 0.15 },
      aggression: 0.1,
      expansion_priority: 'nearest_food_first',
      min_worker_reserve: 12,
      soldier_posture: 'defend_nest',
      risk_tolerance: 0.3,
      target_nests: 2,
    },
    rules: [
      {
        id: 'third-nest',
        note: 'a second nest paid off, so take a third once the economy can carry it',
        when: [
          { metric: 'my_nests', op: 'gte', value: 2 },
          { metric: 'my_workers', op: 'gte', value: 30 },
        ],
        set: { target_nests: 3 },
      },
      {
        id: 'stop-expanding-under-pressure',
        note: 'a walking queen is 200 food handed to the enemy if the map is not safe',
        when: [{ metric: 'enemies_near_my_nest', op: 'gte', value: 2 }],
        set: { target_nests: 1 },
      },
      {
        id: 'midgame-army',
        note: 'after two minutes the easy food is thinning out, start building an army',
        when: [{ metric: 'sim_seconds', op: 'gte', value: 120 }],
        set: { unit_production_ratio: { worker: 0.6, soldier: 0.4 }, aggression: 0.4, soldier_posture: 'escort_workers' },
      },
      {
        id: 'punish-weak-enemy',
        note: 'if they have no army by three minutes, go for the queen',
        when: [
          { metric: 'sim_seconds', op: 'gte', value: 180 },
          { metric: 'soldier_advantage', op: 'gte', value: 4 },
        ],
        set: { aggression: 0.85, soldier_posture: 'attack_enemy_nest', risk_tolerance: 0.7 },
      },
      {
        id: 'defend-home',
        note: 'panic clause, overrides the pushes above because it is later in the list',
        when: [{ metric: 'enemies_near_my_nest', op: 'gte', value: 3 }],
        set: { aggression: 0.0, soldier_posture: 'defend_nest', risk_tolerance: 0.9 },
      },
      {
        id: 'rebuild-economy',
        note: 'if the worker base collapses, stop making soldiers and stop expanding',
        when: [{ metric: 'my_workers', op: 'lte', value: 5 }],
        set: { unit_production_ratio: { worker: 1, soldier: 0 }, min_worker_reserve: 10, target_nests: 1 },
      },
    ],
  });

  // Second worked example, and a genuine counter to a pure economy build.
  // Timing is expressed entirely as rules, which is the point of the format.
  starters.push({
    id: 'example-mass-rush',
    name: 'example-mass-rush',
    author: 'hand',
    version: 1,
    notes:
      'Holds every soldier at home until a ball of 12 exists, then commits at the nearest enemy nest. A trickle of single soldiers dies for nothing, so the timing rule is the whole strategy. Takes a second nest first, because one nest can only support 40 units and 12 soldiers out of 40 is a thin army.',
    base: {
      unit_production_ratio: { worker: 0.5, soldier: 0.5 },
      aggression: 0.0,
      expansion_priority: 'nearest_food_first',
      min_worker_reserve: 10,
      soldier_posture: 'defend_nest',
      risk_tolerance: 0.5,
      target_nests: 2,
    },
    rules: [
      {
        id: 'commit',
        note: 'attack only once a real ball of soldiers exists',
        when: [{ metric: 'my_soldiers', op: 'gte', value: 12 }],
        set: { aggression: 1.0, soldier_posture: 'attack_enemy_nest', risk_tolerance: 0.85 },
      },
      {
        id: 'regroup',
        note: 'if the push is wiped out, go home and rebuild, and do not expand while losing',
        when: [{ metric: 'my_soldiers', op: 'lte', value: 4 }],
        set: { aggression: 0.0, soldier_posture: 'defend_nest', target_nests: 1 },
      },
      {
        id: 'grow-on-a-win',
        note: 'once their army is gone there is nothing stopping a third nest',
        when: [
          { metric: 'soldier_advantage', op: 'gte', value: 8 },
          { metric: 'sim_seconds', op: 'gte', value: 240 },
        ],
        set: { target_nests: 3 },
      },
    ],
  });

  const knobKeys = Object.keys(DEFAULT_STRATEGY);

  for (const starter of starters) {
    const id = starter.id as string;
    if (existsSync(definitionPath(id)) && !starterIsStale(id, knobKeys)) continue;
    saveDefinition(starter, id);
    created.push(id);
  }
  return created;
}

/**
 * True if a built-in starter on disk was written before a knob existed. Adding
 * a knob would otherwise leave every shipped definition permanently falling
 * back to a default and reporting a validation issue on every match. Only
 * starters are checked, so hand written definitions are never touched.
 */
function starterIsStale(id: string, knobKeys: string[]): boolean {
  try {
    const stored = JSON.parse(readFileSync(definitionPath(id), 'utf8')) as { base?: Record<string, unknown> };
    return knobKeys.some((key) => stored.base?.[key] === undefined);
  } catch {
    return true;
  }
}
