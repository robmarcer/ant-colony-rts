# Writing a behaviour definition

A behaviour definition is the whole brain of one colony. You write it before a
match and then have no further contact with the game. The simulation reads it,
plays the match to the end, and writes a log you can read afterwards.

`GET /api/schema` returns the same information as this document in JSON form.

## File shape

```json
{
  "id": "my-strategy",
  "name": "my-strategy",
  "author": "claude-opus-5",
  "version": 3,
  "notes": "Free text. Record the plan and what the last match taught you.",
  "base": {
    "unit_production_ratio": { "worker": 0.6, "soldier": 0.4 },
    "aggression": 0.0,
    "expansion_priority": "nearest_food_first",
    "min_worker_reserve": 10,
    "soldier_posture": "defend_nest",
    "risk_tolerance": 0.5,
    "target_nests": 2
  },
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

`notes` is carried into every match record, so it is the place to leave a message
for whoever reads the log next, including a later version of yourself.

## How rules are applied

Rules are re-evaluated once per sim second. Every rule whose conditions all hold
is applied on top of `base`, in list order, and later rules override earlier
ones. It is not first match wins. That layering is deliberate: put broad phase
rules near the top and emergency overrides at the bottom, so a "defend the nest"
clause at the end can override an attack order earlier in the list.

Conditions within one rule are ANDed. For an OR, write two rules.

### Stopping a rule from flapping

A rule whose threshold sits where the match keeps crossing it will switch on and
off repeatedly. A colony that keeps committing its army and recalling it achieves
nothing, and this is easy to do by accident: one recorded match had a rule fire
eight times in a single game.

Add `min_hold_seconds` to keep a rule active for at least that long once it
fires, even if its condition lapses:

```json
{
  "id": "commit",
  "when": [{ "metric": "my_soldiers", "op": "gte", "value": 12 }],
  "set": { "aggression": 1.0, "soldier_posture": "attack_enemy_nest" },
  "min_hold_seconds": 120
}
```

The match log flags any rule that activates more than three times with
`FLAPPING, consider min_hold_seconds`, so you do not have to spot it yourself.
A held rule keeps its position in the list, so holding cannot change the
precedence your other rules rely on.

A rule that sets nothing, has no conditions, names an unknown metric, or names
an unknown knob is dropped, and the reason appears in the definition's `issues`
and in the match record. Invalid numbers are clamped rather than rejected.

Nothing else changes a colony's knobs during a match. There is no operator, no
override, no external call.

## The seven knobs

### unit_production_ratio

Target composition of the live army, `{worker, soldier}` as relative weights.
The queen builds one unit at a time. Whenever she is idle she looks at the
current live counts and builds whichever type moves the actual ratio toward the
target. If she wants a soldier and cannot afford one she waits and banks food
rather than building an off-plan worker.

### min_worker_reserve

A hard floor checked before the ratio. While the colony has fewer workers than
this, the queen builds only workers. Useful as a recovery clause: a rule that
raises the reserve after heavy losses will rebuild the economy before the army.

### aggression

How much of the army leaves home, and how far defenders will chase.

- The number of soldiers that push out is `round(soldier_count * aggression)`,
  taken in order of unit id. It has no effect while `soldier_posture` is
  `defend_nest`, which overrides it.
- Soldiers that stay home defend within a radius of `8 + 30 * aggression` cells
  of the nest.
- At `0.7` or above, workers will also attack enemies within 5 cells.

Regardless of aggression, any unit already in contact fights back, and any unit
will fight an enemy that comes within 2 cells of its own nest. The queen is
always defended.

### soldier_posture

What pushing soldiers do.

- `defend_nest` holds every soldier at home and ignores aggression.
- `escort_workers` shadows the friendly worker that is furthest from the nest.
- `harass_enemy_workers` hunts the nearest enemy worker anywhere on the map.
- `attack_enemy_nest` marches on the enemy queen.

### expansion_priority

How an idle worker picks a food target from colony memory. Each candidate is
scored, the best wins, and the score includes a crowding penalty of 3 per worker
already assigned to that source.

- `nearest_food_first`: `-distance_from_worker - 0.5 * distance_from_nest`
- `largest_food_first`: `0.12 * amount - 0.6 * distance_from_worker - 0.3 * distance_from_nest`
- `scout_aggressively`: `-distance_from_worker + 0.04 * amount`, and raises the
  chance that a worker explores instead of hauling from 12% to 45% per decision
- `contest_enemy_food`: `-0.4 * distance_from_worker - 0.8 * distance_from_enemy_nest`,
  which prefers sources in the enemy's half in order to deny them

### target_nests

How many nests you want, from 1 to 6. A colony starts with one nest and one
queen. While it has fewer nests than this target, and none already on the way, a
queen will spend 200 food and 60 seconds building a new queen. That queen then
walks to a site of her own and founds a nest there, after which she never moves
again.

Founding a nest buys two things:

- Another build slot. Every settled queen produces independently, from the shared
  food stockpile, so a second nest doubles how fast the colony can turn food into
  units.
- Another 40 units of population capacity. Each nest supports 40 workers and
  soldiers. A colony on one nest is capped at 40 no matter how much food it has,
  so on a large map a single nest cannot use the food it can reach.

It also costs:

- 200 food, which is 20 workers, and 60 seconds during which that queen builds
  nothing else.
- A slow, mostly undefended queen crossing open ground at 1.1 cells per second.
  Killing her destroys the whole investment before it returns anything. A soldier
  on `harass_enemy_workers` will go for a walking queen in preference to a
  worker.

Sites are chosen automatically: the best remembered food cluster that is at
least 34 cells from your other nests and 30 cells from any enemy nest, preferring
sites near the parent nest, with `risk_tolerance` deciding how close to the enemy
you are willing to settle. If nothing suitable is known, she heads away from the
enemy and looks for somewhere.

A colony at its population ceiling will still build a queen if `target_nests`
calls for one, since expanding is the only way to raise the ceiling. Losing a
queen destroys her nest but not the colony: you are only eliminated when your
last queen dies.

### risk_tolerance

Willingness to take a bad fight, and also economic caution.

- Founding sites: how close to the enemy a new queen is willing to settle.
- Retreat threshold: a unit runs home when its health drops below
  `(1 - risk_tolerance) * 0.6` of maximum. At `0` that is 60% health, at `1` it
  never retreats. A retreating unit heals in the nest at 3% of maximum health per
  second and returns to work at 90% health.
- Engagement: a soldier commits only if friendly strength within 14 cells is at
  least `(1.5 - risk_tolerance)` times enemy strength, where strength is the sum
  of `attack * current_health`. Queens are excluded from the count.
- Foraging: food near the enemy nest is discounted by
  `((40 - distance_to_enemy_nest) / 40) * 30 * (1 - risk_tolerance)`, so a
  cautious colony avoids hauling from the enemy's back yard.

## Rule metrics

All from the owning colony's point of view.

| Metric | Meaning |
|---|---|
| `sim_seconds` | Elapsed match time |
| `food_stockpile` | Unspent food |
| `lifetime_food` | Total food hauled home this match |
| `my_workers`, `my_soldiers`, `my_units` | Live counts, queen excluded |
| `enemy_workers`, `enemy_soldiers`, `enemy_units` | Same for the opponent |
| `soldier_advantage` | `my_soldiers - enemy_soldiers` |
| `my_nests`, `enemy_nests` | Nests standing |
| `my_queens`, `enemy_queens` | Queens alive, including any still walking |
| `my_founding_queens`, `enemy_founding_queens` | Queens walking to a site right now, i.e. expansions in flight |
| `my_queen_hp_pct`, `enemy_queen_hp_pct` | Health of the *weakest* queen in that colony, 0 to 100, and 0 with none left |
| `known_food_sources` | Entries in colony food memory |
| `known_food_amount` | Sum of remembered amounts |
| `units_lost_total` | Workers plus soldiers lost |
| `units_lost_recent` | Losses in roughly the last 30 seconds, decaying |
| `kills` | Enemy units killed |
| `enemies_near_my_nest` | Enemy units within 12 cells of any of your nests |
| `my_units_near_enemy_nest` | Your units within 12 cells of any of their nests |

Operators: `gt`, `gte`, `lt`, `lte`, `eq`.

## What the colony knows

There is no fog of war in v1, so unit counts and positions are global. Food is
different: a source only enters a colony's memory once one of that colony's
units walks within vision range of it (12 cells for a worker, 14 for a soldier,
12 for a queen). Idle workers pick targets from that shared memory, which is the
intel mechanic. Scouting has real value because unexplored food is invisible to
your foragers even though the map is otherwise open.

## Battlefields

Corpses do not decay, and they return the unit's full cost: 10 for a worker, 30
for a soldier, 200 for a queen, plus whatever they were carrying. Corpses within
6 cells of an existing pile merge into it, so wherever a battle happened there is
a permanent pile, and a big engagement leaves one worth many hundreds of food.

The map is a closed system. Total energy never changes; it only moves between the
ground, a worker in transit, your stockpile, and the units you built. Nothing is
consumed and nothing is lost. Three consequences worth planning around:

- A battle does not destroy value, it relocates it. Winning a fight beside your
  own nest is worth far more than winning the same fight beside theirs, because
  the loser's army is now food and whoever has workers nearby collects it.
- Piles are ordinary food sources, so `largest_food_first` sends workers to a
  large battlefield ahead of a fresh cluster, and `contest_enemy_food` will fight
  over one in the middle of the map.
- The clusters get stripped, but the energy does not leave. Late game, most of
  the map's food is either embodied in living units or lying on old
  battlefields. Ground you fought over is ground worth keeping workers on.

A pile only enters your memory once one of your units walks within vision of it,
same as any other food, so a battle you were not present at is invisible until
you scout it.

## Three failure modes worth knowing

All measured in this build, not assumed.

Trickling. A soldier takes 12 seconds to build and walks to the enemy base
alone, where it dies without accomplishing anything. `preset-rush`, which sets
aggression 0.9 and `attack_enemy_nest` from the first tick, wins 18% of a round
robin. The same aggression held behind a rule that waits for 12 soldiers before
committing wins 93%. That is `example-mass-rush`. If you intend to attack, hold
at `aggression: 0` and commit on a `my_soldiers` threshold.

Never expanding. `target_nests: 1` caps you at 40 units and one build slot. On
this map that is well below what the food can support, so a one-nest colony
simply gets out-produced. `preset-turtle` and `preset-rush`, both on one nest,
sit at the bottom of the table at 18%. Every strategy above 70% expands.

Banking. Unspent food is worth 0.1 per unit in the score, against 4 per worker,
10 per soldier and 150 per queen. A colony that ends with 15,000 banked food
earned 1,500 points it could have spent on an army. If the stockpile is climbing
and the population is at its ceiling, the answer is another nest, not more
saving.

## Reading a match log

`GET /api/matches/{id}?view=digest` is the compact form. Look at:

- `rule X: NEVER FIRED`, which almost always means the threshold is wrong rather
  than the idea being wrong.
- `nests` and `queens killed in transit`. A queen intercepted on the walk is 200
  food and a minute of production for nothing.
- The `battlefield` line, which says how much food is sitting in corpse piles and
  how big the largest is. A large pile you never hauled from is income you left
  on the floor.
- The activation count, and any `FLAPPING` flag. A rule that fired 8 times was
  switching on and off around its threshold. Either widen the gap between the
  rule that turns behaviour on and the one that turns it off, or give it
  `min_hold_seconds`.
- `produced` against `lost`. Producing 49 soldiers and losing 47 for 20 kills is
  the trickle failure.
- The final `food` figure. A large stockpile means production capacity, not food,
  was the limit, which usually argues for another nest.
- The timeline, which gives the causal chain: rule fires, first contact, enemies
  in nest, queen health steps down, queen dies.
