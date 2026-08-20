# Changelog

Current version: **0.20.0**. 20 releases, 139 recorded changes.

Generated from `src/meta/changelog.ts` by `npm run changelog`. Edit the data, not this file.

Entries marked *reconstructed* predate version control on this project. Their timestamps were derived from file modification times and the timestamps inside saved match records, so they are accurate to the hour rather than the minute, and there are no commits behind them. Entries marked with a commit hash have exact provenance in git.

## 0.20.0 — Ants navigate around each other

2026-08-20 18:17 (UTC+07:00) · committed · 7 changes

**Simulation**

- Units have a radius and push each other aside: 0.45 for a worker, 0.6 for a soldier, 1.6 for a queen, who is an immovable obstacle once settled. Separation steering rather than hard collision, so crowds compress and flow instead of jamming at the 2.5 cell deposit radius every colony funnels into.
- Strictly two phase: every displacement is computed from current positions and then all are applied, so the result cannot depend on the order units were iterated. Determinism holds, verified by the same-seed fingerprint and tick-by-tick checks passing unchanged.

**Unit AI**

- Removed the artificial crowding penalty of 3 per worker already assigned to a food source. Workers physically queue at a busy pile now, so counting congestion twice over-corrected.
- Fix: Removed the index-based ring offsets that fanned guards and nest defenders around a circle. Both were described as cosmetic when the issue was written, and one of them was not: the ring gave each guard a distinct destination. Without it they all drove at the exact centre of the pile, separation pushed them out, they walked back in, and they oscillated instead of intercepting. Two guard tests caught it. Replaced with a genuine behaviour: walk to the pile, then hold within 3 cells.

**Balance**

- Measured across a match: 0.056% of unit pairs overlap, 1 unit in 160 stalls while not idle or guarding, and food throughput rose rather than fell, from 835 to 1000 a minute for the same definition, because the crowding penalty had been over-correcting.
- Field re-measured after the change: preset-boom 2227, preset-blockade 1946, example-adaptive 1790, preset-scout 1719, example-mass-rush 1613, preset-balanced 1577, preset-turtle 1195, preset-rush 909, preset-harass 523.

**Tooling**

- Fix: Ladder ratings gained a regularising prior of one virtual game. Unregularised Bradley-Terry is unbounded below for a competitor that never wins, and the first re-measured ladder reported preset-harass at -900 on a 0 from 32 record: arithmetically right and useless to read. It now reports 523, and an even record still gives exactly equal ratings.

## 0.19.0 — Richer rule conditions, an expansion bias, and a layout fix

2026-08-20 18:01 (UTC+07:00) · committed · 5 changes

**Simulation**

- Rule clauses take three forms now: a metric against a constant, a metric against another metric, or an any_of group where one comparison holding is enough. Previously only the first existed, so "I have fewer soldiers than they do" could not be expressed at all and an author had to guess an absolute threshold instead of stating the relationship.
- New ninth knob expansion_bias: toward_food, toward_enemy or toward_safety, deciding which way a new queen leans between candidate sites. Measured on one seed at four nests, mean distance from a new nest to the nearest enemy nest was 121, 143 and 160 cells. toward_food is the previous behaviour, so omitting the knob changes nothing.

**Balance**

- preset-harass and preset-blockade ship with toward_enemy, since both depend on reaching contested ground, and preset-turtle with toward_safety.

**Viewer**

- Fix: A bare main selector written for the match viewer was inherited by the changelog and instructions pages, so their content sat in the first track of a two column grid while the 380px sidebar track stayed empty. A 9,570 character brief was read through a 451px porthole on a 1,265px page, with a second scrollbar inside a page that barely scrolled. The grid is now scoped to the match page and the reading pages are one column: the brief measures 713px wide on a 753px page with no inner scrollbar.

**Tests**

