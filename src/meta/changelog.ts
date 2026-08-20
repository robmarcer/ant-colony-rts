/**
 * Changelog. Single source of truth for the app version, the in-app changelog
 * view, GET /api/changelog, and the generated CHANGELOG.md.
 *
 * Convention: add an entry here in the same change that alters behaviour, then
 * run `npm run changelog` to regenerate CHANGELOG.md. Newest entry first.
 *
 * On timestamps: entries marked 'commit' carry the author time of the real git
 * commit the change landed in, read from git rather than typed by hand. Find the
 * commit with `git log --grep '<version>'` or the version tag. Two entries share
 * a timestamp when they landed in the same commit, which is the honest record.
 *
 * Entries marked 'reconstructed' predate version control on this project. Their
 * times come from file modification times, so they place the change to the
 * minute the file was last written rather than to a commit that never existed.
 * That distinction is recorded rather than smoothed over: a changelog which
 * quietly invents precision is worse than one that admits the gap.
 */

export type ChangeArea = 'sim' | 'ai' | 'balance' | 'perf' | 'api' | 'ui' | 'tests' | 'docs' | 'tooling';

export interface ChangelogChange {
  area: ChangeArea;
  detail: string;
  /** True when this corrected a defect rather than adding behaviour. */
  fix?: boolean;
}

