import { Simulation, type SeriesSample } from '../sim/sim.js';
import { TICKS_PER_SECOND, DEFAULT_TIME_LIMIT_SECONDS } from '../sim/config.js';
import { hashSeed } from '../sim/rng.js';
import type { BehaviourDefinition, ValidationIssue } from '../sim/definition.js';
import type { ColonyId } from '../sim/types.js';
import { describeStrategy } from '../sim/rules.js';
import { APP_VERSION } from '../meta/changelog.js';
import { balanceFingerprint, fingerprintDrift } from '../meta/fingerprint.js';
import type { Battlefield, ColonyStats, MatchRecord, RuleActivity } from './types.js';

export interface RunMatchOptions {
  definitions: [BehaviourDefinition, BehaviourDefinition];
  seed?: string | number;
  timeLimitSeconds?: number;
  definitionIssues?: [ValidationIssue[], ValidationIssue[]];
  /** Overrides the generated id, used by the API when the caller names a match. */
  id?: string;
  /** Injected so the simulation itself never touches the clock. */
  now?: Date;
}

/**
 * Run one match to completion, headless, and return the full record.
 *
 * Nothing external can influence the match once it starts: the only inputs are
 * the two definitions and the seed, which is what makes a result worth
 * comparing and a replay possible without storing every frame.
 */
export function runMatch(options: RunMatchOptions): MatchRecord {
  const timeLimitSeconds = options.timeLimitSeconds ?? DEFAULT_TIME_LIMIT_SECONDS;
  const seed = options.seed ?? 'default';
  const sim = new Simulation({ seed, timeLimitSeconds, definitions: options.definitions });

  const maxTicks = Math.round(timeLimitSeconds * TICKS_PER_SECOND) + 2;
  sim.run(maxTicks);

  const createdAt = (options.now ?? new Date()).toISOString();
  const outcome = sim.outcome;
  const winner: ColonyId | null = outcome.status === 'finished' ? outcome.winner : null;
  const scores: [number, number] =
    outcome.status === 'finished' ? outcome.scores : [sim.scoreOf(0).total, sim.scoreOf(1).total];

  const colonies: [ColonyStats, ColonyStats] = [colonyStats(sim, 0), colonyStats(sim, 1)];
  const ruleActivity: [RuleActivity[], RuleActivity[]] = [ruleActivityFor(sim, 0), ruleActivityFor(sim, 1)];

  const id =
    options.id ??
    `${createdAt.replace(/[:.]/g, '-')}_${options.definitions[0].id}_vs_${options.definitions[1].id}_seed-${String(seed)}`;

  const record: MatchRecord = {
    id,
    createdAt,
    appVersion: APP_VERSION,
    balanceHash: balanceFingerprint(),
    seed,
    seedHash: hashSeed(seed),
    timeLimitSeconds,
    durationSeconds: Math.round(sim.simSeconds),
    colonies,
    definitions: options.definitions,
    definitionIssues: options.definitionIssues ?? [[], []],
    result: {
      winner,
      winnerName: winner === null ? null : sim.colonies[winner].name,
      reason: outcome.status === 'finished' ? outcome.reason : 'unfinished',
      scores,
    },
    ruleActivity,
    battlefield: battlefieldOf(sim),
    events: sim.events,
    series: sim.series,
    digest: '',
  };
  record.digest = renderDigest(record, sim.series);
  return record;
}

/** Thrown when a stored match cannot be reproduced by the running code. */
export class NotReplayable extends Error {
  constructor(
    readonly recordVersion: string | undefined,
    readonly recordBalance: string | undefined,
    readonly reason: string,
  ) {
    super(reason);
    this.name = 'NotReplayable';
  }
}

/**
 * True if a stored record was produced by the code that is running now. Takes
 * optionals because rows written before version stamping have neither field,
 * and those are exactly the ones that must report false.
 */
export function isReplayable(record: { appVersion?: string; balanceHash?: string }): boolean {
  return record.appVersion === APP_VERSION && record.balanceHash === balanceFingerprint();
}

/**
 * Re-run a stored match and compare. Refuses rather than silently producing a
 * different game: a record is only reproducible under the code version and
 * balance numbers that made it.
 */