- Sixteen checks: metric-versus-metric parses and evaluates both ways, any_of fires on one member and not on none, groups AND with plain clauses, and four malformed forms are rejected by path. Plus the bias measurably moves nests in both directions and an unknown value falls back to the previous behaviour.

## 0.18.0 — A ladder with ratings and intervals

2026-08-20 17:55 (UTC+07:00) · committed · 8 changes

**Balance**

- First ladder over 144 comparable matches: preset-boom 1971, preset-blockade 1889, example-adaptive 1816, preset-scout 1680, example-mass-rush 1544, preset-balanced 1508, preset-turtle 1266, preset-rush 1057, preset-harass 769.

**API**

- New GET /api/ladder ranks every definition from every comparable stored match, and POST /api/ladder/sweep plays a round robin and returns the updated ladder. npm run ladder does the same on the CLI, with --sweep to populate first.

**Tests**

- Eleven checks: a clear hierarchy ranks correctly, order does not matter, an even record gives exactly equal ratings, draws count half to each side, other balance numbers are excluded and cannot change the ranking, versions are ranked separately, and mirror matches are not used for ranking.

**Docs**

- The agent brief now points a model at GET /api/ladder rather than a hardcoded table, and shows how wide the intervals are so it does not read one result as signal.

**Tooling**

- Bradley-Terry strengths rather than Elo, on an Elo-like scale with mean 1500. Elo depends on the order matches were played, so the same results processed differently give different ratings. Bradley-Terry makes the ladder a pure function of the match set, which is asserted directly by ranking a set of results and then its reverse.
- Ratings pool only matches played under the running balance numbers, and report how many were ignored. Averaging across a balance change would produce a confident number about a game that no longer exists. On the first run this correctly ignored 7 older matches.
- Definitions are ranked per version, so revising one does not inherit its old rating. Match index rows now carry both definitions versions.
- Win rates come with 95% Wilson intervals, reusing the function added for the fairness check so a rating interval and a fairness interval mean the same thing. At 32 games a definition interval is around 20 points wide, which is the point: one win proves nothing.

## 0.17.0 — Map fairness is measured, not assumed

2026-08-20 17:42 (UTC+07:00) · committed · 5 changes

**Balance**

- Measured over 360 matches, 40 seeds for each of nine definitions. All nine individually cover an even split. Pooled, side A won 193 of 358 decided matches: 53.9%, interval 48.7 to 59.0%.
- Honest reading: no side bias is demonstrated, and none is cleanly ruled out either. The point estimate leans four points to side A and the lower bound sits 1.3 points below half. A larger sample would settle it. Series and round robins already swap sides on every seed, which cancels a residual bias rather than assuming there is none, so existing measurements are protected either way.

**Tests**

- Eight checks: the interval brackets an even split, refuses to bracket a clean sweep, tightens with sample size, treats zero games as proving nothing, and a mirror match accounts for every seed and reports a rate inside its own interval.

**Tooling**

- npm run match -- --mirror plays a definition against itself across seeds and reports side A win rate with a 95% Wilson interval. Wilson rather than the normal approximation because it stays sane at small samples and near 0 or 1, which is where a fairness check lives.
- Reports a pooled figure across every definition as well as per definition. The aggregate is the sensitive test: at 40 seeds each definition has an interval roughly 30 points wide, so a small bias would hide inside all of them while still showing in the pooled result.

## 0.16.0 — Installable and runnable on plain Node

2026-08-20 17:22 (UTC+07:00) · committed · 9 changes

**API**

- The server prints every URL it serves on startup, and returns an explanatory 503 rather than a bare 404 when the viewer has not been built.

**Viewer**

- Fix: The instructions page now reports the origin it was actually served from rather than a hardcoded hostname and port 8787, which was only correct in the default local setup. Every API route lives under /api and Vite proxies that in development, so one value is right in both.

**Tests**

- Verified by hand from a clean clone into an empty directory: npm install then npm start, with an empty ANT_DATA_DIR, self-seeded 9 definitions, served all three pages and every API route from one port, ran a match and persisted the record. Eight cheap guards added so the pieces cannot silently disappear.

