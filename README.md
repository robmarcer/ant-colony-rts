# Ant Colony RTS

A 2D top-down ant colony RTS built as a testbed for pitting LLM-authored
strategies against each other.

An LLM writes a behaviour definition file for its colony. The match then runs
hands off: nothing outside the simulation can influence it, and no model is
consulted while it plays. Afterwards the LLM reads the match log and revises its
file. A local HTTP API provides CRUD over definitions plus read access to every
past match.

A match is a pure function of two definition files and a seed, so results are
reproducible and a "replay" is just re-running the sim rather than storing
frames.

## Quick start

Needs Node 22 or later, and nothing else.

```bash
npm install
npm start
```

That builds the viewer and serves it and the API together on
http://localhost:8787. The header links open the changelog and the LLM brief in a
panel docked beside the match, which keeps running. Both are also standalone
pages at `/changelog.html` and `/instructions.html` for deep linking, and
ctrl-clicking a header link opens one in a tab deliberately.

A note on why they are a panel and not a tab: a hidden tab has its
`requestAnimationFrame` throttled to 1fps, and because the frame loop clamps
elapsed time, a backgrounded match measured at roughly a quarter speed. Tabs were
worse than a panel on the exact axis they were chosen for.

`npm run dev` is the development alternative: it runs the API on 8787 and a Vite
dev server with hot reload on http://localhost:5273, proxying `/api` through.

Nothing else is required. An Anthropic API key is optional and only used by
`npm run coach`; every other command works without one. State lives in
`definitions/` and `matches/`, and `ANT_DATA_DIR` moves both somewhere else.

With Docker instead:

```bash
docker build -t ant-colony-rts . && docker run -p 8787:8787 -v ant-data:/data ant-colony-rts
```

Headless matches need no server at all:

```bash
npm run match -- --a example-mass-rush --b preset-boom --seed 1
npm run match -- --a example-mass-rush --b preset-boom --repeat 5
npm run match -- --round-robin --seeds 1,2
npm run match -- --list
```

## Changelog and versioning

The app shows its version in the header as a text link (`v0.4.0 changelog`) that
opens the full changelog in place, also reachable directly at `/#changelog`.

`src/meta/changelog.ts` is the single source of truth. It feeds the in-app view,
`GET /api/changelog`, the version reported by `GET /api` and `GET /api/health`,
and `CHANGELOG.md`.

Convention: add an entry in the same change that alters behaviour, never as a
follow up, then run `npm run changelog` to regenerate the markdown.

```bash
npm run changelog
```

Entries carry a `precision` field. The four releases up to 0.4.0 are marked
`reconstructed`: they predate version control on this project, so their
timestamps were derived from file modification times and the timestamps inside
saved match records, and there are no commits behind them. They are accurate to
the hour, not the minute. Everything after the initial commit is marked `commit`
and carries a git hash, which is the point of putting the project under version
control.

## Pointing an LLM at it

Easiest route: open `/instructions.html`, press "Copy the brief", paste it into the
model, and tell it the API is at `http://localhost:8787`. That page renders the
live response from `GET /api/brief`, so what you paste cannot be out of step with
the simulation.

`docs/agent-brief.md` is written for a model rather than a human reader: the loop,
the eight knobs, the rule format, the traps that have each cost a real strategy
real win rate, and how to read a match log. `AGENTS.md` routes an agent to it.

With the server running the same brief is at `GET /api/brief`, so a model given
nothing but the base URL can bootstrap itself. `npm run coach` uses that endpoint
as its system prompt rather than keeping a copy, since a copy drifts the moment
the simulation changes.

The self test asserts the brief has not fallen behind the code: every knob, rule
metric, posture, expansion priority and operator must appear in it, and the queen
health, attacker cap, population ceiling and recycling threshold it quotes must
match `config.ts`. A brief that is quietly out of date is worse than none, because
a model reads it, believes it, and plays to rules that no longer exist.

## The loop

1. `GET /api/schema` describes the behaviour format, unit stats and scoring.
2. `PUT /api/definitions/{id}` writes a behaviour file.
3. `POST /api/matches` or `POST /api/series` plays matches. The simulation runs
   to completion with no external input.
4. `GET /api/matches/{id}?view=digest` returns a compact plain text account of
   what happened, including which rules fired, when, and for how long.
5. Revise the file and go again.

`docs/behaviour.md` is the authoring guide. It documents exactly how each knob is
interpreted, since that is what a definition author needs to reason about.

```bash
curl localhost:8787/api                     # endpoint index
curl localhost:8787/api/schema              # the behaviour contract
curl localhost:8787/api/definitions         # what exists
curl -X POST localhost:8787/api/matches -H 'content-type: application/json' \
  -d '{"a":"example-mass-rush","b":"preset-boom","seed":"1","view":"digest"}'
```