export function replayRecord(record: MatchRecord): { identical: boolean; replayed: MatchRecord } {
  if (record.appVersion === undefined || record.balanceHash === undefined) {
    throw new NotReplayable(
      record.appVersion,
      record.balanceHash,
      `match ${record.id} predates version stamping, so there is no way to know which code produced it. ` +
        `Running code is ${APP_VERSION} with balance ${balanceFingerprint()}.`,
    );
  }
  if (!isReplayable(record)) {
    const parts: string[] = [];
    if (record.appVersion !== APP_VERSION) parts.push(`recorded under app ${record.appVersion}, running ${APP_VERSION}`);
    if (record.balanceHash !== balanceFingerprint()) {
      // Naming the half that moved matters, because the two mean different
      // things to whoever is reading: a balance change is a deliberate retune,
      // whereas a simulation change may be a behaviour fix nobody realised
      // would invalidate their measurements.
      const drift = fingerprintDrift(record.balanceHash);
      const moved = [drift.balance ? 'balance numbers' : null, drift.simulation ? 'simulation code' : null]
        .filter(Boolean)
        .join(' and ');
      parts.push(`${moved} differ (recorded ${record.balanceHash}, running ${balanceFingerprint()})`);
    }
    throw new NotReplayable(
      record.appVersion,
      record.balanceHash,
      `match ${record.id} cannot be reproduced by this build: ${parts.join('; ')}. ` +
        'Re-running it would produce a different game, not the recorded one.',
    );
  }

  const replayed = runMatch({
    definitions: record.definitions,
    definitionIssues: record.definitionIssues,
    seed: record.seed,
    timeLimitSeconds: record.timeLimitSeconds,
    id: `${record.id}_replay`,
  });
  // Compare on outcome and the full time series rather than the id or the
  // wall-clock timestamp, which are expected to differ.
  const identical =
    JSON.stringify({ r: record.result, s: record.series, c: record.colonies }) ===
    JSON.stringify({ r: replayed.result, s: replayed.series, c: replayed.colonies });
  return { identical, replayed };
}

function battlefieldOf(sim: Simulation): Battlefield {
  const piles = [...sim.food.values()].filter((source) => source.kind === 'corpse');
  piles.sort((a, b) => b.amount - a.amount);
  return {
    piles: piles.length,
    food: Math.round(piles.reduce((total, pile) => total + pile.amount, 0)),
    biggestPile: Math.round(piles[0]?.amount ?? 0),
    deathsInBiggestPile: piles[0]?.deaths ?? 0,
  };
}

function colonyStats(sim: Simulation, id: ColonyId): ColonyStats {
  const colony = sim.colonies[id];
  return {
    definitionId: colony.definition.id,
    name: colony.name,
    author: colony.definition.author,
    version: colony.definition.version,
    unitsProduced: { ...colony.unitsProduced },
    unitsLost: { ...colony.unitsLost },
    kills: colony.kills,
    finalFood: Math.round(colony.food),
    lifetimeFood: Math.round(colony.lifetimeFoodGathered),
    foodPerMinute: sim.simSeconds > 0 ? +(colony.lifetimeFoodGathered / (sim.simSeconds / 60)).toFixed(1) : 0,
    finalWorkers: sim.countUnits(id, 'worker'),
    finalSoldiers: sim.countUnits(id, 'soldier'),
    finalQueens: sim.queensOf(id).length,
    finalNests: colony.nests.length,
    nestsFounded: colony.nestsFounded,
    queensLostInTransit: colony.queensLostInTransit,
    broodSlotsBought: colony.broodSlotsBought,
    queenAlive: sim.isAlive(id),
    queenHpPct: Math.round(sim.lowestQueenHealth(id) * 100),
    score: sim.scoreOf(id),
  };
}

/**
 * Reconstruct how long each rule was live from the event stream. A rule that
 * never activated is the clearest possible note to whoever wrote the file.
 */
function ruleActivityFor(sim: Simulation, id: ColonyId): RuleActivity[] {
  const colony = sim.colonies[id];
  const activity = new Map<string, RuleActivity>();
  for (const rule of colony.definition.rules) {
    activity.set(rule.id!, {
      ruleId: rule.id!,
      note: rule.note,
      activations: 0,
      secondsActive: 0,
      firstActivatedAt: null,
    });
  }

  const openedAt = new Map<string, number>();
  for (const event of sim.events) {
    if (event.colony !== id) continue;
    const match = /rule ([\w-]+) (on|off)/.exec(event.text);
    if (!match) continue;
    const [, ruleId, direction] = match;
    const entry = activity.get(ruleId);
    if (!entry) continue;
    if (direction === 'on') {
      entry.activations++;
      if (entry.firstActivatedAt === null) entry.firstActivatedAt = event.simSeconds;
      openedAt.set(ruleId, event.simSeconds);
    } else {
      const start = openedAt.get(ruleId);
      if (start !== undefined) {
        entry.secondsActive += event.simSeconds - start;
        openedAt.delete(ruleId);
      }
    }
  }
  for (const [ruleId, start] of openedAt) {
    const entry = activity.get(ruleId);
    if (entry) entry.secondsActive += sim.simSeconds - start;
  }
  for (const entry of activity.values()) entry.secondsActive = Math.round(entry.secondsActive);
  return [...activity.values()];
}