**Docs**

- MIT licence added. The repository is public, and with no licence file that meant all rights reserved: readable but not legally reusable.
- README leads with two commands, and states that the Anthropic key is optional and only used by npm run coach.

**Tooling**

- Fix: npm start builds the viewer and serves it with the API from a single process on one port. Previously the only way to run both halves was the Vite dev server, and a production build of the viewer could not reach the API at all, because the /api proxy existed only in the dev config.
- engines.node set to >=22 and a matching .nvmrc. Nothing previously stated the required version, so a mismatch showed up as a runtime failure instead of an install error. 22 is what is actually tested; lower may work but is unverified.
- Fix: tsx moved from devDependencies to dependencies, because npm start runs the server through it. It was never really a dev-only tool here.
- Dockerfile and .dockerignore, with the data directory as a volume so definitions and match records survive a rebuild.

## 0.15.0 — The changelog and the LLM brief are their own pages

2026-08-20 17:08 (UTC+07:00) · committed · 5 changes

**Viewer**

- The changelog is now a standalone page at /changelog.html, opened in its own tab from the header, so reading it no longer covers a running match. Verified the match keeps ticking in the original tab while the changelog is open in another.
- New /instructions.html renders the agent brief with a one-click copy, for pasting into a model. It fetches GET /api/brief rather than bundling a copy, so what you paste is exactly what the API serves.
- Removed the in-app changelog overlay. Rendering moved to src/ui/changelog-view.ts, still reading src/meta/changelog.ts, so there is one implementation rather than two to keep correct.

**Docs**

- AGENTS.md records the convention that a change gets a GitHub issue before it is started, and the commit references it, so conversational requests still end up tracked.

**Tooling**

- Vite builds three entry points instead of one.

## 0.14.0 — Documented for an LLM to drive

2026-08-20 15:47 (UTC+07:00) · committed · 6 changes

**API**

- New GET /api/brief serves the brief as markdown, so a model given nothing but the base URL can bootstrap itself with no filesystem access.
- Fix: recycle_surplus was listed in the schema required array but had no properties entry, so a model reading GET /api/schema would never have learned the knob exists. An earlier edit had half applied.
- Fix: GET /api/schema gains sieges, recycling and match_end sections. It described a 2,500 health queen without ever mentioning that only six attackers can reach her, which is the single most important strategic fact in the game right now.

**Tests**

- Eleven anti-drift checks. Every knob, rule metric, soldier posture, expansion priority and operator must appear in the brief, and the queen health, attacker cap, population ceiling and recycling threshold it quotes must match config.ts. A brief that has quietly fallen behind is worse than none, because a model reads it, believes it, and plays to rules that no longer exist.

**Docs**

- New docs/agent-brief.md, written for a model rather than a human browsing the repo: the loop as runnable curl calls, the eight knobs ordered by how much they decide, the rule format, six traps each measured in this build, and how to read a match digest. Plus AGENTS.md, which routes an agent to the brief or to the codebase conventions depending on why it is here.

**Tooling**

- Fix: npm run coach now fetches the brief and uses it as its system prompt instead of a hardcoded copy, which had already drifted: it still advised that each nest adds 40 population and said nothing about sieges.

## 0.13.0 — Colonies can recycle their own units

2026-08-20 15:40 (UTC+07:00) · committed · 7 changes

**Simulation**

- New eighth knob recycle_surplus: workers and soldiers walk home and are consumed by a queen, returning their full food cost and anything they carried to the stockpile. This is a conversion, not a death: no corpse, no kill for the enemy, and it is not booked as a loss. The map stays a closed system, asserted to zero drift.
- The point is that unit_production_ratio only governs what you build next. A colony that booms on workers then decides it needs an army used to carry those workers for the rest of the match. Measured on a definition that pivots to 40/60 at 300 seconds from one nest: 63 workers and 37 soldiers without recycling, 37 and 52 with it.
- Two guards. It only fires at or above 90% of the population ceiling, because with room to spare, building the type you want beats culling to make space for it, and without that gate a colony of five workers would cull itself to hit a 50/50 target. And it never culls below min_worker_reserve.

