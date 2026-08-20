/**
 * Local HTTP API.
 *
 * This is the only surface an LLM uses. The loop is:
 *   1. GET  /api/schema                    learn the behaviour format
 *   2. PUT  /api/definitions/:id           write or revise a behaviour file
 *   3. POST /api/matches                   run a match, hands off, nothing
 *                                          external touches the simulation
 *   4. GET  /api/matches/:id?view=digest   read what happened and why
 *
 * Nothing here can influence a match in progress. A match is a pure function
 * of two definition files and a seed.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

import { DEFINITION_DOC, RULE_METRICS, RULE_OPS, parseDefinition } from '../src/sim/definition.js';
import { EXPANSION_PRIORITIES, PRESETS, SOLDIER_POSTURES, STRATEGY_JSON_SCHEMA } from '../src/sim/strategy.js';
import {
  DEFAULT_TIME_LIMIT_SECONDS,
  MAP_HEIGHT,
  MAP_WIDTH,
  MAX_NESTS_PER_COLONY,
  MIN_ENEMY_NEST_DISTANCE,
  MIN_NEST_SEPARATION,
  SCORE_WEIGHTS,
  STARTING_FOOD,
  STARTING_WORKERS,
  TICKS_PER_SECOND,
  UNITS_PER_NEST,
  UNIT_STATS,
} from '../src/sim/config.js';
import { APP_VERSION, CHANGELOG, totalChanges } from '../src/meta/changelog.js';
import { runMatch } from '../src/match/runner.js';
import { runRoundRobin, runSeries } from '../src/match/tournament.js';
import {
  NotFound,
  deleteDefinition,
  definitionPath,
  ensureStarterDefinitions,
  listDefinitionIds,
  listMatches,
  loadAllDefinitions,
  loadDefinition,
  readDefinitionRaw,
  readMatch,
  saveDefinition,
  saveMatch,
} from '../src/match/store.js';

const here = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '1mb' }));

const created = ensureStarterDefinitions();
if (created.length) console.log(`wrote starter definitions: ${created.join(', ')}`);

/** Wrap a handler so thrown errors become clean JSON responses. */
function handler(fn: (req: Request, res: Response) => void) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      fn(req, res);
    } catch (error) {
      next(error);
    }
  };
}

// ------------------------------------------------------------------- discovery

app.get('/api', (_req, res) => {
  res.json({
    name: 'ant-colony-rts',
    version: APP_VERSION,
    description:
      'Local testbed. Write a behaviour definition, run a hands-off match, read the log, revise. No LLM is consulted during a match.',
    endpoints: {
      'GET /api/schema': 'the behaviour definition format, knob meanings, rule metrics, unit stats, scoring',
      'GET /api/changelog': 'every recorded change to the game, newest first, with timestamps',
      'GET /api/definitions': 'list behaviour definitions',
      'GET /api/definitions/:id': 'read one definition, with any validation issues',
      'PUT /api/definitions/:id': 'create or replace a definition (body is the definition JSON)',
      'POST /api/definitions': 'create a definition, id taken from body.id or body.name',
      'PATCH /api/definitions/:id': 'shallow merge into an existing definition',
      'DELETE /api/definitions/:id': 'delete a definition',
      'POST /api/validate': 'dry run the parser over a definition body, saves nothing',
      'POST /api/matches': 'run one match: {a, b, seed?, timeLimitSeconds?, save?}',
      'GET /api/matches': 'list past matches, newest first: ?limit=&definition=',
      'GET /api/matches/:id': 'full match record, or ?view=digest for plain text',
      'GET /api/matches/:id/events': 'match event log, ?major=true for the timeline only',
      'POST /api/series': 'run the same pairing over several seeds: {a, b, seeds?, swapSides?}',
      'POST /api/round-robin': 'run every pairing: {definitions?, seeds?}',
      'GET /api/stats/:id': 'aggregate win/loss record for one definition across saved matches',
    },
  });
});

app.get('/api/health', (_req, res) =>
  res.json({ ok: true, version: APP_VERSION, definitions: listDefinitionIds().length }),
);

