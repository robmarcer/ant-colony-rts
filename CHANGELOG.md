# Changelog

Current version: **0.6.0**. 6 releases, 50 recorded changes.

Generated from `src/meta/changelog.ts` by `npm run changelog`. Edit the data, not this file.

Entries marked *reconstructed* predate version control on this project. Their timestamps were derived from file modification times and the timestamps inside saved match records, so they are accurate to the hour rather than the minute, and there are no commits behind them. Entries marked with a commit hash have exact provenance in git.

## 0.6.0 — The map is a closed system

2026-08-20 14:45 (UTC+07:00) · committed · 7 changes

**Simulation**

- Corpses return 100% of the unit cost rather than 40%, plus whatever the unit was carrying. A worker now leaves 10, a soldier 30, a queen 200. Energy on the map is neither created nor destroyed: it only moves between the ground, a worker in transit, a colony stockpile, and the units built from it.
- Fix: A queen dying mid-build also returns the energy already invested in the unit she was producing. Without this, killing a queen quietly destroyed up to 200 food of brood and the system was not closed.
- Removed QUEEN_CORPSE_VALUE. A queen returns her actual cost, so there is no longer a special case to keep in step with the price of a queen.
- New Simulation.totalEnergy(), summing food on the ground, in transit, banked, and embodied in living and part-built units.

**Balance**

- Combat is no longer a net drain on the world, so a long match settles into a sustainable attrition equilibrium instead of both colonies starving. Battlefields are richer: a dead soldier is now worth 30 rather than 12.

**Tests**

- Conservation is asserted, not assumed: energy is sampled every 100 ticks across a 3,000 second match and must not drift by more than 1e-6, with a separate check for a queen killed mid-build. Measured drift was exactly zero across 30,000 ticks.

**Docs**

- README, the authoring guide and GET /api/schema updated with the new corpse values and the closed system property.

## 0.5.0 — Default match length raised to 90,000 sim seconds

2026-08-20 14:30 (UTC+07:00) · committed · 3 changes

**Simulation**

- DEFAULT_TIME_LIMIT_SECONDS raised from 900 to 90,000, so matches are decided by one colony eliminating the other rather than by the clock. The viewer default matches.

**API**

- Fix: The series and round robin endpoints now refuse a request whose estimated compute exceeds 300 seconds, rather than only counting matches. At the new default one match is roughly 30 seconds of compute, so the old count-only guard would have allowed a request that blocked for half an hour.

**Docs**

- README records what long matches actually do, measured: a decisive pairing still ends in about 360 seconds, but two passive strategies run the full 90,000 and cost 30 seconds of compute each.

## 0.4.0 — Changelog, app version and version control

2026-08-20 14:05 (UTC+07:00) · reconstructed · 7 changes

**API**

- GET /api/changelog returns the full changelog. GET /api and GET /api/health now report the app version.

**Viewer**

- Header shows the app version as a text link that opens the changelog. Deep link via the #changelog fragment.
- In-app changelog view listing every release, its timestamp and the individual changes, grouped by area.

**Tests**

- Self test asserts the changelog is well formed: unique versions, parseable timestamps, newest first, every entry has changes, and APP_VERSION matches the newest entry.

**Docs**

- README documents the changelog convention: add an entry in the same change, never as a follow up.

**Tooling**

- Project put under git and pushed to a private GitHub repo, so future changes have real commit provenance.
- npm run changelog regenerates CHANGELOG.md from src/meta/changelog.ts, so the markdown cannot drift from the data.

## 0.3.0 — Battlefields persist

2026-08-20 13:50 (UTC+07:00) · reconstructed · 5 changes

**Simulation**

- Corpses no longer decay. Removed the decayPerSecond field and the per-tick decay pass entirely rather than setting the rate to zero, so there is no dead mechanism left behind.
- A corpse landing within 6 cells of an existing pile merges into it and increments its death count. Without this, hundreds of permanent 4 food crumbs would drag workers into long trips for a fraction of a load, since nearest_food_first scores on distance alone. Measured: 74 deaths become 13 piles, the largest holding 307 food.

**API**

- Match records and digests carry a battlefield summary: pile count, total food on the ground, and the size of the largest pile.

**Tests**

- Self test grew from 38 to 44 checks, covering no decay, proximity merging, distant corpses staying separate, and piles worth more than one worker load.

**Docs**

- Fix: Corrected the claim that every corpse is worth 40% of its unit cost. That holds for workers (4) and soldiers (12); a queen leaves a flat 60.

## 0.2.0 — Queens found new nests, and a map with room for them

2026-08-20 13:45 (UTC+07:00) · reconstructed · 18 changes

**Simulation**

