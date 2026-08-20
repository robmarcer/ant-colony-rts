import type { BehaviourDefinition, ValidationIssue } from '../sim/definition.js';
import type { SeriesSample } from '../sim/sim.js';
import type { ColonyId, MatchEvent, ScoreBreakdown, UnitType } from '../sim/types.js';

export interface ColonyStats {
  definitionId: string;
  name: string;
  author?: string;
  version?: number;
  unitsProduced: Record<UnitType, number>;
  unitsLost: Record<UnitType, number>;
  kills: number;
  finalFood: number;
  lifetimeFood: number;
  foodPerMinute: number;
  finalWorkers: number;
  finalSoldiers: number;
  finalQueens: number;
  finalNests: number;
  nestsFounded: number;
  queensLostInTransit: number;
  /** True while the colony still has at least one queen. */
  queenAlive: boolean;
  queenHpPct: number;
  score: ScoreBreakdown;
}

/** Per-rule feedback: the single most useful signal when revising a definition. */
export interface RuleActivity {
  ruleId: string;
  note?: string;
  activations: number;
  secondsActive: number;
  firstActivatedAt: number | null;
}

/** Corpse piles left standing at the end of a match. */
export interface Battlefield {
  piles: number;
  food: number;
  biggestPile: number;
  deathsInBiggestPile: number;
}

export interface MatchRecord {
  id: string;
  createdAt: string;
  /** App version that produced this record. */
  appVersion: string;
  /** Hash of the balance numbers in src/sim/config.ts at the time. */
  balanceHash: string;
  seed: string | number;
  seedHash: number;
  timeLimitSeconds: number;
  durationSeconds: number;
  colonies: [ColonyStats, ColonyStats];
  /** Exact definitions used, snapshotted so a match stays reproducible. */
  definitions: [BehaviourDefinition, BehaviourDefinition];
  /** Anything the parser rejected in either definition before the match ran. */
  definitionIssues: [ValidationIssue[], ValidationIssue[]];
  result: {
    winner: ColonyId | null;
    winnerName: string | null;
    reason: string;
    scores: [number, number];
  };
  ruleActivity: [RuleActivity[], RuleActivity[]];
  /** Corpses never decay, so this is contested ground worth reading about. */
  battlefield: Battlefield;
  events: MatchEvent[];
  series: SeriesSample[];
  /** Pre-rendered plain text digest, so a reader does not have to walk the JSON. */
  digest: string;
}

export interface MatchSummaryRow {
  id: string;
  createdAt: string;
  appVersion?: string;
  balanceHash?: string;
  /**
   * Whether this record can still be reproduced by the running code. Computed
   * when the row is read, not when it was written, since it is a statement
   * about the code you are running now.
   */
  replayable?: boolean;
  seed: string | number;
  a: string;
  b: string;
  winner: string | null;
  reason: string;
  scores: [number, number];
  durationSeconds: number;
}
