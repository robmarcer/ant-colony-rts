/**
 * The improvement loop, run outside any match.
 *
 *   npm run coach -- --definition my-strat --opponent preset-boom --rounds 3
 *
 * Each round: play a series, read the match digests, ask a model to rewrite the
 * behaviour file, save the new version, play again. The model never sees a match
 * in progress and cannot influence one; it only reads results afterwards. Every
 * call goes through the same local HTTP API an external agent would use, so this
 * doubles as a worked example of driving the testbed.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import 'dotenv/config';
import { RevisionSchema, type Revision } from './schema.js';

const API = process.env.ANT_API ?? 'http://localhost:8787';
const MODEL = 'claude-opus-5';

interface Args { [key: string]: string | boolean }

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) args[key] = true;
    else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (error) {
    throw new Error(`cannot reach the testbed API at ${API}. Start it with: npm run dev:server`);
  }
  if (!response.ok) throw new Error(`${path} responded ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

const args = parseArgs(process.argv.slice(2));
const definitionId = String(args.definition ?? 'llm-candidate');
const opponentId = String(args.opponent ?? 'preset-boom');
const seeds = String(args.seeds ?? '1,2,3').split(',');
const rounds = Number(args.rounds ?? 3);
const model = String(args.model ?? MODEL);

const client = new Anthropic();

const schema = await call<Record<string, unknown>>('/api/schema');

/** Start from an existing file if there is one, otherwise from a preset. */
async function currentDefinition(): Promise<Record<string, unknown>> {
  try {
    const loaded = await call<{ definition: Record<string, unknown> }>(`/api/definitions/${definitionId}`);
    return loaded.definition;
  } catch {
    console.log(`${definitionId} does not exist yet, seeding it from preset-balanced`);
    const seed = await call<{ definition: Record<string, unknown> }>('/api/definitions/preset-balanced');
    const fresh = { ...seed.definition, id: definitionId, name: definitionId, author: model, version: 0, rules: [] };
    await call(`/api/definitions/${definitionId}`, { method: 'PUT', body: JSON.stringify(fresh) });
    return fresh;
  }
}

interface SeriesResponse {
  wins: [number, number];
  draws: number;
  eliminations: number;
  matches: Array<{ id: string; seed: string; side: string; winner: string | null; reason: string; scores: [number, number]; durationSeconds: number }>;
  savedMatchIds: string[];
}

async function playSeries(): Promise<SeriesResponse> {
  return call<SeriesResponse>('/api/series', {
    method: 'POST',
    body: JSON.stringify({ a: definitionId, b: opponentId, seeds, swapSides: true, save: true }),
  });
}

async function digestFor(matchId: string): Promise<string> {
  const response = await fetch(`${API}/api/matches/${matchId}?view=digest`);
  return response.text();
}

const SYSTEM = `You are designing an ant colony RTS strategy for a testbed that compares strategies from different models.

You write one behaviour definition file. Once a match starts you have no further input: you cannot react, issue orders, or see the game. Everything your colony will ever do has to be encoded in the base knobs plus the conditional rules, so think about what the colony should do in situations you will not be there to see.

How rules work: every rule whose conditions all hold is applied on top of base in list order, and later rules override earlier ones. Put general phase rules first and emergency overrides last. Rules are re-evaluated once per sim second.

Three things that decide most matches:
- A trickle of single soldiers walking into an enemy base dies for nothing. If you intend to attack, hold soldiers at home with aggression 0 and use a rule on my_soldiers to commit the whole group at once.
- Never expanding loses on production. Each nest is one more build slot and 40 more units of population, so target_nests 1 caps you well below what the map can feed. Every strategy that wins consistently expands.
- Banked food is nearly worthless in the score. If the stockpile is climbing while the population is capped, the answer is another nest, not more saving.

Read the match digests carefully. A rule marked NEVER FIRED means its condition was never true, which usually means the threshold is wrong, not that the idea is wrong.`;

function buildPrompt(definition: Record<string, unknown>, series: SeriesResponse, digests: string[], round: number): string {
  return [
    `Round ${round}. You are colony "${definitionId}", playing against "${opponentId}" over ${seeds.length} mirrored seeds with sides swapped.`,
    '',
    'Game reference (knobs, rule metrics, unit stats, scoring):',
    JSON.stringify(schema, null, 2),
    '',
    'Your current behaviour definition:',
    JSON.stringify(definition, null, 2),
    '',
    `Series result: you won ${series.wins[0]} of ${series.matches.length}, opponent won ${series.wins[1]}, draws ${series.draws}, ${series.eliminations} decided by wiping out every enemy queen.`,
    '',
    'Match digests:',
    ...digests,
    '',
    'Revise your behaviour definition to beat this opponent. Return the complete file, not a patch. Explain your reasoning first, then put a short summary of the plan in notes so your future self can read it in the next round.',
  ].join('\n');
}

async function reviseDefinition(prompt: string): Promise<Revision> {
  let response;
  try {
    response = await client.messages.parse({
      model,
      max_tokens: 16000,
      system: SYSTEM,
      thinking: { type: 'adaptive' },
      output_config: { format: zodOutputFormat(RevisionSchema), effort: 'high' },
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/authentication|api.?key|credential/i.test(message)) {
      throw new Error(
        'no Anthropic credentials found. Put ANTHROPIC_API_KEY in .env (see .env.example), export it, ' +
          'or sign in with `ant auth login`. The rest of the testbed works without a key: write definition ' +
          'files by hand or through the API and run matches with npm run match.',
      );
    }
    throw error;
  }
  if (!response.parsed_output) throw new Error(`model returned no parseable revision (stop reason ${response.stop_reason})`);
  return response.parsed_output;
}

// ------------------------------------------------------------------- main loop

let definition = await currentDefinition();
const history: Array<{ round: number; wins: number; played: number }> = [];

for (let round = 1; round <= rounds; round++) {
  console.log(`\n=== round ${round}: playing ${definitionId} vs ${opponentId} ===`);
  const series = await playSeries();
  console.log(`  ${series.wins[0]} - ${series.wins[1]} (draws ${series.draws}, ${series.eliminations} eliminations)`);
  history.push({ round, wins: series.wins[0], played: series.matches.length });

  if (round === rounds) break;

  // Give the model the first two digests in full; more than that is mostly repetition.
  const digests = await Promise.all(series.savedMatchIds.slice(0, 2).map(digestFor));
  console.log(`  asking ${model} to revise the definition`);
  const revision = await reviseDefinition(buildPrompt(definition, series, digests, round));
  console.log(`  reasoning: ${revision.reasoning.slice(0, 400)}${revision.reasoning.length > 400 ? '...' : ''}`);

  const next = {
    id: definitionId,
    name: definitionId,
    author: model,
    version: Number(definition.version ?? 0) + 1,
    notes: revision.notes,
    base: revision.base,
    rules: revision.rules,
  };
  const saved = await call<{ definition: Record<string, unknown>; issues: Array<{ path: string; message: string }> }>(
    `/api/definitions/${definitionId}`,
    { method: 'PUT', body: JSON.stringify(next) },
  );
  for (const issue of saved.issues) console.log(`  REJECTED ${issue.path}: ${issue.message}`);
  definition = saved.definition;
  console.log(`  saved v${definition.version} with ${(definition.rules as unknown[]).length} rules`);
}

console.log('\nwin rate by round:');
for (const row of history) console.log(`  round ${row.round}: ${row.wins}/${row.played}`);
