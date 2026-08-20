/**
 * Series and round robin runner. Comparing two definitions over one match is
 * noise; a series over several seeds on a mirrored map is the actual signal.
 */
import { runMatch } from './runner.js';
import type { BehaviourDefinition } from '../sim/definition.js';
import type { MatchRecord } from './types.js';
import { DEFAULT_TIME_LIMIT_SECONDS } from '../sim/config.js';

export interface SeriesOptions {
  definitions: [BehaviourDefinition, BehaviourDefinition];
  seeds: Array<string | number>;
  timeLimitSeconds?: number;
  /**
   * Play every seed twice with the sides swapped. The map is mirrored so this
   * is not strictly necessary, but it cancels any residual side bias.
   */
  swapSides?: boolean;
}

export interface SeriesResult {
  a: string;
  b: string;
  wins: [number, number];
  draws: number;
  eliminations: number;
  matches: Array<{
    id: string;
    seed: string | number;
    side: 'normal' | 'swapped';
    winner: string | null;
    reason: string;
    scores: [number, number];
    durationSeconds: number;
  }>;
  records: MatchRecord[];
}

export function runSeries(options: SeriesOptions): SeriesResult {
  const [defA, defB] = options.definitions;
  const timeLimitSeconds = options.timeLimitSeconds ?? DEFAULT_TIME_LIMIT_SECONDS;
  const result: SeriesResult = {
    a: defA.id,
    b: defB.id,
    wins: [0, 0],
    draws: 0,
    eliminations: 0,
    matches: [],
    records: [],
  };

  const orders: Array<'normal' | 'swapped'> = options.swapSides ? ['normal', 'swapped'] : ['normal'];

  for (const seed of options.seeds) {
    for (const side of orders) {
      const pair: [BehaviourDefinition, BehaviourDefinition] = side === 'normal' ? [defA, defB] : [defB, defA];
      const record = runMatch({ definitions: pair, seed, timeLimitSeconds });
      result.records.push(record);

      // Normalise the winner back to A/B regardless of which side they played.
      let winnerIndex: 0 | 1 | null = record.result.winner;
      if (winnerIndex !== null && side === 'swapped') winnerIndex = winnerIndex === 0 ? 1 : 0;
      if (winnerIndex === null) result.draws++;
      else result.wins[winnerIndex]++;
      if (record.result.reason === 'colony_eliminated') result.eliminations++;

      result.matches.push({
        id: record.id,
        seed,
        side,
        winner: winnerIndex === null ? null : [defA.id, defB.id][winnerIndex],
        reason: record.result.reason,
        scores: record.result.scores,
        durationSeconds: record.durationSeconds,
      });
    }
  }
  return result;
}

export interface RoundRobinOptions {
  definitions: BehaviourDefinition[];
  seeds: Array<string | number>;
  timeLimitSeconds?: number;
}

export interface RoundRobinResult {
  table: Array<{
    id: string;
    name: string;
    played: number;
    wins: number;
    losses: number;
    draws: number;
    winRate: number;
    /** Sum of score margin over every match, a tiebreaker and a dominance hint. */
    scoreMargin: number;
  }>;
  pairs: Array<{ a: string; b: string; wins: [number, number]; draws: number }>;
  eliminations: number;
  matchesPlayed: number;
}

export function runRoundRobin(options: RoundRobinOptions): RoundRobinResult {
  const defs = options.definitions;
  const stats = new Map(
    defs.map((definition) => [
      definition.id,
      { id: definition.id, name: definition.name, played: 0, wins: 0, losses: 0, draws: 0, winRate: 0, scoreMargin: 0 },
    ]),
  );
  const pairs: RoundRobinResult['pairs'] = [];
  let eliminations = 0;
  let matchesPlayed = 0;

  for (let i = 0; i < defs.length; i++) {
    for (let j = i + 1; j < defs.length; j++) {
      const series = runSeries({
        definitions: [defs[i], defs[j]],
        seeds: options.seeds,
        timeLimitSeconds: options.timeLimitSeconds,
        swapSides: true,
      });
      pairs.push({ a: defs[i].id, b: defs[j].id, wins: series.wins, draws: series.draws });
      eliminations += series.eliminations;
      matchesPlayed += series.matches.length;

      const sa = stats.get(defs[i].id)!;
      const sb = stats.get(defs[j].id)!;
      sa.played += series.matches.length;
      sb.played += series.matches.length;
      sa.wins += series.wins[0];
      sb.wins += series.wins[1];
      sa.losses += series.wins[1];
      sb.losses += series.wins[0];
      sa.draws += series.draws;
      sb.draws += series.draws;

      for (const match of series.matches) {
        const [scoreA, scoreB] = match.side === 'normal' ? match.scores : [match.scores[1], match.scores[0]];
        sa.scoreMargin += scoreA - scoreB;
        sb.scoreMargin += scoreB - scoreA;
      }
    }
  }

  const table = [...stats.values()].map((row) => ({
    ...row,
    winRate: row.played ? +(row.wins / row.played).toFixed(3) : 0,
    scoreMargin: Math.round(row.scoreMargin),
  }));
  table.sort((x, y) => y.winRate - x.winRate || y.scoreMargin - x.scoreMargin);
  return { table, pairs, eliminations, matchesPlayed };
}
