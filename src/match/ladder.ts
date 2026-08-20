/**
 * The ladder: ratings across every definition, computed from stored matches.
 *
 * Two deliberate choices.
 *
 * Bradley-Terry rather than Elo. Elo depends on the order matches were played,
 * so the same set of results processed differently gives different ratings. This
 * project's whole value rests on results being reproducible, so the ladder is a
 * pure function of the match set: recompute it any time and get the same answer.
 *
 * Ratings only pool matches that are actually comparable, meaning ones played
 * under the running app version and balance numbers. A change to a unit cost
 * makes older results a different game, and averaging across that would produce
 * a confident number about nothing.
 */
import { balanceFingerprint } from '../meta/fingerprint.js';
import { winRateInterval } from './tournament.js';
import type { MatchSummaryRow } from './types.js';

export interface LadderRow {
  key: string;
  id: string;
  version: number;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  /** 95% Wilson interval on the win rate. */
  low: number;
  high: number;
  /** Bradley-Terry strength on an Elo-like scale, mean 1500. */
  rating: number;
}

export interface Ladder {
  balanceHash: string;
  matchesConsidered: number;
  matchesIgnored: number;
  rows: LadderRow[];
  /** Head to head, keyed "a vs b" with a's wins first. */
  pairs: Array<{ a: string; b: string; wins: [number, number]; draws: number }>;
  note: string;
}

function keyOf(id: string, version: number | undefined): string {
  return `${id}@v${version ?? 1}`;
}

/**
 * Bradley-Terry strengths by the standard MM update. Converges quickly and is
 * independent of the order results are supplied in, which is the point.
 */
function bradleyTerry(
  competitors: string[],
  wins: Map<string, number>,
  meetings: Map<string, number>,
  iterations = 200,
): Map<string, number> {
  const strength = new Map(competitors.map((c) => [c, 1]));
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  for (let iter = 0; iter < iterations; iter++) {
    const next = new Map<string, number>();
    for (const a of competitors) {
      let denominator = 0;
      for (const b of competitors) {
        if (a === b) continue;
        const n = meetings.get(pairKey(a, b)) ?? 0;
        if (n === 0) continue;
        denominator += n / (strength.get(a)! + strength.get(b)!);
      }
      const w = wins.get(a) ?? 0;
      // A competitor with no wins would go to zero and take the log with it, so
      // hold it at a small floor instead.
      next.set(a, denominator > 0 && w > 0 ? w / denominator : 1e-6);
    }
    // Normalise to a geometric mean of 1 so the scale cannot drift.
    const logs = [...next.values()].map((v) => Math.log(v));
    const mean = logs.reduce((sum, v) => sum + v, 0) / (logs.length || 1);
    for (const [k, v] of next) strength.set(k, v / Math.exp(mean));
  }
  return strength;
}

/**
 * Build the ladder from stored match rows. Rows from other balance numbers are
 * counted and reported but never mixed in.
 */
export function buildLadder(rows: MatchSummaryRow[]): Ladder {
  const hash = balanceFingerprint();
  const usable = rows.filter((row) => row.balanceHash === hash);

  const wins = new Map<string, number>();
  const meetings = new Map<string, number>();
  const record = new Map<string, { wins: number; losses: number; draws: number; games: number; id: string; version: number }>();
  const pairs = new Map<string, { a: string; b: string; wins: [number, number]; draws: number }>();
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  const touch = (key: string, id: string, version: number) => {
    if (!record.has(key)) record.set(key, { wins: 0, losses: 0, draws: 0, games: 0, id, version });
    return record.get(key)!;
  };

  for (const row of usable) {
    const aKey = keyOf(row.a, row.aVersion);
    const bKey = keyOf(row.b, row.bVersion);
    if (aKey === bKey) continue; // a mirror match tells us nothing about ranking
    const a = touch(aKey, row.a, row.aVersion ?? 1);
    const b = touch(bKey, row.b, row.bVersion ?? 1);
    a.games++;
    b.games++;

    const pk = pairKey(aKey, bKey);
    if (!pairs.has(pk)) {
      const [first, second] = aKey < bKey ? [aKey, bKey] : [bKey, aKey];
      pairs.set(pk, { a: first, b: second, wins: [0, 0], draws: 0 });
    }
    const pair = pairs.get(pk)!;
    meetings.set(pk, (meetings.get(pk) ?? 0) + 1);

    // A draw counts as half a win each, which is what Bradley-Terry expects.
    if (row.winner === null) {
      a.draws++;
      b.draws++;
      pair.draws++;
      wins.set(aKey, (wins.get(aKey) ?? 0) + 0.5);
      wins.set(bKey, (wins.get(bKey) ?? 0) + 0.5);
      continue;
    }
    // The stored winner is a name; both sides can share one, so fall back to
    // whichever definition id matches.
    const aWon = row.winner === row.a || (row.winner !== row.b && row.winner === row.a);
    const winnerKey = aWon ? aKey : bKey;
    const loserKey = aWon ? bKey : aKey;
    record.get(winnerKey)!.wins++;
    record.get(loserKey)!.losses++;
    wins.set(winnerKey, (wins.get(winnerKey) ?? 0) + 1);
    if (winnerKey === pair.a) pair.wins[0]++;
    else pair.wins[1]++;
  }

  const competitors = [...record.keys()].sort();
  const strengths = bradleyTerry(competitors, wins, meetings);

  const rowsOut: LadderRow[] = competitors.map((key) => {
    const r = record.get(key)!;
    const decided = r.wins + r.losses;
    const interval = winRateInterval(r.wins, decided);
    return {
      key,
      id: r.id,
      version: r.version,
      games: r.games,
      wins: r.wins,
      losses: r.losses,
      draws: r.draws,
      winRate: interval.rate,
      low: interval.low,
      high: interval.high,
      // 400 per decade is the Elo convention, anchored at 1500.
      rating: Math.round(1500 + 400 * Math.log10(Math.max(1e-9, strengths.get(key)!))),
    };
  });
  rowsOut.sort((a, b) => b.rating - a.rating || b.winRate - a.winRate || (a.key < b.key ? -1 : 1));

  return {
    balanceHash: hash,
    matchesConsidered: usable.length,
    matchesIgnored: rows.length - usable.length,
    rows: rowsOut,
    pairs: [...pairs.values()],
    note:
      'Bradley-Terry strengths on an Elo-like scale, mean 1500, computed from every stored match played under the ' +
      'running balance numbers. Order independent: recomputing gives the same answer. Matches from other balance ' +
      'numbers are ignored rather than mixed in, because a change to the simulation makes them a different game.',
  };
}