app.get('/api/changelog', (_req, res) => {
  res.json({
    version: APP_VERSION,
    releases: CHANGELOG.length,
    changes: totalChanges(),
    note:
      'Entries with precision "reconstructed" predate version control on this project. Their timestamps come from ' +
      'file modification times and saved match records, so they are accurate to the hour and have no commit behind ' +
      'them. Entries with precision "commit" have exact git provenance.',
    entries: CHANGELOG,
  });
});

app.get('/api/schema', (_req, res) => {
  res.json({
    definition_format: {
      id: 'string, slug, used as the filename',
      name: 'string, shown in the UI and logs',
      author: 'string, e.g. the model id that wrote this',
      version: 'number, bump it yourself when you revise',
      notes: 'free text. Record your plan and what the last match taught you. Carried into every match record.',
      base: 'the six knobs, applied from the first tick',
      rules: 'ordered array of {id, note, when[], set{}}. Every rule whose conditions all hold is layered onto base in list order, later wins.',
    },
    knobs: STRATEGY_JSON_SCHEMA,
    knob_enums: { expansion_priority: EXPANSION_PRIORITIES, soldier_posture: SOLDIER_POSTURES },
    rules: {
      metrics: RULE_METRICS,
      ops: RULE_OPS,
      eval_interval_seconds: DEFINITION_DOC.rule_eval_interval_seconds,
      evaluation: DEFINITION_DOC.evaluation,
      example: {
        id: 'commit',
        note: 'attack only once a real ball of soldiers exists',
        when: [{ metric: 'my_soldiers', op: 'gte', value: 10 }],
        set: { aggression: 1.0, soldier_posture: 'attack_enemy_nest' },
      },
    },
    queens_and_nests: {
      start: 'one queen in one nest per colony',
      how_to_expand:
        'set target_nests above 1. A queen then spends 200 food and 60 seconds building a new queen, who walks to a site and founds a nest there. She is slow and mostly undefended on the way.',
      why_expand: `each nest is an independent build slot drawing on the shared stockpile, and supports ${UNITS_PER_NEST} workers and soldiers. A one nest colony is hard capped at ${UNITS_PER_NEST} units however much food it can reach.`,
      site_selection: `chosen by the simulation, not by you: the best remembered food cluster at least ${MIN_NEST_SEPARATION} cells from your other nests and ${MIN_ENEMY_NEST_DISTANCE} cells from any enemy nest, with risk_tolerance deciding how close to the enemy you will settle`,
      max_nests: MAX_NESTS_PER_COLONY,
      losing_a_queen: 'destroys her nest but not the colony. You are eliminated when your last queen dies.',
      capacity_exception:
        'a colony at its population ceiling can still build a queen, because founding a nest is the only way to raise the ceiling',
    },
    world: {
      map: { width: MAP_WIDTH, height: MAP_HEIGHT, terrain: 'open, no obstacles or pathfinding in v1' },
      symmetry: 'food is generated in mirrored pairs about the map centre, so both colonies face an identical map',
      fog_of_war: 'none in v1, a deliberate simplification. Both colonies see all units, but food must still be discovered by a unit walking within vision range of it.',
      ticks_per_second: TICKS_PER_SECOND,
      default_time_limit_seconds: DEFAULT_TIME_LIMIT_SECONDS,
      starting_food: STARTING_FOOD,
      starting_workers: STARTING_WORKERS,
      corpses:
        'a dead unit leaves food where it fell: 4 for a worker, 12 for a soldier, 60 for a queen, plus whatever it carried. Corpses never decay, and one landing within 6 cells of an existing pile merges into it, so a battlefield becomes a permanent and substantial food source worth holding. By the late game, after the clusters are stripped, corpses are the only income left.',
      nest_regen: 'units inside their own nest regain 3% of max health per second. Queens do not regenerate.',
    },
    unit_stats: UNIT_STATS,
    win_conditions: {
      primary: 'kill every enemy queen',
      time_limit: 'if both colonies still have a queen at the time limit, the higher score wins',
      score_formula: SCORE_WEIGHTS,
      score_note:
        `score = ${SCORE_WEIGHTS.queenAlive} per living queen + ${SCORE_WEIGHTS.worker} per worker + ${SCORE_WEIGHTS.soldier} per soldier` +
        ` + ${SCORE_WEIGHTS.foodStockpile} per food in the stockpile + ${SCORE_WEIGHTS.lifetimeFood} per food gathered over the match.` +
        ' Unspent food is weighted low deliberately, so hoarding does not win. Score only decides time limit matches; an elimination wins outright regardless of score.',
    },
    presets: Object.keys(PRESETS),
  });
});

