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
import { existsSync, readFileSync } from 'node:fs';
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
  QUEEN_ARMOUR,
  QUEEN_MAX_ATTACKERS,
  RECYCLE_PRESSURE_FRACTION,
  SCORE_WEIGHTS,
  STALEMATE_WINDOW_SECONDS,
  STARTING_FOOD,
  STARTING_WORKERS,
  TICKS_PER_SECOND,
  UNITS_PER_NEST,
  UNIT_STATS,
} from '../src/sim/config.js';
import { APP_VERSION, CHANGELOG, totalChanges } from '../src/meta/changelog.js';
import { NotReplayable, isReplayable, replayRecord, runMatch } from '../src/match/runner.js';
import { balanceFingerprint } from '../src/meta/fingerprint.js';
import {
  CHECK_CACHE_SECONDS,
  RELEASE_REPO,
  applyUpdate,
  checkForUpdate,
  manualInstructions,
} from '../src/meta/update.js';
import { runRoundRobin, runSeries } from '../src/match/tournament.js';
import { buildLadder } from '../src/match/ladder.js';
import {
  NotFound,
  ROOT,
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

/**
 * The same for a handler that awaits. Separate from `handler` on purpose: passing
 * an async function to that one type checks cleanly and then swallows every
 * rejection, because the returned promise is dropped rather than returned.
 */
function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
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
      'GET /api/brief': 'read this first if you are here to write strategies: the whole loop, the traps, and how to read a result',
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
      'POST /api/matches/:id/replay': 're-run a stored match and confirm it reproduces; 409 if this build cannot reproduce it',
      'POST /api/series': 'run the same pairing over several seeds: {a, b, seeds?, swapSides?}',
      'POST /api/round-robin': 'run every pairing: {definitions?, seeds?}',
      'GET /api/stats/:id': 'aggregate win/loss record for one definition across saved matches',
      'GET /api/ladder': 'ratings across every definition, from every comparable stored match',
      'POST /api/ladder/sweep': 'play a round robin, save it, and return the updated ladder',
      'GET /api/update': 'is a newer release published: current against latest, how this copy was installed, and what applying one would risk',
      'POST /api/update': 'apply an update, loopback only: {acknowledge: [warning ids], matchRunning?}',
    },
  });
});