`npm run coach -- --definition my-strategy --opponent preset-boom --rounds 3`
runs the loop automatically: play a series, feed the digests to Claude, save the
revised file, play again. It talks to the same HTTP API, so it doubles as a
reference client.

## Behaviour definitions

A definition is base knobs plus an ordered list of conditional rules:

```json
{
  "base": { "aggression": 0.0, "soldier_posture": "defend_nest", "...": "..." },
  "rules": [
    {
      "id": "commit",
      "note": "attack once a real group exists",
      "when": [{ "metric": "my_soldiers", "op": "gte", "value": 10 }],
      "set": { "aggression": 1.0, "soldier_posture": "attack_enemy_nest" }
    }
  ]
}
```

Rules exist because a static knob set cannot react to anything, and a definition
that says "attack the nest" would keep doing so while being wiped out. Rules are
declarative data, evaluated once per sim second inside the simulation, so the
match stays deterministic and every activation is logged. Nothing is executed as
code.

The ten knobs are `unit_production_ratio`, `aggression`, `expansion_priority`,
`min_worker_reserve`, `soldier_posture`, `risk_tolerance`, `target_nests`,
`recycle_surplus`, `expansion_bias` and `relocate_food`. Keeping the surface small is what makes
two models comparable: they are filling in the same form.

Starter definitions are written to `definitions/` on first run.
`example-mass-rush` and `example-adaptive` are the worked examples; the
`preset-*` files are static baselines.

## Queens and nests

A colony starts with one queen in one nest. Setting `target_nests` above 1 makes
a queen spend 200 food and 60 seconds building another queen, who then walks to a
site of her own and founds a nest there.

Expanding buys two things, and both matter:

- Another build slot. Every settled queen produces independently from the shared
  stockpile, so nests multiply how fast food becomes units.
- Another 100 units of population. Each nest supports 100 workers and soldiers,
  so a one-nest colony cannot use all the food it can reach. This ceiling is a
  compute and legibility bound rather than a balance lever: measured over 144
  matches, 100 per nest produces the same field as no cap at all, while keeping
  the worst case to 3.3 seconds a match instead of 20.9 and colonies to a size
  the viewer can actually show.

It costs 200 food, a minute of that queen's production, and a slow undefended
queen crossing open ground where she can be intercepted. Killing a queen destroys
her nest; a colony is eliminated only when its last queen dies.

Site selection is automatic: the best remembered food cluster at least 34 cells
from your other nests and 30 from any enemy nest, with `risk_tolerance` deciding
how close to the enemy you will settle.

## World

- 200x200 open grid, no obstacles and no pathfinding in v1.
- Home nests at (40,40) and (160,160). Food is generated in mirrored pairs about
  the map centre, so both colonies face an identical map and any difference in
  outcome comes from the strategies.
- 10 ticks per sim second, 90,000 sim second default limit (see Match length).
- Units are queen, worker and soldier. Stats live in `src/sim/config.ts`.
- A dead unit leaves its full cost where it fell: 10 for a worker, 30 for a
  soldier, 200 for a queen, plus whatever it was carrying. Corpses are modelled
  as food sources so foraging logic needs no second code path.
- Corpses never decay, and one landing within 6 cells of an existing pile merges
  into it. Ground that has been fought over accumulates permanently, so an old
  battlefield is territory worth holding.

## Recycling

`unit_production_ratio` only governs what a colony builds next, so one that spends
five minutes on workers and then wants an army is stuck carrying those workers.
`recycle_surplus` lets it send them home to be eaten by a queen instead, returning
their full cost to the stockpile.

It only applies at or above 90% of the population ceiling, because with room to
spare, building the type you want beats culling to make space for it. It never
culls below `min_worker_reserve`, it leaves no corpse, and it counts as neither a
loss for you nor a kill for the enemy.

## The map is a closed system

Total energy on the map never changes. It only moves between four places:

```
food piles on the ground  <->  food carried by a worker
                          <->  a colony's stockpile
                          <->  energy embodied in a living unit
```

A unit is energy borrowed from the stockpile, and its death returns every point
of it to the ground. A queen killed part way through building something returns
that investment too. `Simulation.totalEnergy()` sums all four, and the self test
samples it every 100 ticks across a 3,000 second match and fails on any drift
above 1e-6. Measured drift is exactly zero.

This is why combat is not a net drain on the world, and why a long match reaches
an attrition equilibrium rather than both colonies starving. It also means the
score's `lifetimeFood` term measures circulation, not extraction: the same food
can be hauled, spent, killed and hauled again.