// ----------------------------------------------------------------- definitions

app.get('/api/definitions', handler((_req, res) => {
  res.json(
    loadAllDefinitions().map(({ definition, issues }) => ({
      id: definition.id,
      name: definition.name,
      author: definition.author,
      version: definition.version,
      notes: definition.notes,
      rules: definition.rules.length,
      updatedAt: definition.updatedAt,
      issues: issues.length,
    })),
  );
}));

app.get('/api/definitions/:id', handler((req, res) => {
  const { definition, issues } = loadDefinition(String(req.params.id));
  res.json({ definition, issues, path: definitionPath(definition.id) });
}));

app.put('/api/definitions/:id', handler((req, res) => {
  const saved = saveDefinition(req.body, String(req.params.id));
  res.status(200).json({ definition: saved.definition, issues: saved.issues, path: definitionPath(saved.definition.id) });
}));

app.post('/api/definitions', handler((req, res) => {
  const idHint = req.body?.id ?? req.body?.name;
  if (!idHint) {
    res.status(400).json({ error: 'body needs an id or a name' });
    return;
  }
  const saved = saveDefinition(req.body, String(idHint));
  res.status(201).json({ definition: saved.definition, issues: saved.issues, path: definitionPath(saved.definition.id) });
}));

app.patch('/api/definitions/:id', handler((req, res) => {
  const existing = readDefinitionRaw(String(req.params.id)) as Record<string, unknown>;
  const merged = { ...existing, ...req.body };
  // A partial base is merged rather than replaced, so a caller can nudge one knob.
  if (req.body?.base && typeof req.body.base === 'object') {
    merged.base = { ...(existing.base as object), ...req.body.base };
  }
  const saved = saveDefinition(merged, String(req.params.id));
  res.json({ definition: saved.definition, issues: saved.issues });
}));

app.delete('/api/definitions/:id', handler((req, res) => {
  deleteDefinition(String(req.params.id));
  res.status(204).end();
}));

app.post('/api/validate', handler((req, res) => {
  const parsed = parseDefinition(req.body, req.body?.id ?? 'candidate');
  res.json({ definition: parsed.definition, issues: parsed.issues, valid: parsed.issues.every((i) => i.severity !== 'error') });
}));

// --------------------------------------------------------------------- matches

app.post('/api/matches', handler((req, res) => {
  const { a, b, seed, timeLimitSeconds, save = true, view } = req.body ?? {};
  if (!a || !b) {
    res.status(400).json({ error: 'body needs a and b, the ids of two definitions' });
    return;
  }
  const defA = loadDefinition(String(a));
  const defB = loadDefinition(String(b));
  const started = Date.now();
  const record = runMatch({
    definitions: [defA.definition, defB.definition],
    definitionIssues: [defA.issues, defB.issues],
    seed: seed ?? 'default',
    timeLimitSeconds: Number(timeLimitSeconds ?? DEFAULT_TIME_LIMIT_SECONDS),
  });
  if (save) saveMatch(record);
  console.log(`match ${record.id} in ${Date.now() - started}ms: ${record.result.winnerName ?? 'draw'} by ${record.result.reason}`);

  if (view === 'digest') {
    res.type('text/plain').send(record.digest);
    return;
  }
  if (view === 'summary') {
    res.json({ id: record.id, result: record.result, colonies: record.colonies, ruleActivity: record.ruleActivity, durationSeconds: record.durationSeconds });
    return;
  }
  res.json(record);
}));

app.get('/api/matches', handler((req, res) => {
  res.json(
    listMatches({
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      definition: req.query.definition ? String(req.query.definition) : undefined,
    }),
  );
}));

app.get('/api/matches/:id', handler((req, res) => {
  const record = readMatch(String(req.params.id));
  if (req.query.view === 'digest') {
    res.type('text/plain').send(record.digest);
    return;
  }
  if (req.query.view === 'summary') {
    const { events, series, ...rest } = record;
    res.json(rest);
    return;
  }
  res.json(record);
}));