/** Activations above this in one match are reported as flapping. */
export const FLAP_WARNING_THRESHOLD = 3;

/** Plain text digest. Deliberately compact and dense in numbers. */
export function renderDigest(record: MatchRecord, series: SeriesSample[]): string {
  const [a, b] = record.colonies;
  const lines: string[] = [];
  lines.push(`Match ${record.id}`);
  lines.push(
    `seed=${record.seed} duration=${record.durationSeconds}s/${record.timeLimitSeconds}s result=${record.result.reason}` +
      ` winner=${record.result.winnerName ?? 'draw'} score=${record.result.scores[0].toFixed(0)}:${record.result.scores[1].toFixed(0)}`,
  );
  lines.push('');
  for (const [index, colony] of [a, b].entries()) {
    const def = record.definitions[index];
    lines.push(`[${index}] ${colony.name} (${colony.definitionId} v${colony.version ?? 1}, by ${colony.author ?? 'unknown'})`);
    lines.push(`    base: ${describeStrategy(def.base)}`);
    lines.push(
      `    produced w${colony.unitsProduced.worker}/s${colony.unitsProduced.soldier}` +
        ` lost w${colony.unitsLost.worker}/s${colony.unitsLost.soldier} kills ${colony.kills}`,
    );
    lines.push(
      `    final w${colony.finalWorkers}/s${colony.finalSoldiers} queens ${colony.finalQueens} nests ${colony.finalNests}` +
        ` (founded ${colony.nestsFounded}, ${colony.queensLostInTransit} queens killed in transit,` +
        ` ${colony.broodSlotsBought} brood slots) food ${colony.finalFood}` +
        ` lifetime ${colony.lifetimeFood} (${colony.foodPerMinute}/min) weakest queen ${colony.queenAlive ? `${colony.queenHpPct}%` : 'ELIMINATED'}`,
    );
    lines.push(
      `    score ${colony.score.total.toFixed(0)} = queens ${colony.score.queens} + workers ${colony.score.workers}` +
        ` + soldiers ${colony.score.soldiers} + stock ${colony.score.foodStockpile.toFixed(0)} + lifetime ${colony.score.lifetimeFood.toFixed(0)}`,
    );
    const rules = record.ruleActivity[index];
    if (rules.length === 0) {
      lines.push('    rules: none defined');
    } else {
      for (const rule of rules) {
        // Repeated activation is nearly always a threshold sitting where the
        // match keeps crossing it, not something the author intended.
        const flapping = rule.activations > FLAP_WARNING_THRESHOLD;
        lines.push(
          `    rule ${rule.ruleId}: ${rule.activations === 0 ? 'NEVER FIRED' : `${rule.activations}x, ${rule.secondsActive}s active, first at ${rule.firstActivatedAt}s`}` +
            (flapping ? ' FLAPPING, consider min_hold_seconds' : '') +
            (rule.note ? ` (${rule.note})` : ''),
        );
      }
    }
    const issues = record.definitionIssues[index];
    for (const issue of issues) lines.push(`    ISSUE ${issue.severity} ${issue.path}: ${issue.message}`);
    lines.push('');
  }

  const field = record.battlefield;
  lines.push(
    `battlefield: ${field.piles} corpse piles holding ${field.food} food, biggest ${field.biggestPile}` +
      ` from ${field.deathsInBiggestPile} dead. Corpses never decay, so these are worth holding.`,
  );
  lines.push('');
  lines.push('timeline (major events):');
  for (const event of record.events.filter((e) => e.major)) {
    lines.push(`  ${String(Math.round(event.simSeconds)).padStart(4)}s ${event.type}: ${event.text}`);
  }

  lines.push('');
  lines.push('series (t, workers/soldiers/nests/food/lifetime) A | B:');
  const step = Math.max(1, Math.floor(series.length / 20));
  for (let i = 0; i < series.length; i += step) {
    const s = series[i];
    lines.push(
      `  ${String(s.simSeconds).padStart(4)}s  ` +
        `${s.workers[0]}/${s.soldiers[0]}/${s.nests[0]}/${s.food[0]}/${s.lifetimeFood[0]}` +
        `  |  ${s.workers[1]}/${s.soldiers[1]}/${s.nests[1]}/${s.food[1]}/${s.lifetimeFood[1]}`,
    );
  }
  return lines.join('\n');
}