app.get('/api/health', (_req, res) =>
  res.json({
    ok: true,
    version: APP_VERSION,
    balanceHash: balanceFingerprint(),
    definitions: listDefinitionIds().length,
  }),
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

/*
 * ---------------------------------------------------------------- updates
 *
 * Issue #19. The check is server side so the unauthenticated GitHub rate limit is
 * spent once per process rather than once per open tab, and so the browser makes
 * no cross-origin calls.
 */

/** How many stored matches the running build can still rank, for the update warning. */
function comparableMatchCount(): number {
  const hash = balanceFingerprint();
  return listMatches({ limit: 100000 }).filter((row) => row.balanceHash === hash).length;
}

/**
 * Refuse anything that applies an update unless it came from this machine.
 *
 * The route runs git and npm, so on an exposed port it is remote code execution.
 * The whole app is designed to be local, but "designed to be" is not a control,
 * and someone will eventually put it behind a tunnel to show a colleague.
 */
function fromLoopback(req: Request): boolean {
  const address = req.socket.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

app.get('/api/update', asyncHandler(async (req: Request, res: Response) => {
  const status = await checkForUpdate(
    { matchRunning: req.query.matchRunning === 'true', storedMatches: comparableMatchCount() },
    { force: req.query.force === 'true' },
  );
  res.json({
    ...status,
    repo: RELEASE_REPO,
    cacheSeconds: CHECK_CACHE_SECONDS,
    note:
      status.standing === 'ahead'
        ? 'This build is newer than the newest published release, which is normal while a version is being worked on.'
        : status.latest === null
          ? 'No releases are published for this repository yet, so there is nothing to compare against.'
          : undefined,
  });
}));

/**
 * Apply an update. Opt in twice: the caller has to ask, and has to acknowledge
 * each warning by id. Acknowledging by id rather than with one flag means a
 * warning added later cannot be waved through by an old client that never showed
 * it to anybody.
 */
app.post('/api/update', asyncHandler(async (req: Request, res: Response) => {
  if (!fromLoopback(req)) {
    res.status(403).json({
      error: 'updates can only be applied from the machine running the server, because applying one runs git and npm',
    });
    return;
  }

  const body = (req.body ?? {}) as { acknowledge?: string[]; matchRunning?: boolean };
  const status = await checkForUpdate(
    { matchRunning: body.matchRunning === true, storedMatches: comparableMatchCount() },
    { force: true },
  );

  if (status.release === null || status.standing !== 'behind') {
    res.status(409).json({
      error:
        status.latest === null
          ? 'there is no published release to update to'
          : `nothing to apply: this build is ${status.standing} at ${status.current} against ${status.latest}`,
      status,
    });
    return;
  }

  const acknowledged = new Set(body.acknowledge ?? []);
  const unacknowledged = status.warnings.filter((warning) => !acknowledged.has(warning.id));
  if (unacknowledged.length > 0) {
    res.status(409).json({
      error: 'these have to be acknowledged before an update is applied',
      acknowledge: unacknowledged.map((warning) => warning.id),
      warnings: unacknowledged,
      status,
    });
    return;
  }

  if (!status.install.updatable) {
    // 501 rather than 400: the request is fine, this install just cannot be
    // updated by the server, and the body says how to do it by hand.
    res.status(501).json({
      error: `this install cannot be updated in place (${status.install.reason})`,
      install: status.install,
      instructions: manualInstructions(status.install.kind, status.release.tag),
    });
    return;
  }

  res.json(applyUpdate(status.release, status.install));
}));

/**
 * The agent brief, served so an LLM given nothing but this base URL can bootstrap
 * itself without filesystem access.
 */
app.get('/api/brief', handler((_req, res) => {
  const path = join(here, '../docs/agent-brief.md');
  res.type('text/markdown').send(readFileSync(path, 'utf8'));
}));

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
        'a dead unit returns its full cost where it fell: 10 for a worker, 30 for a soldier, 200 for a queen, plus whatever it carried. Corpses never decay, and one landing within 6 cells of an existing pile merges into it, so a battlefield becomes a permanent and substantial food source worth holding.',
      closed_system:
        'total energy on the map never changes. It moves between food on the ground, food carried by a worker, a colony stockpile, and the energy embodied in living units, and a death returns every point of it. A battle relocates value rather than destroying it, so winning a fight next to your own nest is worth much more than winning the same fight next to theirs.',
      nest_regen: 'units inside their own nest regain 3% of max health per second. Queens do not regenerate.',
    },
    unit_stats: UNIT_STATS,
    sieges: {
      queen_health: UNIT_STATS.queen.maxHp,
      queen_armour: QUEEN_ARMOUR,
      max_simultaneous_attackers: QUEEN_MAX_ATTACKERS,
      seconds_of_sustained_assault: Math.round(
        UNIT_STATS.queen.maxHp / (QUEEN_MAX_ATTACKERS * (UNIT_STATS.soldier.attack - QUEEN_ARMOUR)),
      ),
      note:
        `Killing a queen is a siege, not a drive-by. Only ${QUEEN_MAX_ATTACKERS} attackers can reach her at once however large the army outside, so piling on more soldiers does not speed it up past that limit: what they buy is holding the ground for the whole assault. Armour is subtracted from every hit, which makes workers nearly useless against a queen. A colony with several nests has several queens, each needing its own siege.`,
      measured_consequence:
        'This makes committed aggression substantially weaker. 22% of matches end in an elimination, down from 36% before sieges, and no commit threshold recovers a straightforward rush: at 12, 20, 30 and 45 soldiers it won 3, 3, 4 and 0 of 12 matches.',
    },
    recycling: {
      pressure_fraction: RECYCLE_PRESSURE_FRACTION,
      note:
        `unit_production_ratio only governs what you build next, so a colony that booms on workers and then wants an army is stuck carrying them. recycle_surplus sends surplus units home to be eaten by a queen, returning their full cost. It only applies at or above ${RECYCLE_PRESSURE_FRACTION * 100}% of the population ceiling, and never culls below min_worker_reserve.`,
    },
    match_end: {
      time_limit_seconds: DEFAULT_TIME_LIMIT_SECONDS,
      stalemate_window_seconds: STALEMATE_WINDOW_SECONDS,
      note:
        `A match ends when one colony loses every queen, when the clock runs out, or as a stalemate when nothing material has changed for ${STALEMATE_WINDOW_SECONDS} sim seconds. Stalemates and time limits are both resolved on score. Because the default limit is very long, most decided matches end by elimination or stalemate rather than the clock.`,
    },
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

app.post('/api/matches/:id/replay', handler((req, res) => {
  const record = readMatch(String(req.params.id));
  const { identical, replayed } = replayRecord(record);
  res.json({
    id: record.id,
    identical,
    appVersion: record.appVersion,
    balanceHash: record.balanceHash,
    original: record.result,
    replayed: replayed.result,
  });
}));

app.get('/api/matches/:id', handler((req, res) => {
  const record = readMatch(String(req.params.id));
  if (req.query.view === 'digest') {
    res.type('text/plain').send(record.digest);
    return;
  }
  if (req.query.view === 'summary') {
    const { events, series, ...rest } = record;
    res.json({ ...rest, replayable: isReplayable(record) });
    return;
  }
  res.json({ ...record, replayable: isReplayable(record) });
}));

app.get('/api/matches/:id/events', handler((req, res) => {
  const record = readMatch(String(req.params.id));
  const events = req.query.major === 'true' ? record.events.filter((e) => e.major) : record.events;
  res.json(events);
}));

// ------------------------------------------------------------------ tournaments

/** Guard so a single request cannot tie the server up for many minutes. */
const MAX_MATCHES_PER_REQUEST = 64;
/**
 * Rough seconds of compute per sim second, measured at roughly 1.1s for a 900
 * second match and 30s for a 90,000 second one. Used to refuse a request that
 * would block far longer than an HTTP client will wait, which matters now that
 * the default match is long enough for a round robin to take most of an hour.
 */
const SECONDS_PER_SIM_SECOND = 1 / 800;
const COMPUTE_BUDGET_SECONDS = 300;

/** Null if the request fits the budget, otherwise an explanatory message. */
function tooExpensive(matches: number, timeLimitSeconds: number, cliHint: string): string | null {
  if (matches > MAX_MATCHES_PER_REQUEST) {
    return `that is ${matches} matches, over the ${MAX_MATCHES_PER_REQUEST} limit. Use the CLI: ${cliHint}`;
  }
  const estimate = matches * timeLimitSeconds * SECONDS_PER_SIM_SECOND;
  if (estimate > COMPUTE_BUDGET_SECONDS) {
    return (
      `that is ${matches} matches of ${timeLimitSeconds} sim seconds, roughly ${Math.round(estimate)}s of compute, ` +
      `over the ${COMPUTE_BUDGET_SECONDS}s budget for one request. Lower timeLimitSeconds, use fewer seeds, ` +
      `or run it on the CLI where nothing is waiting on a socket: ${cliHint}`
    );
  }
  return null;
}

app.post('/api/series', handler((req, res) => {
  const { a, b, seeds = ['1', '2', '3'], timeLimitSeconds, swapSides = true, save = false } = req.body ?? {};
  if (!a || !b) {
    res.status(400).json({ error: 'body needs a and b' });
    return;
  }
  const count = seeds.length * (swapSides ? 2 : 1);
  const limit = Number(timeLimitSeconds ?? DEFAULT_TIME_LIMIT_SECONDS);
  const refusal = tooExpensive(count, limit, `npm run match -- --a ${a} --b ${b} --repeat N`);
  if (refusal) {
    res.status(400).json({ error: refusal });
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
  const limit = Number(timeLimitSeconds ?? DEFAULT_TIME_LIMIT_SECONDS);
  const refusal = tooExpensive(count, limit, `npm run match -- --round-robin --seeds ${seeds.join(',')}`);
  if (refusal) {
    res.status(400).json({ error: refusal });
    return;
  }
  res.json(runRoundRobin({ definitions: chosen, seeds, timeLimitSeconds }));
}));

app.get('/api/ladder', handler((_req, res) => {
  res.json(buildLadder(listMatches({ limit: 100000 })));
}));

app.post('/api/ladder/sweep', handler((req, res) => {
  const { definitions, seeds = ['1'], timeLimitSeconds } = req.body ?? {};
  const all = loadAllDefinitions().map((loaded) => loaded.definition);
  const chosen = Array.isArray(definitions) && definitions.length
    ? all.filter((definition) => definitions.includes(definition.id))
    : all;
  const pairings = (chosen.length * (chosen.length - 1)) / 2;
  const limit = Number(timeLimitSeconds ?? DEFAULT_TIME_LIMIT_SECONDS);
  const refusal = tooExpensive(pairings * seeds.length * 2, limit, `npm run ladder -- --sweep --seeds ${seeds.join(',')}`);
  if (refusal) {
    res.status(400).json({ error: refusal });
    return;
  }
  for (let i = 0; i < chosen.length; i++) {
    for (let j = i + 1; j < chosen.length; j++) {
      const series = runSeries({ definitions: [chosen[i], chosen[j]], seeds, timeLimitSeconds: limit, swapSides: true });
      for (const record of series.records) saveMatch(record);
    }
  }
  res.json(buildLadder(listMatches({ limit: 100000 })));
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

// ------------------------------------------------------------------ static site

/**
 * Serve the built viewer from the same process and the same port as the API.
 *
 * In development Vite serves the pages and proxies /api here, which means two
 * origins and a proxy rule. For anything else, a single port removes both: the
 * pages fetch /api on their own origin, so there is nothing to configure and
 * nothing to get wrong when the host is not localhost.
 */
const distDir = join(here, '../dist');
if (existsSync(distDir)) {
  app.use(express.static(distDir));
} else {
  // Better to say so than to serve a 404 that looks like a broken install.
  app.get('/', (_req, res) => {
    res
      .status(503)
      .type('text/plain')
      .send(
        'The viewer has not been built yet. Run `npm start`, which builds it and then serves it, ' +
          'or `npm run dev` for the development server. The API itself is up: try /api.',
      );
  });
}

// ----------------------------------------------------------------------- errors

app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof NotFound) {
    res.status(404).json({ error: error.message });
    return;
  }
  if (error instanceof NotReplayable) {
    // 409: the request is well formed, the stored state just conflicts with
    // what this build can reproduce.
    res.status(409).json({
      error: error.message,
      recordedVersion: error.recordVersion ?? null,
      recordedBalance: error.recordBalance ?? null,
      runningVersion: APP_VERSION,
      runningBalance: balanceFingerprint(),
    });
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
  console.log(`ant-colony-rts ${APP_VERSION} listening on http://localhost:${port}`);
  console.log(`  api        http://localhost:${port}/api`);
  console.log(`  brief      http://localhost:${port}/api/brief`);
  if (existsSync(distDir)) {
    console.log(`  viewer     http://localhost:${port}/`);
    console.log(`  changelog  http://localhost:${port}/changelog.html`);
  } else {
    console.log('  viewer     not built, run npm start to build and serve it');
  }
  console.log(`  data       ${ROOT}`);
});