- Queens can produce queens. A new queen costs 200 food and 60 seconds, walks to a founding site at 1.1 cells per second, then settles permanently and founds a nest.
- A colony holds several nests. Every settled queen has her own build slot drawing on the shared food stockpile, so nests multiply production throughput.
- Each nest supports 40 workers and soldiers. Added because unconstrained production let a colony reach 468 workers, which was both unreadable and slow; it also makes expanding the only way to raise your ceiling.
- Map grew from 100x100 to 200x200 with home nests at (40,40) and (160,160), 30 mirrored food pairs, longer vision, and a 900 second default match.
- Elimination now requires killing every enemy queen. Losing one queen destroys her nest but not the colony. Outcome reason renamed to colony_eliminated.
- New knob target_nests (1 to 6). New rule metrics: my_nests, enemy_nests, my_queens, enemy_queens, my_founding_queens, enemy_founding_queens. my_queen_hp_pct now reports the weakest queen in the colony.

**Unit AI**

- Founding sites are chosen by the simulation: the best remembered food cluster at least 34 cells from your own nests and 30 from any enemy nest, weighted by distance from the parent nest and by risk_tolerance.
- Soldiers anchor their defence on the nearest nest or a queen walking to a site, so escorting an expansion is emergent rather than another posture to pick.
- harass_enemy_workers prefers a walking queen over a worker, giving expansion a real counter.
- Fix: contest_enemy_food sent workers to whatever food sat closest to the enemy nest, which on a 200 cell map was a 50 second walk to their death: 370 food hauled in a whole match against an opponent 18,020. Haul distance is now capped at 100 cells, so it contests the middle ground. Hauling rose to 1,590 and kills from 13 to 129.

**Balance**

- Banked food dropped from 1 point to 0.1 and queens rose from 100 to 150. A passive colony banking 15,000 food swamped every other scoring term, so the score rewarded hoarding over playing.
- preset-harass moved from aggression 0.70 to 0.65, off the exact threshold at which workers also join fights and throw away the worker base.

**Performance**

- A 900 second match went from 9.2 seconds to 1.1 seconds. Added a per-tick spatial grid for proximity queries, and cached two things that were being recomputed for every soldier on every tick: its rank within the army, and the list of enemies standing in its nests.

**Viewer**

- Fix: Finishing a match refreshed the definition list and reset both dropdowns, silently discarding the selection.
- Fix: The match summary quoted scoring weights that no longer matched the config. The wording is now generated from the weights themselves so it cannot drift again.
- Viewer draws every nest, dashes a walking queen path to her target site, outlines a founding queen, and shows queens, nests and all parallel build slots in the HUD.

**Tests**

- Self test grew from 21 to 38 checks, covering target_nests in both directions, nest separation, no queen left walking, population capacity, and losing one queen versus losing the last.

**Tooling**

- Fix: The tournament runner still matched the old outcome name and reported 0 eliminations out of 112 matches. The real figure was 49.

## 0.1.0 — Initial testbed

2026-08-20 12:43 (UTC+07:00) · reconstructed · 10 changes

**Simulation**

- Deterministic fixed-timestep simulation, seeded from a string or number, with no I/O or DOM references so the same code runs headless and in the browser. Same seed gives an identical state fingerprint, and stepping tick by tick equals running in bulk.
- Grid map with mirrored food generation, queen, worker and soldier units, colony food memory as the intel mechanic, tick-based combat, and corpses modelled as food sources so foraging needs no second code path.
- Behaviour definitions are base knobs plus an ordered list of conditional rules, evaluated once per sim second inside the simulation. Replaced the original in-match LLM polling design so a match is a pure function of two definition files and a seed.
- Fix: Queens regenerated 3% of 500 health per second inside the nest, which is 15 per second against a soldier dealing 9. No queen could ever be killed, so the primary win condition was unreachable. Queens no longer regenerate.

**Unit AI**

- Worker foraging, hauling, scouting and reluctant fighting; soldier posture with an aggression-driven push split and risk-gated engagement; queen production steering toward a target army composition.

**Balance**

- First round robin: 8 starter definitions, 112 matches, 37% decided by a queen kill, win rates spread from 0% to 86%.

**API**

- Local HTTP API: definition CRUD, dry-run validation, single matches, seed series with sides swapped, round robin, per-definition win records, and match logs with per-rule activity.

**Viewer**

- Fix: At speeds of 1x to 5x, elapsed time times ten times the multiplier rounded to zero ticks every frame, so the match never advanced. Fractional ticks now accumulate between frames.
- Canvas viewer with per-colony HUD, live strategy knobs and active rules, playback controls, an intel overlay, and an end-of-match summary with a timeline.

**Tooling**

- Headless CLI match runner, self test, file-backed store for definitions and match records, and an optional coach loop that calls Claude to revise a definition between matches, never during one.

