# Brief for an agent writing strategies

You are being asked to write and improve ant colony strategies for a testbed.
This document is everything you need. `docs/behaviour.md` is the fuller reference
if you want the exact scoring formulas; `GET /api/schema` is the same contract in
machine-readable form.

## What you control, and what you do not

You write one JSON file, the behaviour definition, before a match starts. Once it
starts you have no further input: you cannot issue orders, react to events, or see
the game. Every decision your colony will ever make has to be encoded in that
file. Afterwards you read the match log and write a better file.

A match is a pure function of (your definition, the opponent's definition, seed).
Same inputs, same match, every time.

## The loop

```bash
# 1. Learn the contract (unit stats, scoring, all limits)
curl localhost:8787/api/schema

# 2. See what already exists and how it does
curl localhost:8787/api/definitions
curl localhost:8787/api/stats/preset-boom

# 3. Write your definition
curl -X PUT localhost:8787/api/definitions/my-strategy \
  -H 'content-type: application/json' -d @my-strategy.json

# 4. Check what the parser accepted BEFORE burning matches on it
curl -X POST localhost:8787/api/validate \
  -H 'content-type: application/json' -d @my-strategy.json

# 5. Play a series, not a single match. One match is noise.
curl -X POST localhost:8787/api/series -H 'content-type: application/json' \
  -d '{"a":"my-strategy","b":"preset-boom","seeds":["1","2","3"],"swapSides":true,"save":true}'

# 6. Read what happened, and why
curl "localhost:8787/api/matches/<id>?view=digest"
```

Use `--time 900` style short matches while iterating. The default limit is 90,000
sim seconds and a stalemated pairing can cost 30 seconds of compute.

## The file

Eight knobs and an ordered list of rules. Nothing else.

```json
{
  "id": "my-strategy",
  "name": "my-strategy",
  "author": "your model id",
  "version": 3,
  "notes": "What I am trying and what the last match taught me.",
  "base": {
    "unit_production_ratio": { "worker": 0.6, "soldier": 0.4 },
    "aggression": 0.0,
    "expansion_priority": "nearest_food_first",
    "min_worker_reserve": 12,
    "soldier_posture": "defend_nest",
    "risk_tolerance": 0.5,
    "target_nests": 3,
    "recycle_surplus": 0,
    "capacity_investment": 0.5
  },
  "rules": [
    {
      "id": "commit",
      "note": "attack only once a real ball of soldiers exists",
      "when": [{ "metric": "my_soldiers", "op": "gte", "value": 20 }],
      "set": { "aggression": 1.0, "soldier_posture": "attack_enemy_nest" },
      "min_hold_seconds": 120
    }
  ]
}
```

Write `notes` for your future self. It is carried into every match record, so it
is how you remember what you were attempting three revisions ago.

### How rules work

Rules are re-evaluated once per sim second. **Every** rule whose conditions all
hold is applied on top of `base` in list order, and later rules override earlier
ones. It is not first-match-wins. So put broad phase rules near the top and
emergency overrides at the bottom, where they can override the pushes above.

Clauses in `when` are ANDed. A clause takes three forms:

- `{"metric": "my_soldiers", "op": "gte", "value": 20}` against a constant.
- `{"metric": "my_soldiers", "op": "lt", "metric2": "enemy_soldiers"}` against
  another metric, which is how you say "fewer soldiers than they have" without
  guessing an absolute number.
- `{"any_of": [ ... ]}` where one of its comparisons holding is enough.

`min_hold_seconds` keeps a rule active for at least that long once it fires. Use
it on any rule whose threshold the match will cross repeatedly, or the colony
will switch behaviour on and off and achieve nothing.

Anything the parser rejects comes back in `issues` with an exact path. Read it.
A rule naming a metric that does not exist is silently dropped from the match.

## The eleven knobs, in order of how much they decide

1. `target_nests` (1-6). The strongest lever. Each nest is an independent build
   slot drawing on the shared food stockpile, plus 100 more units of population,
   plus a closer drop-off point. A queen costs 200 food and 60 seconds and walks
   to the site slowly and mostly undefended. Every strategy above 60% win rate
   expands; the two that never do sit at 31% and 19%.
2. `unit_production_ratio`. What you build next, not what you already have.
3. `soldier_posture`. `defend_nest`, `escort_workers`, `harass_enemy_workers`,
   `attack_enemy_nest`, `guard_food`.
4. `aggression` (0-1). What fraction of the army leaves home, how far defenders
   chase, and above 0.7 whether workers join fights too. `defend_nest` ignores it.
5. `expansion_priority`. How idle workers choose food: `nearest_food_first`,
   `largest_food_first`, `scout_aggressively`, `contest_enemy_food`.
6. `risk_tolerance` (0-1). Retreat threshold, whether soldiers engage when
   locally outnumbered, how close to the enemy you will settle a nest, how far
   into their half workers will forage, and how deep guards will stand: at 0 a
   guard will not take a post near a known enemy nest even when the pile there
   is the one hurting you most, and at 1 it prefers exactly those posts.
7. `min_worker_reserve`. A hard floor: build only workers until you have this
   many. Also the floor recycling will not cull below.
8. `recycle_surplus` (0-1). Send surplus units home to be eaten by a queen,
   returning their full cost. Only works at 90%+ of your population ceiling.
9. `capacity_investment` (0-1). Spend surplus food raising a nest's brood
   capacity rather than on units now. A nest raises one unit at a time to start
   with, and both unit types work out at 2.5 food a second, so that is your whole
   spend rate per queen however much you gather. Extra slots cost 120, 204, 347,
   590 and 1003, to a maximum of six. 0 never buys, 1 buys as soon as affordable,
   0.5 waits until the stockpile is three times the price. Expansion outranks it:
   a queen you can afford is always built first, because a nest brings a brood
   chamber of its own and raises the population ceiling too.
10. `relocate_food` (0-1). Ferry a distant or contested pile closer to home
   instead of banking it. Never more efficient than hauling, since the worker
   makes the same trip and the food still needs collecting; it buys risk, on
   piles the enemy is better placed to take than you are. Pairs with
   `contest_enemy_food`.
11. `scout_ratio` (0-1). Fraction of idle workers exploring rather than hauling,
    and how much of that effort probes toward the enemy rather than sweeping for
    food. This is how you buy information, and it is paid for in food.
11. `expansion_bias`. Which way a new queen leans when choosing between sites:
   `toward_food`, `toward_enemy` or `toward_safety`. Measured over a match,
   mean distance from a new nest to the nearest enemy nest was 121, 143 and 160
   cells respectively. Forward nests extend how far `contest_enemy_food` and
   `guard_food` reach, at the cost of a queen closer to their army.

## Rule metrics

All from your colony's point of view. Operators: `gt`, `gte`, `lt`, `lte`, `eq`.

`sim_seconds`, `food_stockpile`, `lifetime_food`, `my_workers`, `my_soldiers`,
`my_units`, `enemy_workers`, `enemy_soldiers`, `enemy_units`,
`soldier_advantage`, `my_nests`, `enemy_nests`, `my_queens`, `enemy_queens`,
`my_founding_queens`, `enemy_founding_queens`, `my_queen_hp_pct`,
`enemy_queen_hp_pct`, `known_food_sources`, `known_food_amount`,
`units_lost_total`, `units_lost_recent`, `kills`, `enemies_near_my_nest`,
`my_units_near_enemy_nest`.

## There is fog of war, and it is the most important thing on this page

Every `enemy_` metric is a **belief**, not a fact. It is built from what your own
units have physically seen, and beliefs expire after 120 seconds. You can be
wrong in both directions, and both happen:

- Blind. At 300 seconds, a colony with `scout_ratio: 0` believed **0** enemy
  workers when there were 47. Its `enemy_soldiers` reads 0 while an army is being
  built, so a rule keyed on that number will never fire.
- Stale. Late in a match a hard-scouting colony believed **381** enemy workers
  when there were 263, because it remembers units that have since died.

`enemy_intel_age_seconds` is how you tell the difference. It is seconds since you
last laid eyes on anything of theirs. A rule that reacts to `enemy_soldiers`
should usually check it, for example requiring
`enemy_intel_age_seconds < 60` before trusting a count enough to commit.

You always know where their **home** nest is. Everything else, including any nest
they found later, has to be seen.

Scouting has a price. At `scout_ratio: 0.6` the same definition hauled 3,596 food
where `0.12` hauled 10,656. Information costs calories.

Food works the same way and always did: a pile only enters your memory once one of
your units walks within vision of it.

## Food is not all the same

Three types, differing in energy density, which is energy per unit of a worker's
carrying volume. A worker fills the same capacity either way, so a rich pile is
worth more per trip:

| type | density | pile size | energy per worker trip |
|---|---|---|---|
| leaf_litter | 0.6 | large | 6 |
| seeds | 1.0 | standard | 10 |
| honeydew | 1.9 | small | 19 |

Corpses are density 1.0. Richer types come in smaller piles, so a small rich pile
nearby against a big thin one further out is a real choice. Worker targeting
already prefers density, so you do not need a rule for it, but it interacts with
`expansion_priority`: `largest_food_first` will walk past honeydew for a big
leaf litter pile, which is usually wrong.

Density never creates energy. The pile loses exactly what the worker delivers.

## Six traps, all measured in this build

These are not opinions. Each one cost a real strategy real win rate.

**Trickling soldiers.** A soldier takes 12 seconds to build and dies alone if it
walks to the enemy base by itself. Setting `aggression: 0.9` with
`attack_enemy_nest` from the first tick wins 19% of a round robin. Hold at
`aggression: 0` and commit on a `my_soldiers` threshold instead.

**Assuming a rush still works.** Killing a queen is a siege: 2,500 health, 2
armour per hit, and at most **6 attackers can reach her at once** however large
your army. That is about 60 seconds of unbroken assault, and you must hold the
ground for all of it. A colony with 4 nests has 4 queens, each needing its own
siege. Committed aggression is currently mid-table for exactly this reason, and
raising the commit threshold does not fix it: at 12, 20, 30 and 45 soldiers a
massing rush won 3, 3, 4 and 0 of 12 matches.

**Never expanding.** One nest means one build slot and a 100 unit ceiling. You
will simply be out-produced.

**Banking food.** Unspent food is worth 0.1 a point in the score, against 4 a
worker, 10 a soldier and 150 a living queen. If your stockpile is climbing while
your population is capped, the answer is another nest, not more saving.

**Rules that flap.** A rule sitting on a threshold the match keeps crossing will
switch on and off repeatedly. One recorded match had a rule fire eight times, so
the colony kept committing its army and recalling it. Use `min_hold_seconds`.

**Fighting in their half.** The map is a closed system: total energy never
changes, and a dead unit returns its full cost as food where it fell. So killing
their workers deep in their territory hands them the biomass. Winning a fight
near your own nests is worth much more than winning the same fight near theirs.

## Reading a match digest

Look at, in this order:

- `rule X: NEVER FIRED`. The idea is usually fine and the threshold is wrong.
- `FLAPPING, consider min_hold_seconds`. The rule is fighting itself.
- `produced` against `lost`. Producing 49 soldiers and losing 47 for 20 kills is
  the trickle trap.
- `nests` and `queens killed in transit`. A queen intercepted on the walk is 200
  food and a minute of production for nothing.
- Final `food`. A large stockpile means production capacity, not food, was your
  limit. Expand.
- `battlefield`. Corpse piles never decay, so a large pile you never hauled from
  is income left on the floor.
- The timeline, which gives you the causal chain: rule fires, first contact,
  enemies in the nest, queen health stepping down.

## What good looks like right now

Ask the ladder rather than trusting this list, since it is a snapshot:

```bash
curl localhost:8787/api/ladder
```

At the time of writing, over 180 comparable matches under fog of war:

| rating | definition | win rate |
|---|---|---|
| 2311 | claude-v1 | 100% (90-100%) |
| 1732 | example-adaptive | 72% (56-84%) |
| 1732 | example-mass-rush | 72% (56-84%) |
| 1700 | preset-boom | 69% (53-82%) |
| 1558 | preset-balanced | 56% (40-70%) |
| 1421 | preset-blockade | 42% (27-58%) |
| 1393 | preset-scout | 39% (25-55%) |
| 1272 | preset-rush | 28% (16-44%) |
| 1202 | preset-turtle | 22% (12-38%) |
| 679 | preset-harass | 0% (0-10%) |

`claude-v1` was written by a model reading this brief and the ladder, so it is
worth reading before you start: `curl localhost:8787/api/definitions/claude-v1`.

Note how wide those intervals are at 32 games each. Beating `preset-balanced`
once proves nothing.

Economy and area denial currently beat committed aggression. If you want to beat
`preset-boom`, note that it expands to four nests and has almost no army:
`preset-blockade`, which does nothing but post soldiers on the food its opponent
is trying to collect, is the strongest thing in the field against it.

Read `definitions/example-adaptive.json` and
`definitions/example-mass-rush.json` before writing your own. Copy one and change
it rather than starting from an empty file.

## Rules of the road

- Do not tune against one seed. Use `POST /api/series` with three or more seeds
  and `swapSides: true`.
- A match record names the app version and balance numbers that produced it.
  After any change to the simulation, old records stop being replayable and old
  win rates stop being comparable. `GET /api/matches` marks which are still good.
- You cannot change the simulation, only your definition. If you think a knob is
  mis-specified, say so in `notes` rather than working around it silently.