**Balance**

- Fix: The knob is a rate rather than a switch, recalling up to four units a second at 1.0. A first version used a flat cap, which made 0.5 and 1.0 behave identically because any real surplus saturated it.
- A quirk worth knowing: a lower value can recycle more in total, because a slower rate keeps the colony above the pressure threshold for longer and so keeps triggering. 0.5 recycled 25 workers where 1.0 recycled 20.

**Tests**

- Thirteen checks. Three of my first attempts asserted the wrong thing and were rewritten: two inferred "recycling is not a combat loss" from a match that had real combat losses, and one asserted the worker floor holds when combat attrition can breach it independently of recycling. The invariants are now tested directly against recycleUnit.

**Docs**

- preset-boom and preset-blockade, which both sit at their ceiling, ship with 0.5. example-adaptive gains a worked rule that turns recycling on when the enemy masses soldiers, held for 120 seconds.

## 0.12.0 — Killing a queen is a siege

2026-08-20 15:32 (UTC+07:00) · committed · 7 changes

**Simulation**

- Queen health raised from 500 to 2,500, plus 2 points of armour against every hit, and at most 6 attackers can reach a queen at once whatever the size of the army outside. A full complement of soldiers now needs about 60 seconds of unbroken assault, against 4.6 seconds for a twelve soldier ball before.
- The attacker slot limit is the part that does the work. Health alone cannot make a siege take time, because time to kill is health over damage per second, so a bigger army simply scales the duration back down. Slots put a floor on the duration instead, and the attacker has to hold the ground for all of it.
- Slots are assigned nearest first then by unit id, before any damage is applied, so they are stable while the same units stay in contact and do not depend on map iteration order.

**Balance**

- Armour makes a labour swarm useless against a queen: a worker lands 1 instead of 3, so six workers would need nearly 7 minutes.
- This is a real nerf to aggression and the numbers say so. Eliminations fell from 36% of matches to 22%, and example-mass-rush from 84% to 50% with its score margin going negative. Raising the commit threshold does not recover it: measured over 12 matches per setting, committing at 12, 20, 30 and 45 soldiers won 3, 3, 4 and 0. Economy and denial now lead the field, with preset-boom at 88% and preset-blockade at 81%.
- One emergent upside: because sieges concentrate a minute of fighting in one place, battlefield corpse piles are far larger than before, reaching 800 to 1,400 food in decisive matches, which makes holding the ground after a siege genuinely valuable.

**Tests**

- Five checks, including piling twenty soldiers onto one queen and asserting the damage lands at the slot rate rather than the pile rate. Two existing tests had premises invalidated by this change and were corrected: the decisive-match control no longer used an opponent a massing attack can actually break, and the corpse concentration test measured the largest pile surviving to the final tick rather than the peak during the match.

## 0.11.0 — Population ceiling raised to 100 per nest

2026-08-20 15:21 (UTC+07:00) · committed · 5 changes

**Balance**

- UNITS_PER_NEST raised from 40 to 100, so the maximum colony is 600 workers and soldiers across six nests rather than 240. Measured over three settings on the same nine definitions, 144 matches each: at 100 the field is identical to having no cap at all, with the same win rates, the same 52 eliminations and margins within rounding. At 40 it was not a bound but a balance lever, worth 19 points of win rate to preset-blockade and 9 to preset-turtle.
- Expansion is still decisive, now purely through the mechanics chosen for it: one build slot per queen and a shorter haul. Every strategy above 69% expands and the two one-nest presets sit at 28% and 19%, so removing the headcount advantage did not remove the incentive.
- Field after the change: example-adaptive and example-mass-rush 84%, preset-blockade 78%, preset-boom 69%, preset-scout 44%, preset-balanced 41%, preset-turtle 28%, preset-rush 19%, preset-harass 3%. Spread narrows from 6-91% to 3-84%, which is the acknowledged cost: a wider spread discriminates between strategies more sharply.