`CORPSE_VALUE_FRACTION` in `src/sim/config.ts` is the switch. Anything other
than 1.0 makes the world leak, and the conservation check will say so.

## Match length

The default limit is 90,000 sim seconds, high enough that matches are normally
decided by elimination rather than the clock. What that means in practice,
measured:

| Pairing | Ends at | Compute |
|---|---|---|
| example-mass-rush vs preset-boom | 360s, elimination | 0.1s |
| preset-boom vs preset-turtle | 90,000s, time limit | 26s |
| preset-turtle vs preset-turtle | 90,000s, time limit | 30s |

A decisive pairing resolves quickly and costs nothing. Two passive strategies
never resolve, so they burn the full limit: turtle against turtle spends 25 hours
of sim time with both colonies parked at their one-nest population ceiling,
banking around 10,000 food each and doing nothing with it. Lower `--time` for
round robins, or the sweep will take most of an hour rather than a minute.
- Units regain 3% of maximum health per second inside their own nest. Queens do
  not regenerate.
- No fog of war. Unit positions are global; food still has to be discovered by
  walking within vision range. See "Deliberate simplifications" below.

## Ants have to turn around

Units hold a heading and turn toward where they want to go at a limited rate,
travelling along the heading they actually have rather than straight at the
target. Speed scales with alignment, so a unit slows into a turn, which is what
stops one orbiting a target it cannot turn tightly enough to reach: measured at 0
of 59 units orbiting.

A worker takes 0.70 seconds to reverse, a soldier 1.21, a founding queen 3.93.

This was expected to weaken committed attacks, since a soldier reacting to a new
attacker pays for the swing. It did the opposite: example-mass-rush rose from 1724
to 1852 while preset-boom fell from 1691 to 1615. A massed ball travelling in one
direction barely turns, whereas foragers and defenders re-target constantly and
pay the cost every time. Turning taxes reactive play more than committed play.

## The ground

Soil rather than a flat fill: grain, a broad tonal wash, and sparse grit,
generated once per match from its seed and blitted, never regenerated per frame.

The interesting constraint is not the look, it is contrast. Everything on screen
is small and two unit colours are dim, and corpses are brown, which makes them
the easiest thing to lose against soil. `src/ui/soil.ts` is therefore a pure
function with no canvas in it, so the self test can assert the mean luminance
stays under 0.006 and that every unit colour keeps 2.5:1 against the ground,
including against the bright tail of the texture rather than only its average.

## Looking closer

The whole map at once puts a worker at about 5px across. The viewer zooms to 8x,
where a worker is roughly 42px, and pans:

- Scroll wheel zooms toward the pointer, not the centre of the map.
- Drag to pan, double click or `fit` to return to the whole map.
- Arrow keys pan, `+` and `-` zoom, `0` fits.

Pan is clamped so the map always fills the view, which is why the default is
pixel-identical to having no zoom at all: at 1x the transform is a no-op. Reset
returns to a byte-identical frame, asserted by hashing the canvas.

## Sieges

A queen has 2,500 health and 2 armour, and at most 6 attackers can reach her at
once however large the army outside. A full complement of soldiers needs roughly
60 seconds of unbroken assault, against 4.6 seconds before this was introduced.

The attacker-slot limit is the part that does the work. Health alone cannot make
a siege take time, because time to kill is health over damage per second, so a
bigger army just scales the duration back down.

The cost is a real nerf to aggression, which is worth being explicit about:
eliminations fell from 36% of matches to 22%, and `example-mass-rush` went from
84% to 50%. Raising its commit threshold does not recover it, measured at 12, 20,
30 and 45 soldiers. If aggression should be stronger, the levers are
`QUEEN_MAX_ATTACKERS` and the queen's health in `src/sim/config.ts`.

## Win conditions

Killing every enemy queen wins outright. If both colonies still have a queen at
the time limit, the higher score wins:

```
150 per living queen
  4 per living worker
 10 per living soldier
0.1 per food in the stockpile
0.25 per food hauled over the whole match
```

Unspent food is weighted low on purpose. At a weight of 1 a passive colony's
hoard swamped every other term, so the score rewarded banking food over playing
the game. Food that was actually gathered still counts through the lifetime term.

Score only decides time limit matches. An elimination wins regardless of score,
which is why a winner can show a lower score than the loser.

## Licence

MIT. See [LICENSE](LICENSE).

## Layout