export interface ChangelogEntry {
  version: string;
  /** ISO 8601 with a UTC offset. */
  timestamp: string;
  title: string;
  precision: 'commit' | 'reconstructed';
  /** Short git SHA, once the change has one. */
  commit?: string;
  changes: ChangelogChange[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '0.8.0',
    timestamp: '2026-08-20T14:39:21+07:00',
    title: 'Stalemated matches end instead of running the clock out',
    precision: 'commit',
    changes: [
      { area: 'sim', detail: 'A match now ends as a stalemate when nothing material has changed for 600 sim seconds, resolved on score exactly as the time limit is. At the 90,000 second default, two passive strategies previously ran the full limit, decided nothing, and cost 30 seconds of compute each.', fix: true },
      { area: 'sim', detail: 'Progress is measured against a signature of the strategic position: nests, queens, weakest queen health, and unit counts within a tolerance of 2. A death-based check does not work, because two colonies parked at their population ceiling still trade the odd worker every few minutes while being completely stagnant, which would reset the window forever.' },
      { area: 'sim', detail: 'New stalemateWindowSeconds option, 0 to disable, and a logged stalemate event naming the window so the digest says why a match ended when it did.' },
      { area: 'perf', detail: 'preset-turtle against itself went from 90,000 sim seconds and 30 seconds of compute to 864 sim seconds and 0.4 seconds, about 75 times cheaper. preset-boom against preset-turtle went from 26 seconds of compute to 7.5, and preset-rush against preset-boom from 33.7 to well under a second.' },
      { area: 'sim', detail: 'A side effect worth knowing: this also resolves matches where a colony has been starved to a single queen with no workers and no food, and therefore cannot ever produce again, but the winner has aggression too low to walk over and finish it. preset-rush against preset-boom is exactly that, and used to burn the full 90,000 seconds to reach a verdict that was settled at 2,590.' },
      { area: 'tests', detail: 'Four checks: a passive pairing ends as a stalemate well short of the limit and logs its window, a decisive pairing is still decided by elimination, and the detector can be switched off. Verified against the whole field that this changes no live match: a 112 match round robin at 900 seconds returns byte-identical win rates, margins and elimination count.' },
    ],
  },
  {
    version: '0.7.0',
    timestamp: '2026-08-20T14:32:09+07:00',
    title: 'Stored matches are pinned to the code that made them',
    precision: 'commit',
    changes: [
      { area: 'api', detail: 'Match records carry appVersion and balanceHash, the latter a hash over every tunable value exported from src/sim/config.ts. Without them a stored match was only reproducible by accident: the six records already on disk were made on a 100x100 map with decaying 40% corpses and a 900 second limit, and replaying one under 0.6.0 silently produced a different game.', fix: true },
      { area: 'api', detail: 'New POST /api/matches/:id/replay re-runs a stored match and reports whether it reproduced. Returns 409, naming both the recorded and running version and balance, when this build cannot reproduce it.' },
      { area: 'api', detail: 'GET /api/matches marks every row replayable or not against the running build, decided at read time rather than trusted from the file. GET /api/health reports the balance hash alongside the version.' },
      { area: 'tooling', detail: 'npm run match -- --replay [id] re-runs a stored match, defaulting to the newest, and exits 2 when the record cannot be reproduced. --matches lists stored records with their version and replay status.' },
      { area: 'ui', detail: 'The past-match picker disables records this build cannot reproduce and says which version they need, instead of quietly replaying a different game.', fix: true },
      { area: 'tests', detail: 'Six checks covering the round trip: a fresh record is stamped and replays exactly, and replay is refused for a mismatched app version, mismatched balance numbers, and a record from before stamping existed. Both halves of the stamp are tested separately so neither can quietly stop being load bearing.' },
    ],
  },
  {
    version: '0.6.0',
    timestamp: '2026-08-20T14:10:24+07:00',
    title: 'The map is a closed system',
    precision: 'commit',
    changes: [
      { area: 'sim', detail: 'Corpses return 100% of the unit cost rather than 40%, plus whatever the unit was carrying. A worker now leaves 10, a soldier 30, a queen 200. Energy on the map is neither created nor destroyed: it only moves between the ground, a worker in transit, a colony stockpile, and the units built from it.' },
      { area: 'sim', detail: 'A queen dying mid-build also returns the energy already invested in the unit she was producing. Without this, killing a queen quietly destroyed up to 200 food of brood and the system was not closed.', fix: true },
      { area: 'sim', detail: 'Removed QUEEN_CORPSE_VALUE. A queen returns her actual cost, so there is no longer a special case to keep in step with the price of a queen.' },
      { area: 'sim', detail: 'New Simulation.totalEnergy(), summing food on the ground, in transit, banked, and embodied in living and part-built units.' },
      { area: 'tests', detail: 'Conservation is asserted, not assumed: energy is sampled every 100 ticks across a 3,000 second match and must not drift by more than 1e-6, with a separate check for a queen killed mid-build. Measured drift was exactly zero across 30,000 ticks.' },
      { area: 'balance', detail: 'Combat is no longer a net drain on the world, so a long match settles into a sustainable attrition equilibrium instead of both colonies starving. Battlefields are richer: a dead soldier is now worth 30 rather than 12.' },
      { area: 'docs', detail: 'README, the authoring guide and GET /api/schema updated with the new corpse values and the closed system property.' },
    ],
  },
  {
    version: '0.5.0',
    timestamp: '2026-08-20T14:10:24+07:00',
    title: 'Default match length raised to 90,000 sim seconds',
    precision: 'commit',
    changes: [
      { area: 'sim', detail: 'DEFAULT_TIME_LIMIT_SECONDS raised from 900 to 90,000, so matches are decided by one colony eliminating the other rather than by the clock. The viewer default matches.' },
      { area: 'api', detail: 'The series and round robin endpoints now refuse a request whose estimated compute exceeds 300 seconds, rather than only counting matches. At the new default one match is roughly 30 seconds of compute, so the old count-only guard would have allowed a request that blocked for half an hour.', fix: true },
      { area: 'docs', detail: 'README records what long matches actually do, measured: a decisive pairing still ends in about 360 seconds, but two passive strategies run the full 90,000 and cost 30 seconds of compute each.' },
    ],
  },
  {
    version: '0.4.0',
    timestamp: '2026-08-20T14:03:56+07:00',
    title: 'Changelog, app version and version control',
    precision: 'commit',
    changes: [
      { area: 'ui', detail: 'Header shows the app version as a text link that opens the changelog. Deep link via the #changelog fragment.' },
      { area: 'ui', detail: 'In-app changelog view listing every release, its timestamp and the individual changes, grouped by area.' },
      { area: 'api', detail: 'GET /api/changelog returns the full changelog. GET /api and GET /api/health now report the app version.' },
      { area: 'tooling', detail: 'Project put under git and pushed to a private GitHub repo, so future changes have real commit provenance.' },
      { area: 'tooling', detail: 'npm run changelog regenerates CHANGELOG.md from src/meta/changelog.ts, so the markdown cannot drift from the data.' },
      { area: 'tests', detail: 'Self test asserts the changelog is well formed: unique versions, parseable timestamps, newest first, every entry has changes, and APP_VERSION matches the newest entry.' },
      { area: 'docs', detail: 'README documents the changelog convention: add an entry in the same change, never as a follow up.' },
    ],
  },
  {
    version: '0.3.0',
    timestamp: '2026-08-20T13:50:05+07:00',
    title: 'Battlefields persist',
    precision: 'reconstructed',
    changes: [
      { area: 'sim', detail: 'Corpses no longer decay. Removed the decayPerSecond field and the per-tick decay pass entirely rather than setting the rate to zero, so there is no dead mechanism left behind.' },
      { area: 'sim', detail: 'A corpse landing within 6 cells of an existing pile merges into it and increments its death count. Without this, hundreds of permanent 4 food crumbs would drag workers into long trips for a fraction of a load, since nearest_food_first scores on distance alone. Measured: 74 deaths become 13 piles, the largest holding 307 food.' },
      { area: 'api', detail: 'Match records and digests carry a battlefield summary: pile count, total food on the ground, and the size of the largest pile.' },
      { area: 'docs', detail: 'Corrected the claim that every corpse is worth 40% of its unit cost. That holds for workers (4) and soldiers (12); a queen leaves a flat 60.', fix: true },
      { area: 'tests', detail: 'Self test grew from 38 to 44 checks, covering no decay, proximity merging, distant corpses staying separate, and piles worth more than one worker load.' },
    ],
  },
  {
    version: '0.2.0',
    timestamp: '2026-08-20T13:39:27+07:00',
    title: 'Queens found new nests, and a map with room for them',
    precision: 'reconstructed',
    changes: [
      { area: 'sim', detail: 'Queens can produce queens. A new queen costs 200 food and 60 seconds, walks to a founding site at 1.1 cells per second, then settles permanently and founds a nest.' },
      { area: 'sim', detail: 'A colony holds several nests. Every settled queen has her own build slot drawing on the shared food stockpile, so nests multiply production throughput.' },
      { area: 'sim', detail: 'Each nest supports 40 workers and soldiers. Added because unconstrained production let a colony reach 468 workers, which was both unreadable and slow; it also makes expanding the only way to raise your ceiling.' },
      { area: 'sim', detail: 'Map grew from 100x100 to 200x200 with home nests at (40,40) and (160,160), 30 mirrored food pairs, longer vision, and a 900 second default match.' },
      { area: 'sim', detail: 'Elimination now requires killing every enemy queen. Losing one queen destroys her nest but not the colony. Outcome reason renamed to colony_eliminated.' },
      { area: 'sim', detail: 'New knob target_nests (1 to 6). New rule metrics: my_nests, enemy_nests, my_queens, enemy_queens, my_founding_queens, enemy_founding_queens. my_queen_hp_pct now reports the weakest queen in the colony.' },
      { area: 'ai', detail: 'Founding sites are chosen by the simulation: the best remembered food cluster at least 34 cells from your own nests and 30 from any enemy nest, weighted by distance from the parent nest and by risk_tolerance.' },
      { area: 'ai', detail: 'Soldiers anchor their defence on the nearest nest or a queen walking to a site, so escorting an expansion is emergent rather than another posture to pick.' },
      { area: 'ai', detail: 'harass_enemy_workers prefers a walking queen over a worker, giving expansion a real counter.' },
      { area: 'ai', detail: 'contest_enemy_food sent workers to whatever food sat closest to the enemy nest, which on a 200 cell map was a 50 second walk to their death: 370 food hauled in a whole match against an opponent 18,020. Haul distance is now capped at 100 cells, so it contests the middle ground. Hauling rose to 1,590 and kills from 13 to 129.', fix: true },
      { area: 'tooling', detail: 'The tournament runner still matched the old outcome name and reported 0 eliminations out of 112 matches. The real figure was 49.', fix: true },
      { area: 'ui', detail: 'Finishing a match refreshed the definition list and reset both dropdowns, silently discarding the selection.', fix: true },
      { area: 'ui', detail: 'The match summary quoted scoring weights that no longer matched the config. The wording is now generated from the weights themselves so it cannot drift again.', fix: true },
      { area: 'ui', detail: 'Viewer draws every nest, dashes a walking queen path to her target site, outlines a founding queen, and shows queens, nests and all parallel build slots in the HUD.' },
      { area: 'balance', detail: 'Banked food dropped from 1 point to 0.1 and queens rose from 100 to 150. A passive colony banking 15,000 food swamped every other scoring term, so the score rewarded hoarding over playing.' },
      { area: 'balance', detail: 'preset-harass moved from aggression 0.70 to 0.65, off the exact threshold at which workers also join fights and throw away the worker base.' },
      { area: 'perf', detail: 'A 900 second match went from 9.2 seconds to 1.1 seconds. Added a per-tick spatial grid for proximity queries, and cached two things that were being recomputed for every soldier on every tick: its rank within the army, and the list of enemies standing in its nests.' },
      { area: 'tests', detail: 'Self test grew from 21 to 38 checks, covering target_nests in both directions, nest separation, no queen left walking, population capacity, and losing one queen versus losing the last.' },
    ],
  },
  {
    version: '0.1.0',
    timestamp: '2026-08-20T12:43:24+07:00',
    title: 'Initial testbed',
    precision: 'reconstructed',
    changes: [
      { area: 'sim', detail: 'Deterministic fixed-timestep simulation, seeded from a string or number, with no I/O or DOM references so the same code runs headless and in the browser. Same seed gives an identical state fingerprint, and stepping tick by tick equals running in bulk.' },
      { area: 'sim', detail: 'Grid map with mirrored food generation, queen, worker and soldier units, colony food memory as the intel mechanic, tick-based combat, and corpses modelled as food sources so foraging needs no second code path.' },
      { area: 'sim', detail: 'Behaviour definitions are base knobs plus an ordered list of conditional rules, evaluated once per sim second inside the simulation. Replaced the original in-match LLM polling design so a match is a pure function of two definition files and a seed.' },
      { area: 'ai', detail: 'Worker foraging, hauling, scouting and reluctant fighting; soldier posture with an aggression-driven push split and risk-gated engagement; queen production steering toward a target army composition.' },
      { area: 'sim', detail: 'Queens regenerated 3% of 500 health per second inside the nest, which is 15 per second against a soldier dealing 9. No queen could ever be killed, so the primary win condition was unreachable. Queens no longer regenerate.', fix: true },
      { area: 'ui', detail: 'At speeds of 1x to 5x, elapsed time times ten times the multiplier rounded to zero ticks every frame, so the match never advanced. Fractional ticks now accumulate between frames.', fix: true },
      { area: 'api', detail: 'Local HTTP API: definition CRUD, dry-run validation, single matches, seed series with sides swapped, round robin, per-definition win records, and match logs with per-rule activity.' },
      { area: 'ui', detail: 'Canvas viewer with per-colony HUD, live strategy knobs and active rules, playback controls, an intel overlay, and an end-of-match summary with a timeline.' },
      { area: 'tooling', detail: 'Headless CLI match runner, self test, file-backed store for definitions and match records, and an optional coach loop that calls Claude to revise a definition between matches, never during one.' },
      { area: 'balance', detail: 'First round robin: 8 starter definitions, 112 matches, 37% decided by a queen kill, win rates spread from 0% to 86%.' },
    ],
  },
];

/** The running version, taken from the newest changelog entry. */
export const APP_VERSION = CHANGELOG[0].version;

/** Total number of recorded changes, shown in the changelog header. */
export function totalChanges(): number {
  return CHANGELOG.reduce((count, entry) => count + entry.changes.length, 0);
}