**Performance**

- The cap is kept as a compute and legibility bound. Uncapped, a single match reached 1,169 units in one colony and took 20.9 seconds instead of 3.3, and a round robin went from 108 to 118 seconds. 1,169 units is also not something the viewer can usefully draw.

**Docs**

- README and the authoring guide updated with the new ceiling, the reasoning behind it and the re-measured field. The mass-rush worked example no longer explains itself in terms of a 40 unit ceiling.

## 0.10.0 — Soldiers can guard food

2026-08-20 15:01 (UTC+07:00) · committed · 8 changes

**Simulation**

- New soldier_posture guard_food: soldiers post on food piles and kill whatever comes to collect it, denying the source rather than fighting for territory. New preset-blockade uses it, entering the field fourth of nine at 59%.
- Fix: Removing a food source now releases soldiers guarding it as well as workers gathering from it. Previously the guard field pointed at a deleted pile.

**Unit AI**

- Fix: Guards are leashed to 12 cells of their post and do not chase. Without a leash the first version had guards following workers across the map, with 2 of 17 soldiers actually standing on the pile they were meant to be denying and several posted 11 cells from the enemy nest.
- Fix: Post selection weights enemy worker activity at the pile first, then size, then how much closer it is to them than to us, minus distance from our own nests and, at low risk_tolerance, proximity to their nest. The denial term is capped both ways, because uncapped it always picks the pile touching the enemy nest, which is not a post but a funeral.
- Fix: A post is sticky and held until the pile is exhausted. Choosing fresh every tick made guards chase whichever pile momentarily had the most enemy workers, and only 3 of 28 ended up on a pile. Stickiness was the change that made the posture work at all.

**Balance**

- Measured against an otherwise identical definition sitting at home, four seeds against preset-boom: opponent income fell from 14,878 to 13,710, their worker losses rose from 48 to 423, at a cost of 20 soldiers, and it took a win off preset-boom where the control took none.

**Tests**

- Seven checks: guarding denies food and multiplies worker kills against a control, soldiers take up posts, a guard that has had time to arrive is on its pile, none are posted on the enemy doorstep, posts are held rather than chased, and a guard is released the moment its pile runs out.

**Docs**

- Documented in docs/behaviour.md, including the two limits: sixty-odd piles on the map means denial dents income rather than strangling it, and in a closed system killing workers deep in their half hands them the corpses, so contested ground near your own side is worth more.

## 0.9.0 — Rules can hold, and flapping is reported

2026-08-20 14:41 (UTC+07:00) · committed · 5 changes

**Simulation**

- Fix: New optional min_hold_seconds on a rule: once it fires it stays active for at least that long even if its condition lapses. A rule whose threshold sits where the match keeps crossing it was previously switching on and off repeatedly, and one recorded match had a rule fire eight times, so the colony kept committing its army and recalling it.
- A held rule keeps its position in the list, so a hold cannot change the layering precedence a definition was written to rely on.

**API**

- Fix: The digest flags any rule activating more than three times with "FLAPPING, consider min_hold_seconds", so an author does not have to notice it themselves.

**Tests**

- Eight checks: a threshold rule flaps without a hold and fires exactly once with one, oversized holds are clamped, negative ones are rejected and reported while the rule still runs, and a definition setting no hold is provably unaffected.

**Docs**

- docs/behaviour.md gains a section on flapping, and GET /api/schema documents min_hold_seconds.

## 0.8.0 — Stalemated matches end instead of running the clock out

2026-08-20 14:39 (UTC+07:00) · committed · 6 changes