```
src/sim/        simulation: config, world gen, unit ai, rules, Simulation class
src/match/      match runner, tournament runner, file store, record types
src/headless/   CLI match runner and self test
src/ui/         canvas renderer and match viewer
src/coach/      optional LLM improvement loop (the only place a model is called)
server/         local HTTP API
definitions/    behaviour files, one JSON per strategy
matches/        match records, one JSON each, plus index.jsonl
docs/           behaviour authoring guide
```

`src/sim` has no I/O and no DOM references, which is why the browser and the
server can run identical matches. The viewer proves it: replaying a stored match
in the browser reproduces the server's scores exactly.

## Balance

The numbers in `src/sim/config.ts` are placeholders, tuned only enough that
matches are not degenerate. Current state, measured over a round robin of the
starter definitions across two seeds (112 matches):

- Win rates spread from 0% to 100% across ten definitions, on the ladder over 180
  comparable matches under fog of war.
- The strongest definition is `claude-v1`, written by a model reading
  `docs/agent-brief.md` and the ladder, at 2052.
- The shape is roughly rock paper scissors: expansion beats uncommitted
  aggression, well-timed committed aggression beats greedy expansion, and any
  strategy that never expands is out-produced by one that does.
- Every strategy above 60% expands. The two one-nest presets sit at 28% and 16%.
- Area denial is strong: preset-blockade, which does nothing but post soldiers on
  food, is second at 81%.
- Fog of war compressed the field: with enemy figures now beliefs that can be
  blind or stale, reactive strategies lost some of their edge. example-adaptive
  and example-mass-rush both sit at 1732, preset-boom at 1700, and the spread
  between second and eighth narrowed to 530 points.
- Measurements quoted here come from a cleared match store, for the reason in
  issue #25: the balance fingerprint does not cover simulation behaviour, so a
  code change can leave stale matches looking comparable.
- Across 56 matches, 119 nests were founded and 4 queens were intercepted on the
  walk, so expansion is a strong play whose real cost is the 200 food and the
  minute of lost production rather than the risk of interception.

One consequence worth knowing: a strong colony strips its half of the map by
roughly 700 seconds, and by the 900 second limit every food cluster is gone. Late
game income is corpses and nothing else, and since a unit returns only 40% of its
cost when it dies, the whole economy is a net drain by then. That makes the last
few minutes a genuine attrition phase rather than a second boom, and it is why
holding a battlefield matters.

What is still soft: the two rules-based examples sit well above the static
presets, which is expected (that is the point of rules) but it means the field
has no strong static baseline near the top. `preset-harass` at 14% is the weakest
credible strategy rather than a broken one.

Re-run `npm run match -- --round-robin --seeds 1,2` after any change to
`config.ts`.

## Deliberate simplifications in v1

- No fog of war. Unit counts and positions are global, which keeps rule metrics
  and debugging simple. Fog is the natural v2 feature and would make scouting and
  `known_food_*` metrics much more interesting.
- No obstacles or pathfinding. Units move in straight lines.
- One build slot per queen, so production scales with nests rather than being
  buyable separately. That, plus hauling distance, is what makes expanding worth
  200 food; the population ceiling is deliberately not doing that work.
- Nest sites are chosen by the simulation, not by the definition. A definition
  says how many nests it wants, not where they go.
- The food stockpile is shared across a colony's nests rather than held per nest.
- Combat is a per-tick exchange with no facing, formations or splash.
- Units have a radius and push each other aside by separation steering rather
  than hard collision, which compresses crowds instead of deadlocking them.
  Measured across a match, 0.06% of unit pairs overlap and 1 unit in 160 stalls.
- Pheromone trails are not modelled. Colony intel is a shared memory list. The
  viewer's `intel` toggle draws it as spokes from the nest, which is the same
  information without pretending to be a trail.
- Corpse piles merge by proximity to the first corpse in the pile; the pile does
  not drift toward the centre of the fighting.

## The ladder

```bash
npm run ladder                                   # rank from stored matches
npm run ladder -- --sweep --seeds 1,2 --time 900 # play a round robin first
```

Ratings are Bradley-Terry strengths on an Elo-like scale, mean 1500, with a 400
point gap meaning the higher side is expected to win about 10 games in 11. Also
`GET /api/ladder`, and `POST /api/ladder/sweep` to play and rank in one call.

Two properties worth knowing, both asserted in the self test:

- **Order independent.** Elo depends on the sequence matches were played in, so
  the same results processed differently give different ratings. Bradley-Terry
  makes the ladder a pure function of the match set, so recomputing always gives
  the same answer.
- **Only comparable matches count.** Ratings pool only matches played under the
  running balance numbers. A change to a unit cost makes older results a
  different game, and the ladder reports how many it ignored rather than
  averaging across them. Definitions are ranked per version, so revising one
  does not inherit its old rating.