app.get('/api/matches/:id/events', handler((req, res) => {
  const record = readMatch(String(req.params.id));
  const events = req.query.major === 'true' ? record.events.filter((e) => e.major) : record.events;
  res.json(events);
}));

// ------------------------------------------------------------------ tournaments

/** Guard so a single request cannot tie the server up for many minutes. */
const MAX_MATCHES_PER_REQUEST = 64;

app.post('/api/series', handler((req, res) => {
  const { a, b, seeds = ['1', '2', '3'], timeLimitSeconds, swapSides = true, save = false } = req.body ?? {};
  if (!a || !b) {
    res.status(400).json({ error: 'body needs a and b' });
    return;
  }
  const count = seeds.length * (swapSides ? 2 : 1);
  if (count > MAX_MATCHES_PER_REQUEST) {
    res.status(400).json({ error: `that is ${count} matches, over the ${MAX_MATCHES_PER_REQUEST} limit. Use the CLI: npm run match -- --a ${a} --b ${b} --repeat N` });
    return;
  }
  const defA = loadDefinition(String(a)).definition;
  const defB = loadDefinition(String(b)).definition;
  const result = runSeries({ definitions: [defA, defB], seeds, timeLimitSeconds, swapSides });
  if (save) for (const record of result.records) saveMatch(record);
  const { records, ...rest } = result;
  res.json({ ...rest, savedMatchIds: save ? records.map((r) => r.id) : [] });
}));

app.post('/api/round-robin', handler((req, res) => {
  const { definitions, seeds = ['1'], timeLimitSeconds } = req.body ?? {};
  const all = loadAllDefinitions().map((loaded) => loaded.definition);
  const chosen = Array.isArray(definitions) && definitions.length
    ? all.filter((definition) => definitions.includes(definition.id))
    : all;
  const pairings = (chosen.length * (chosen.length - 1)) / 2;
  const count = pairings * seeds.length * 2;
  if (count > MAX_MATCHES_PER_REQUEST) {
    res.status(400).json({ error: `that is ${count} matches, over the ${MAX_MATCHES_PER_REQUEST} limit. Use the CLI: npm run match -- --round-robin --seeds ${seeds.join(',')}` });
    return;
  }
  res.json(runRoundRobin({ definitions: chosen, seeds, timeLimitSeconds }));
}));

app.get('/api/stats/:id', handler((req, res) => {
  const id = String(req.params.id);
  const rows = listMatches({ definition: id, limit: 10000 });
  const name = loadDefinition(id).definition.name;
  let wins = 0;
  let losses = 0;
  let draws = 0;
  const byOpponent = new Map<string, { wins: number; losses: number; draws: number }>();
  for (const row of rows) {
    const opponent = row.a === id ? row.b : row.a;
    const entry = byOpponent.get(opponent) ?? { wins: 0, losses: 0, draws: 0 };
    if (row.winner === null) {
      draws++;
      entry.draws++;
    } else if (row.winner === name) {
      wins++;
      entry.wins++;
    } else {
      losses++;
      entry.losses++;
    }
    byOpponent.set(opponent, entry);
  }
  res.json({
    id,
    matches: rows.length,
    wins,
    losses,
    draws,
    winRate: rows.length ? +(wins / rows.length).toFixed(3) : 0,
    byOpponent: Object.fromEntries(byOpponent),
    recent: rows.slice(0, 10),
  });
}));

// ----------------------------------------------------------------------- errors

app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof NotFound) {
    res.status(404).json({ error: error.message });
    return;
  }
  if (error instanceof SyntaxError) {
    res.status(400).json({ error: `invalid JSON: ${error.message}` });
    return;
  }
  console.error(error);
  res.status(400).json({ error: error.message ?? 'bad request' });
});

// Deliberately not PORT: some dev harnesses set PORT for the web server, and
// the API would then try to bind the same port as vite.
const port = Number(process.env.ANT_API_PORT ?? 8787);
app.listen(port, () => {
  console.log(`ant-colony-rts api on http://localhost:${port}/api`);
});