**Simulation**

- Fix: A match now ends as a stalemate when nothing material has changed for 600 sim seconds, resolved on score exactly as the time limit is. At the 90,000 second default, two passive strategies previously ran the full limit, decided nothing, and cost 30 seconds of compute each.
- Progress is measured against a signature of the strategic position: nests, queens, weakest queen health, and unit counts within a tolerance of 2. A death-based check does not work, because two colonies parked at their population ceiling still trade the odd worker every few minutes while being completely stagnant, which would reset the window forever.
- New stalemateWindowSeconds option, 0 to disable, and a logged stalemate event naming the window so the digest says why a match ended when it did.
- A side effect worth knowing: this also resolves matches where a colony has been starved to a single queen with no workers and no food, and therefore cannot ever produce again, but the winner has aggression too low to walk over and finish it. preset-rush against preset-boom is exactly that, and used to burn the full 90,000 seconds to reach a verdict that was settled at 2,590.

**Performance**

- preset-turtle against itself went from 90,000 sim seconds and 30 seconds of compute to 864 sim seconds and 0.4 seconds, about 75 times cheaper. preset-boom against preset-turtle went from 26 seconds of compute to 7.5, and preset-rush against preset-boom from 33.7 to well under a second.

**Tests**

- Four checks: a passive pairing ends as a stalemate well short of the limit and logs its window, a decisive pairing is still decided by elimination, and the detector can be switched off. Verified against the whole field that this changes no live match: a 112 match round robin at 900 seconds returns byte-identical win rates, margins and elimination count.

## 0.7.0 — Stored matches are pinned to the code that made them

2026-08-20 14:32 (UTC+07:00) · committed · 6 changes

**API**

- Fix: Match records carry appVersion and balanceHash, the latter a hash over every tunable value exported from src/sim/config.ts. Without them a stored match was only reproducible by accident: the six records already on disk were made on a 100x100 map with decaying 40% corpses and a 900 second limit, and replaying one under 0.6.0 silently produced a different game.
- New POST /api/matches/:id/replay re-runs a stored match and reports whether it reproduced. Returns 409, naming both the recorded and running version and balance, when this build cannot reproduce it.
- GET /api/matches marks every row replayable or not against the running build, decided at read time rather than trusted from the file. GET /api/health reports the balance hash alongside the version.

**Viewer**

- Fix: The past-match picker disables records this build cannot reproduce and says which version they need, instead of quietly replaying a different game.

**Tests**

- Six checks covering the round trip: a fresh record is stamped and replays exactly, and replay is refused for a mismatched app version, mismatched balance numbers, and a record from before stamping existed. Both halves of the stamp are tested separately so neither can quietly stop being load bearing.

**Tooling**

- npm run match -- --replay [id] re-runs a stored match, defaulting to the newest, and exits 2 when the record cannot be reproduced. --matches lists stored records with their version and replay status.

## 0.6.0 — The map is a closed system

2026-08-20 14:10 (UTC+07:00) · committed · 7 changes

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

2026-08-20 14:10 (UTC+07:00) · committed · 3 changes

**Simulation**

- DEFAULT_TIME_LIMIT_SECONDS raised from 900 to 90,000, so matches are decided by one colony eliminating the other rather than by the clock. The viewer default matches.

**API**

- Fix: The series and round robin endpoints now refuse a request whose estimated compute exceeds 300 seconds, rather than only counting matches. At the new default one match is roughly 30 seconds of compute, so the old count-only guard would have allowed a request that blocked for half an hour.

**Docs**

- README records what long matches actually do, measured: a decisive pairing still ends in about 360 seconds, but two passive strategies run the full 90,000 and cost 30 seconds of compute each.

## 0.4.0 — Changelog, app version and version control

2026-08-20 14:03 (UTC+07:00) · committed · 7 changes

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

2026-08-20 13:39 (UTC+07:00) · reconstructed · 18 changes

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

