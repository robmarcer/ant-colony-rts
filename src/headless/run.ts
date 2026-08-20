/**
 * CLI match runner.
 *
 *   npm run match -- --a rush --b example-adaptive --seed 7
 *   npm run match -- --a rush --b boom --repeat 5          (seeds 1..5)
 *   npm run match -- --list
 */
import { NotReplayable, replayRecord, runMatch } from '../match/runner.js';
import { runRoundRobin, runSeries } from '../match/tournament.js';
import {
  ensureStarterDefinitions,
  listDefinitionIds,
  listMatches,
  loadAllDefinitions,
  loadDefinition,
  readMatch,
  saveMatch,
} from '../match/store.js';
import { DEFAULT_TIME_LIMIT_SECONDS } from '../sim/config.js';

interface Args {
  [key: string]: string | boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const created = ensureStarterDefinitions();
if (created.length) console.error(`wrote starter definitions: ${created.join(', ')}`);

if (args.replay) {
  const id = args.replay === true ? (listMatches({ limit: 1 })[0]?.id ?? '') : String(args.replay);
  if (!id) {
    console.error('no stored matches to replay');
    process.exit(1);
  }
  try {
    const { identical, replayed } = replayRecord(readMatch(id));
    console.log(`replayed ${id}`);
    console.log(`  recorded: ${JSON.stringify(readMatch(id).result)}`);
    console.log(`  replayed: ${JSON.stringify(replayed.result)}`);
    console.log(identical ? '  identical, the match reproduces exactly' : '  DIFFERENT, this is a determinism bug');
    process.exit(identical ? 0 : 1);
  } catch (error) {
    if (error instanceof NotReplayable) {
      console.error(`cannot replay: ${error.message}`);
      process.exit(2);
    }
    throw error;
  }
}

if (args.matches) {
  for (const row of listMatches({ limit: Number(args.limit ?? 20) })) {
    console.log(
      `${row.replayable ? 'ok ' : 'stale'} ${String(row.appVersion ?? 'unversioned').padEnd(7)} ${row.id}`,
    );
  }
  process.exit(0);
}

if (args.list) {
  for (const id of listDefinitionIds()) {
    const { definition } = loadDefinition(id);
    console.log(`${id.padEnd(20)} v${definition.version ?? 1} by ${definition.author ?? '?'} (${definition.rules.length} rules)`);
  }
  process.exit(0);
}

if (args['round-robin']) {
  const seeds = String(args.seeds ?? '1,2').split(',');
  const defs = loadAllDefinitions().map((loaded) => loaded.definition);
  const result = runRoundRobin({ definitions: defs, seeds, timeLimitSeconds: Number(args.time ?? DEFAULT_TIME_LIMIT_SECONDS) });
  console.log('definition             played  wins  losses  draws  winrate  margin');
  for (const row of result.table) {
    console.log(
      `${row.id.padEnd(22)} ${String(row.played).padStart(6)} ${String(row.wins).padStart(5)} ` +
        `${String(row.losses).padStart(7)} ${String(row.draws).padStart(6)} ${(row.winRate * 100).toFixed(0).padStart(7)}% ${String(row.scoreMargin).padStart(8)}`,
    );
  }
  console.log(`\n${result.matchesPlayed} matches, ${result.eliminations} decided by eliminating a colony`);
  process.exit(0);
}

const aId = String(args.a ?? 'preset-balanced');
const bId = String(args.b ?? 'example-adaptive');
const timeLimit = Number(args.time ?? DEFAULT_TIME_LIMIT_SECONDS);
const repeat = Math.max(1, Number(args.repeat ?? 1));
const save = args.save !== 'false' && args['no-save'] !== true;

const a = loadDefinition(aId);
const b = loadDefinition(bId);
for (const [side, loaded] of [['A', a], ['B', b]] as const) {
  for (const issue of loaded.issues) {
    console.error(`definition ${side} ${loaded.definition.id} ${issue.severity} at ${issue.path}: ${issue.message}`);
  }
}

const tally = { a: 0, b: 0, draw: 0 };

for (let i = 0; i < repeat; i++) {
  const seed = repeat === 1 ? (args.seed !== undefined ? String(args.seed) : 'default') : String(i + 1);
  const record = runMatch({
    definitions: [a.definition, b.definition],
    definitionIssues: [a.issues, b.issues],
    seed,
    timeLimitSeconds: timeLimit,
  });
  if (save) saveMatch(record);

  if (repeat === 1) {
    console.log(record.digest);
  } else {
    console.log(
      `seed ${seed.padEnd(4)} ${String(record.result.winnerName ?? 'draw').padEnd(22)} ` +
        `${record.result.scores[0].toFixed(0).padStart(5)} : ${record.result.scores[1].toFixed(0).padEnd(5)} ` +
        `${record.result.reason} at ${record.durationSeconds}s`,
    );
  }
  if (record.result.winner === 0) tally.a++;
  else if (record.result.winner === 1) tally.b++;
  else tally.draw++;
}

if (repeat > 1) {
  console.log('');
  console.log(`${a.definition.name} ${tally.a} - ${tally.b} ${b.definition.name} (draws ${tally.draw})`);
}
if (save) console.log(`\nsaved to matches/ (use the API or matches/index.jsonl to browse)`);