## Map fairness

Food is generated in mirrored pairs about the map centre so both colonies face an
identical problem. That is now checked rather than assumed:

```bash
npm run match -- --mirror --seeds 40 --time 900
```

Every definition plays itself across the seeds; a fair map means side A wins about
half. Measured over 360 matches, all nine definitions individually cover an even
split, and pooled, side A won 193 of 358 decided matches, 53.9% with a 95%
interval of 48.7 to 59.0%.

So no side bias is demonstrated, but it is not cleanly ruled out either: the
point estimate leans four points to side A and the lower bound sits just below
half. A larger sample would settle it. In the meantime series and round robins
play every seed with the sides swapped, which cancels any residual bias rather
than relying on there being none.

## Verification

`npm run selftest` asserts 117 properties, including:

- the same seed produces an identical state fingerprint, and stepping tick by
  tick equals running in bulk
- different seeds diverge
- matches terminate, no unit leaves the map or survives at zero health, no
  negative stockpiles
- rules stay dormant until their condition holds, then fire, override the base
  knob, and get logged
- `target_nests` is honoured in both directions, nests keep their minimum
  separation, no queen is left walking forever, and population stays within
  nest capacity
- losing one queen costs a colony its nest but not the match, and losing the
  last one ends it as `colony_eliminated`
- corpses do not decay, nearby ones merge into a single pile, distant ones do
  not, and a fought-over match leaves piles worth more than a worker can carry
- energy is conserved across mixed food densities: total energy does not drift
  across a whole match, including when a queen dies part way through building a unit and when
  units are recycled
- recycling reshapes the live army, respects the worker floor, does nothing below
  the population ceiling, and books neither a loss nor a kill
- stored matches are pinned to the code that made them, and replay is refused
  for a mismatched version, mismatched balance numbers, or a missing stamp
- a stalemated match ends early while a decisive one is untouched
- `min_hold_seconds` stops a rule flapping, and a definition without it is
  unaffected
- soldiers on `guard_food` hold their post rather than chasing, are not posted on
  the enemy doorstep, are released when their pile runs out, and measurably deny
  the opponent food compared with sitting at home
- ladder ratings do not depend on match order, ignore matches from other balance
  numbers, rank per definition version, and give equal ratings for equal records
- a definition played against itself is not decided by which side it played, and
  the interval maths behind that verdict behaves at small and large samples
- the agent brief documents every knob, metric, posture, priority and operator,
  and the balance numbers it quotes match the config
- the changelog is well formed: unique semver versions, parseable timestamps
  carrying an offset, newest first, every entry has changes, `APP_VERSION`
  matches the newest entry, and a reconstructed entry never claims a commit
- a deliberately malformed definition still runs a match, with every rejected
  field reported

## API

| Endpoint | Purpose |
|---|---|
| `GET /api` | endpoint index |
| `GET /api/brief` | the agent brief as markdown, for a model with only HTTP access |
| `GET /api/schema` | behaviour format, knob meanings, unit stats, scoring |
| `GET /api/changelog` | every recorded change, newest first, with timestamps |
| `GET /api/definitions` | list |
| `GET /api/definitions/:id` | read one, with validation issues |
| `PUT /api/definitions/:id` | create or replace |
| `POST /api/definitions` | create, id from body |
| `PATCH /api/definitions/:id` | shallow merge, base merges per knob |
| `DELETE /api/definitions/:id` | delete |
| `POST /api/validate` | dry run the parser, saves nothing |
| `POST /api/matches` | run one match, `view` of `digest` or `summary` |
| `GET /api/matches` | list, newest first, `?definition=&limit=` |
| `GET /api/matches/:id` | full record, or `?view=digest` |
| `GET /api/matches/:id/events` | event log, `?major=true` for the timeline |
| `POST /api/series` | same pairing over several seeds, sides swapped |
| `POST /api/round-robin` | every pairing |
| `GET /api/stats/:id` | aggregate record across saved matches |

Writes go straight to `definitions/*.json`, so hand editing the files and using
the API are interchangeable.

## Performance

A 900 second match runs in about 1.1 seconds headless, so a 112 match round robin
takes under a minute. Getting there needed three fixes once colonies could reach
a couple of hundred units: a per-tick spatial grid for proximity queries, and
caching two things that were being recomputed per soldier per tick (its rank in
the army, and the list of enemies standing in its nests). Before those, the same
match took 9.2 seconds.

## Not done yet

Fog of war, obstacles, more unit types, a definition-controlled choice of where
to put a nest, an Elo style ladder across many definitions, and a UI for editing
definitions in the browser.
