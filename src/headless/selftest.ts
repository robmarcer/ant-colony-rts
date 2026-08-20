/**
 * Self test. Not a unit test suite, a set of assertions that the simulation is
 * deterministic and not obviously broken. Run with: npm run selftest
 */
import { Simulation } from '../sim/sim.js';
import { parseDefinition } from '../sim/definition.js';
import { DEFAULT_STRATEGY, EXPANSION_PRIORITIES, PRESETS, SOLDIER_POSTURES } from '../sim/strategy.js';
import { NotReplayable, isReplayable, replayRecord, runMatch } from '../match/runner.js';
import { runMirror, winRateInterval } from '../match/tournament.js';
import { buildLadder } from '../match/ladder.js';
import type { MatchSummaryRow } from '../match/types.js';
import { balanceFingerprint } from '../meta/fingerprint.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CORPSE_DENSITY,
  RELOCATE_DROP_DISTANCE,
  CORPSE_VALUE_FRACTION,
  FOOD_TYPE_STATS,
  MAP_HEIGHT,
  MAP_WIDTH,
  MAX_NESTS_PER_COLONY,
  MIN_NEST_SEPARATION,
  QUEEN_ARMOUR,
  QUEEN_MAX_ATTACKERS,
  RECYCLE_PRESSURE_FRACTION,
  UNITS_PER_NEST,
  UNIT_STATS,
} from '../sim/config.js';
import { RULE_METRICS, RULE_OPS, parseDefinition as parse } from '../sim/definition.js';
import { evaluateRules } from '../sim/rules.js';
import { APP_VERSION, CHANGELOG, totalChanges } from '../meta/changelog.js';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` -> ${detail}` : ''}`);
  }
}

function def(id: string, preset: keyof typeof PRESETS, rules: unknown[] = []) {
  return parseDefinition({ id, name: id, author: 'selftest', base: PRESETS[preset], rules }, id).definition;
}

console.log('determinism');
{
  const build = () =>
    new Simulation({ seed: 'abc123', timeLimitSeconds: 300, definitions: [def('a', 'rush'), def('b', 'boom')] });
  const one = build();
  const two = build();
  one.run(3000);
  two.run(3000);
  check('same seed gives identical fingerprint', one.fingerprint() === two.fingerprint(), `${one.fingerprint()} vs ${two.fingerprint()}`);

  const three = new Simulation({
    seed: 'different',
    timeLimitSeconds: 300,
    definitions: [def('a', 'rush'), def('b', 'boom')],
  });
  three.run(3000);
  check('different seed gives a different match', one.fingerprint() !== three.fingerprint());

  // Stepping one at a time must equal stepping in bulk.
  const four = build();
  for (let i = 0; i < 3000; i++) four.step();
  check('tick by tick equals bulk run', four.fingerprint() === one.fingerprint());
}

console.log('invariants');
{
  const sim = new Simulation({ seed: 'inv', timeLimitSeconds: 600, definitions: [def('a', 'harass'), def('b', 'scout')] });
  sim.run(6001);
  check('match terminates', sim.finished, JSON.stringify(sim.outcome));
  let bad = 0;
  for (const unit of sim.units.values()) {
    if (!Number.isFinite(unit.x) || !Number.isFinite(unit.y)) bad++;
    if (unit.x < 0 || unit.x > MAP_WIDTH || unit.y < 0 || unit.y > MAP_HEIGHT) bad++;
    if (unit.hp <= 0) bad++;
    if (unit.carrying < 0) bad++;
  }
  check('no units off map, dead or holding negative food', bad === 0, `${bad} bad units`);
  check('no negative stockpiles', sim.colonies.every((c) => c.food >= 0));
  check('both colonies gathered food', sim.colonies.every((c) => c.lifetimeFoodGathered > 100), sim.colonies.map((c) => c.lifetimeFoodGathered.toFixed(0)).join('/'));
  check('both colonies produced units', sim.colonies.every((c) => c.unitsProduced.worker > 5));
  check('time series recorded', sim.series.length > 100, String(sim.series.length));
}

console.log('combat happens');
{
  const record = runMatch({ definitions: [def('a', 'rush'), def('b', 'boom')], seed: 'combat', timeLimitSeconds: 600 });
  const kills = record.colonies[0].kills + record.colonies[1].kills;
  check('rush versus boom produces kills', kills > 0, `${kills} kills`);
  check('a result was decided', record.result.reason !== 'unfinished', record.result.reason);
}

console.log('rules');
{
  const withRule = parseDefinition(
    {
      id: 'ruled',
      name: 'ruled',
      base: PRESETS.turtle,
      rules: [
        {
          id: 'go-aggressive',
          when: [{ metric: 'sim_seconds', op: 'gte', value: 30 }],
          set: { aggression: 0.9, soldier_posture: 'attack_enemy_nest' },
        },
      ],
    },
    'ruled',
  ).definition;
  const sim = new Simulation({ seed: 'rules', timeLimitSeconds: 120, definitions: [withRule, def('b', 'turtle')] });
  sim.run(200); // 20 sim seconds, rule must not have fired yet
  check('rule dormant before its condition', sim.colonies[0].activeRuleIds.length === 0, sim.colonies[0].activeRuleIds.join(','));
  sim.run(200); // now past 30 sim seconds
  check('rule fires when condition holds', sim.colonies[0].activeRuleIds.includes('go-aggressive'));
  check('rule overrides the base knob', sim.colonies[0].strategy.aggression === 0.9, String(sim.colonies[0].strategy.aggression));
  check(
    'rule activation is logged',
    sim.events.some((e) => e.type === 'rule_activated' && e.text.includes('go-aggressive')),
  );
}

console.log('queens and nests');
{
  const expander = parse(
    {
      id: 'expander',
      name: 'expander',
      base: { ...PRESETS.boom, target_nests: 3 },
      rules: [],
    },
    'expander',
  ).definition;
  const stayer = parse(
    { id: 'stayer', name: 'stayer', base: { ...PRESETS.turtle, target_nests: 1 }, rules: [] },
    'stayer',
  ).definition;

  const sim = new Simulation({ seed: 'nests', timeLimitSeconds: 900, definitions: [expander, stayer] });
  check('a colony starts with one nest and one queen', sim.colonies[0].nests.length === 1 && sim.queensOf(0).length === 1);

  sim.run(9001);
  check('target_nests 3 reaches 3 nests', sim.colonies[0].nests.length === 3, String(sim.colonies[0].nests.length));
  check('target_nests 1 stays on 1 nest', sim.colonies[1].nests.length === 1, String(sim.colonies[1].nests.length));
  check('every nest has a living queen', sim.colonies[0].nests.every((nest) => sim.units.has(nest.queenId)));
  check(
    'nests respect the minimum separation',
    sim.colonies[0].nests.every((a, i) =>
      sim.colonies[0].nests.every((b, j) => i === j || Math.hypot(a.x - b.x, a.y - b.y) >= MIN_NEST_SEPARATION - 1),
    ),
  );
  check(
    'queens cost what the table says',
    sim.colonies[0].unitsProduced.queen === 1 + sim.colonies[0].nestsFounded,
    `${sim.colonies[0].unitsProduced.queen} produced, ${sim.colonies[0].nestsFounded} founded`,
  );
  check('no queen is left walking forever', sim.foundingQueensOf(0).length === 0);
  check(
    'population respects nest capacity',
    sim.colonies.every((colony) => {
      const population = sim.countUnits(colony.id, 'worker') + sim.countUnits(colony.id, 'soldier');
      return population <= colony.nests.length * UNITS_PER_NEST + 1;
    }),
    sim.colonies.map((c) => `${sim.countUnits(c.id, 'worker') + sim.countUnits(c.id, 'soldier')}/${c.nests.length * UNITS_PER_NEST}`).join(' '),
  );
  check('expanding buys throughput', sim.colonies[0].unitsProduced.worker > sim.colonies[1].unitsProduced.worker);
  check('nest founding is logged', sim.events.some((e) => e.type === 'nest_founded' && e.colony === 0));
  check('the queen walk is logged', sim.events.some((e) => e.type === 'queen_walking' && e.colony === 0));
  check('a queen is expensive', UNIT_STATS.queen.cost >= 150 && UNIT_STATS.queen.buildTime >= 30);
}

console.log('losing one queen is not losing the match');
{
  const expander = parse(
    { id: 'exp2', name: 'exp2', base: { ...PRESETS.boom, target_nests: 3 }, rules: [] },
    'exp2',
  ).definition;
  const sim = new Simulation({
    seed: 'kill-a-queen',
    timeLimitSeconds: 900,
    definitions: [expander, def('b', 'turtle')],
  });
  sim.run(3000);
  const before = sim.colonies[0].nests.length;
  if (before < 2) {
    check('needed at least two nests to test partial elimination', false, `only ${before}`);
  } else {
    const victim = sim.queensOf(0)[1];
    victim.hp = 0;
    // Drive one tick of combat resolution by letting the sim notice the death.
    sim.units.delete(victim.id);
    const nestIndex = sim.colonies[0].nests.findIndex((nest) => nest.queenId === victim.id);
    sim.colonies[0].nests.splice(nestIndex, 1);
    sim.step();
    check('the colony survives losing a queen', !sim.finished && sim.isAlive(0));
    check('the nest count drops with the queen', sim.colonies[0].nests.length === before - 1);
  }

  // Now remove every queen and confirm the match ends.
  for (const queen of sim.queensOf(0)) sim.units.delete(queen.id);
  sim.colonies[0].nests.length = 0;
  sim.step();
  check('losing every queen ends the match', sim.finished, JSON.stringify(sim.outcome));
  check(
    'the reason is colony elimination',
    sim.outcome.status === 'finished' && sim.outcome.reason === 'colony_eliminated',
    sim.outcome.status === 'finished' ? sim.outcome.reason : 'running',
  );
}

console.log('relocating food');
{
  const withKnob = (relocate: number) =>
    parse(
      {
        id: 'r',
        name: 'r',
        base: { ...PRESETS.balanced, expansion_priority: 'contest_enemy_food', relocate_food: relocate },
        rules: [],
      },
      'r',
    ).definition;

  const play = (relocate: number) => {
    const sim = new Simulation({ seed: '1', timeLimitSeconds: 900, definitions: [withKnob(relocate), def('o', 'boom')] });
    const start = sim.totalEnergy();
    let worst = 0;
    for (let i = 0; i < 90 && !sim.finished; i++) {
      sim.run(100);
      worst = Math.max(worst, Math.abs(sim.totalEnergy() - start));
    }
    return { sim, relocated: sim.colonies[0].foodRelocated, banked: sim.colonies[0].lifetimeFoodGathered, worst };
  };

  const off = play(0);
  const on = play(1);
  check('relocation is off by default', off.relocated === 0, `${Math.round(off.relocated)} relocated`);
  check('relocation happens once turned on', on.relocated > 0, `${Math.round(on.relocated)} relocated`);
  check('relocating conserves energy', on.worst < 1e-6, `worst drift ${on.worst.toExponential(2)}`);
  check(
    'relocating is not a shortcut to a bigger stockpile',
    on.banked < off.banked * 1.25,
    `banked ${Math.round(on.banked)} against ${Math.round(off.banked)} without it`,
  );

  // Every load in transit must be headed somewhere near our own nests.
  const mid = new Simulation({ seed: '1', timeLimitSeconds: 900, definitions: [withKnob(1), def('o', 'boom')] });
  mid.run(5000);
  const ferrying = mid.unitsOf(0).filter((u) => u.state === 'relocating' && u.relocateTo);
  check(
    'a relocating worker is headed for its own ground',
    ferrying.every((u) => mid.distanceToNearestNest(0, u.relocateTo!) <= RELOCATE_DROP_DISTANCE + 2),
    `${ferrying.length} in transit`,
  );

  // The drop itself, tested directly rather than inferred from a match.
  const direct = new Simulation({ seed: 'drop', timeLimitSeconds: 300, definitions: [def('a', 'boom'), def('b', 'boom')] });
  direct.run(600);
  const carrier = direct.unitsOf(0).find((u) => u.type === 'worker')!;
  carrier.carrying = 40;
  const energyBefore = direct.totalEnergy();
  const foodBefore = direct.colonies[0].food;
  const pilesBefore = direct.food.size;
  direct.dropAsPile(carrier);
  check('dropping a load conserves energy exactly', Math.abs(direct.totalEnergy() - energyBefore) < 1e-9);
  check('dropping a load does not bank it', direct.colonies[0].food === foodBefore);
  check('the load is on the ground afterwards', direct.food.size >= pilesBefore && carrier.carrying === 0);
  check('and it is counted as relocated', direct.colonies[0].foodRelocated === 40);
}

console.log('food types');
{
  const sim = new Simulation({ seed: '1', timeLimitSeconds: 900, definitions: [def('a', 'boom'), def('b', 'scout')] });
  const clusters = [...sim.food.values()].filter((f) => f.kind === 'cluster');

  check('several food types are generated', new Set(clusters.map((f) => f.type)).size >= 2, [...new Set(clusters.map((f) => f.type))].join(','));
  check(
    'every pile carries the density its type declares',
    clusters.every((f) => f.density === FOOD_TYPE_STATS[f.type].density),
  );

  // Both colonies must face the same map, so a pile and its mirror twin match.
  let mismatched = 0;
  for (const pile of clusters) {
    const twin = clusters.find((other) => Math.abs(other.x - (MAP_WIDTH - pile.x)) < 0.01 && Math.abs(other.y - (MAP_HEIGHT - pile.y)) < 0.01);
    if (twin && twin.type !== pile.type) mismatched++;
  }
  check('mirrored pairs share a type', mismatched === 0, `${mismatched} mismatched`);

  const dense = clusters.find((f) => f.density > 1);
  const thin = clusters.find((f) => f.density < 1);
  check('a dense type exists and a thin one too', !!dense && !!thin);
  check('richer piles are smaller', !dense || !thin || dense.initialAmount < thin.initialAmount, `${dense?.initialAmount} vs ${thin?.initialAmount}`);

  // The property that matters: density must not create energy.
  const energyStart = sim.totalEnergy();
  let worst = 0;
  for (let i = 0; i < 90 && !sim.finished; i++) {
    sim.run(100);
    worst = Math.max(worst, Math.abs(sim.totalEnergy() - energyStart));
  }
  check('density conserves energy, it does not multiply it', worst < 1e-6, `worst drift ${worst.toExponential(2)}`);

  // A worker on a dense pile brings home more per trip.
  const perTrip = (density: number) => UNIT_STATS.worker.carryCapacity * density;
  check('a rich pile is worth more per trip', perTrip(FOOD_TYPE_STATS.honeydew.density) > perTrip(FOOD_TYPE_STATS.leaf_litter.density) * 2);
  check('corpses are ordinary density', CORPSE_DENSITY === 1);
}

console.log('corpses');
{
  const sim = new Simulation({ seed: 'corpse', timeLimitSeconds: 900, definitions: [def('a', 'boom'), def('b', 'boom')] });

  // Far from both nests (40,40) and (160,160): nothing can walk here inside 15s.
  sim.addCorpse({ x: 100, y: 5 }, 12);
  const pile = [...sim.food.values()].find((f) => f.kind === 'corpse')!;
  check('a corpse becomes a food source', !!pile && pile.amount === 12);
  sim.run(150);
  check('corpses do not decay', pile.amount === 12, String(pile.amount));

  sim.addCorpse({ x: 103, y: 5 }, 8);
  check('a nearby corpse merges into the pile', pile.amount === 20 && pile.deaths === 2, `${pile.amount}/${pile.deaths}`);
  sim.addCorpse({ x: 130, y: 5 }, 8);
  check(
    'a distant corpse starts its own pile',
    [...sim.food.values()].filter((f) => f.kind === 'corpse').length === 2,
  );

  const fought = new Simulation({
    seed: 'battlefield',
    timeLimitSeconds: 900,
    definitions: [def('a', 'rush'), def('b', 'boom')],
  });
  // Sampled during the match, not at the end: piles get harvested, so the
  // largest one still standing at the final tick says nothing about whether
  // fighting concentrated food while it was happening.
  let peakPile = 0;
  for (let i = 0; i < 90 && !fought.finished; i++) {
    fought.run(100);
    for (const source of fought.food.values()) {
      if (source.kind === 'corpse') peakPile = Math.max(peakPile, source.amount);
    }
  }
  const corpses = [...fought.food.values()].filter((f) => f.kind === 'corpse');
  const deaths = fought.colonies.reduce((n, c) => n + c.unitsLost.worker + c.unitsLost.soldier, 0);
  check('a match with combat leaves corpse piles', corpses.length > 0, `${corpses.length} piles from ${deaths} deaths`);
  check(
    'merging keeps the pile count well under the death count',
    corpses.length < Math.max(4, deaths / 2),
    `${corpses.length} piles from ${deaths} deaths`,
  );
  check(
    'fighting concentrates food into a pile worth a trip',
    peakPile > UNIT_STATS.worker.carryCapacity * 2,
    `peak pile ${Math.round(peakPile)} against a carry capacity of ${UNIT_STATS.worker.carryCapacity}`,
  );
}

console.log('bad definitions are survivable');
{
  const parsed = parseDefinition({
    name: 'garbage',
    base: { aggression: 5, expansion_priority: 'eat_the_sun', min_worker_reserve: -3 },
    rules: [
      { id: 'nonsense', when: [{ metric: 'vibes', op: 'gte', value: 1 }], set: { aggression: 0.5 } },
      { id: 'empty', when: [], set: { aggression: 0.5 } },
      { id: 'no-set', when: [{ metric: 'my_workers', op: 'gte', value: 1 }], set: {} },
      { id: 'fine', when: [{ metric: 'my_workers', op: 'gte', value: 1 }], set: { aggression: 0.5 } },
    ],
  });
  check('invalid knobs are reported', parsed.issues.length >= 3, JSON.stringify(parsed.issues.map((i) => i.path)));
  check('aggression clamped into range', parsed.definition.base.aggression <= 1);
  check('target_nests clamped to the cap', parsed.definition.base.target_nests <= 6, String(parsed.definition.base.target_nests));
  check('unknown enum falls back', parsed.definition.base.expansion_priority === 'nearest_food_first');
  check('only the valid rule survives', parsed.definition.rules.length === 1 && parsed.definition.rules[0].id === 'fine', String(parsed.definition.rules.length));

  const sim = new Simulation({ seed: 'garbage', timeLimitSeconds: 60, definitions: [parsed.definition, def('b', 'boom')] });
  sim.run(700);
  check('a garbage definition still runs a match', sim.finished);
}

console.log('closed system');
{
  const sim = new Simulation({
    seed: 'energy',
    timeLimitSeconds: 3000,
    definitions: [def('a', 'rush'), def('b', 'boom')],
  });
  const start = sim.totalEnergy();
  let worst = 0;
  // Sample throughout rather than only at the end, so a leak that is later
  // masked by another cannot slip through.
  for (let i = 0; i < 300; i++) {
    sim.run(100);
    worst = Math.max(worst, Math.abs(sim.totalEnergy() - start));
  }
  const drift = Math.abs(sim.totalEnergy() - start);
  check('energy is conserved over a whole match', worst < 1e-6, `worst drift ${worst.toExponential(2)} from ${start}`);
  check('no energy is created or destroyed by combat', drift < 1e-6, `final drift ${drift.toExponential(2)}`);
  check('the match actually did something', sim.colonies.some((c) => c.unitsLost.worker + c.unitsLost.soldier > 0));
  check('corpses return the full unit cost', CORPSE_VALUE_FRACTION === 1);

  // A queen dying mid-build must return what she had already invested.
  const mid = new Simulation({ seed: 'brood', timeLimitSeconds: 600, definitions: [def('a', 'boom'), def('b', 'boom')] });
  mid.run(400);
  const queen = mid.queensOf(0).find((q) => q.build);
  if (!queen) {
    check('found a queen mid-build to test brood refund', false);
  } else {
    const before = mid.totalEnergy();
    queen.hp = 0;
    mid.step();
    check(
      'a queen dying mid-build returns her brood energy too',
      Math.abs(mid.totalEnergy() - before) < 1e-6,
      `drift ${(mid.totalEnergy() - before).toFixed(6)}`,
    );
  }
}

console.log('recycling units');
{
  const pivot = (recycle: number) =>
    parse(
      {
        id: 'pivot',
        name: 'pivot',
        base: {
          ...PRESETS.boom,
          target_nests: 1,
          recycle_surplus: recycle,
          unit_production_ratio: { worker: 0.95, soldier: 0.05 },
        },
        rules: [
          {
            id: 'to-war',
            when: [{ metric: 'sim_seconds', op: 'gte', value: 300 }],
            set: { unit_production_ratio: { worker: 0.4, soldier: 0.6 } },
          },
        ],
      },
      'pivot',
    ).definition;

  const run = (recycle: number) => {
    const sim = new Simulation({
      seed: '1',
      timeLimitSeconds: 900,
      definitions: [pivot(recycle), def('o', 'turtle')],
    });
    const startEnergy = sim.totalEnergy();
    let worstDrift = 0;
    for (let i = 0; i < 90 && !sim.finished; i++) {
      sim.run(100);
      worstDrift = Math.max(worstDrift, Math.abs(sim.totalEnergy() - startEnergy));
    }
    return {
      workers: sim.countUnits(0, 'worker'),
      soldiers: sim.countUnits(0, 'soldier'),
      recycled: sim.colonies[0].unitsRecycled.worker,
      lost: sim.colonies[0].unitsLost.worker,
      enemyKills: sim.colonies[1].kills,
      worstDrift,
      events: sim.events.filter((e) => e.type === 'recycled').length,
    };
  };

  const off = run(0);
  const on = run(1);

  check('recycling is off by default', off.recycled === 0, `${off.recycled} recycled`);
  check('recycling culls surplus workers once turned on', on.recycled > 0, `${on.recycled} recycled`);
  check(
    'recycling reshapes the live army, not just future builds',
    on.soldiers > off.soldiers && on.workers < off.workers,
    `on ${on.workers}w/${on.soldiers}s vs off ${off.workers}w/${off.soldiers}s`,
  );
  check('energy is conserved through recycling', on.worstDrift < 1e-6, `drift ${on.worstDrift.toExponential(2)}`);
  check('recycling is logged', on.events > 0);

  // Tested directly rather than inferred from a full match: a match against a
  // live opponent has real combat losses, which say nothing about whether
  // recycling is booking itself as one.
  const direct = new Simulation({ seed: 'direct', timeLimitSeconds: 300, definitions: [def('a', 'boom'), def('b', 'boom')] });
  direct.run(600);
  const victim = direct.unitsOf(0).find((u) => u.type === 'worker')!;
  const foodBefore = direct.colonies[0].food;
  const lostBefore = direct.colonies[0].unitsLost.worker;
  const killsBefore = direct.colonies[1].kills;
  const corpsesBefore = [...direct.food.values()].filter((f) => f.kind === 'corpse').length;
  const energyBefore = direct.totalEnergy();
  const carried = victim.carrying;
  direct.recycleUnit(victim);
  check(
    'recycling returns the unit cost and its load to the stockpile',
    Math.abs(direct.colonies[0].food - (foodBefore + UNIT_STATS.worker.cost + carried)) < 1e-9,
    `${direct.colonies[0].food.toFixed(2)} from ${foodBefore.toFixed(2)}`,
  );
  check('recycling conserves energy exactly', Math.abs(direct.totalEnergy() - energyBefore) < 1e-9);
  check('a recycled unit is not a combat loss', direct.colonies[0].unitsLost.worker === lostBefore);
  check('a recycled unit gives the enemy no kill', direct.colonies[1].kills === killsBefore);
  check(
    'a recycled unit leaves no corpse',
    [...direct.food.values()].filter((f) => f.kind === 'corpse').length === corpsesBefore,
  );
  check('a recycled unit is gone', !direct.units.has(victim.id));

  // Below the population ceiling there is nothing to gain, so nothing happens.
  const roomy = new Simulation({
    seed: '1',
    timeLimitSeconds: 300,
    definitions: [pivot(1), def('o', 'turtle')],
  });
  roomy.run(3001);
  check(
    'no recycling while there is room to just build instead',
    roomy.colonies[0].unitsRecycled.worker === 0,
    `${roomy.colonies[0].unitsRecycled.worker} recycled at ${roomy.countUnits(0, 'worker') + roomy.countUnits(0, 'soldier')} population`,
  );

  const floored = parse(
    {
      id: 'floored',
      name: 'floored',
      base: {
        ...PRESETS.boom,
        target_nests: 1,
        recycle_surplus: 1,
        min_worker_reserve: 95,
        unit_production_ratio: { worker: 0.1, soldier: 0.9 },
      },
      rules: [],
    },
    'floored',
  ).definition;
  const guarded = new Simulation({ seed: '1', timeLimitSeconds: 900, definitions: [floored, def('o', 'turtle')] });
  guarded.run(9001);
  // The floor can still be breached by combat attrition, which is not
  // recycling's doing, so the assertion is that recycling itself culled nothing.
  check(
    'recycling never culls below min_worker_reserve',
    guarded.colonies[0].unitsRecycled.worker === 0,
    `${guarded.colonies[0].unitsRecycled.worker} recycled with ${guarded.countUnits(0, 'worker')} workers against a floor of 95`,
  );
}

console.log('killing a queen is a siege');
{
  const sim = new Simulation({ seed: 'siege', timeLimitSeconds: 900, definitions: [def('a', 'boom'), def('b', 'boom')] });
  const queen = sim.queensOf(1)[0];

  // Twenty soldiers piled onto one queen. Only the slots should land blows.
  for (let i = 0; i < 20; i++) {
    const attacker = sim.spawnUnit('soldier', 0, { x: queen.x + 0.4, y: queen.y + 0.4 });
    attacker.targetEnemyId = queen.id;
  }
  const before = queen.hp;
  sim.run(10);
  const dealt = before - queen.hp;
  const perSlot = UNIT_STATS.soldier.attack - QUEEN_ARMOUR;
  const capped = QUEEN_MAX_ATTACKERS * perSlot;

  check('armour reduces what a soldier lands on a queen', perSlot < UNIT_STATS.soldier.attack);
  check(
    'only the attacker slots land damage, however many pile in',
    dealt > 0 && dealt <= capped * 1.5,
    `${dealt} in one second from 20 soldiers, cap implies about ${capped}`,
  );
  check(
    'twenty soldiers do far less than twenty soldiers worth',
    dealt < 20 * perSlot * 0.6,
    `${dealt} vs ${20 * perSlot} if uncapped`,
  );

  const secondsToKill = UNIT_STATS.queen.maxHp / capped;
  check('a full complement needs a sustained assault to kill a queen', secondsToKill > 30, `${secondsToKill.toFixed(0)}s`);

  const workerSeconds = UNIT_STATS.queen.maxHp / (QUEEN_MAX_ATTACKERS * Math.max(1, UNIT_STATS.worker.attack - QUEEN_ARMOUR));
  check('a swarm of workers cannot realistically kill a queen', workerSeconds > 300, `${workerSeconds.toFixed(0)}s`);
}

console.log('guarding food');
{
  const withPosture = (posture: string, aggression: number) =>
    parse(
      {
        id: 'g',
        name: 'g',
        base: {
          ...PRESETS.balanced,
          aggression,
          soldier_posture: posture,
          unit_production_ratio: { worker: 0.6, soldier: 0.4 },
        },
        rules: [],
      },
      'g',
    ).definition;

  const guarding = withPosture('guard_food', 0.6);
  const control = withPosture('defend_nest', 0);
  const victim = def('v', 'boom');

  const tally = (attacker: typeof guarding) => {
    let theirs = 0;
    let killed = 0;
    for (const seed of ['1', '2']) {
      const sim = new Simulation({ seed, timeLimitSeconds: 900, definitions: [attacker, victim] });
      sim.run(9001);
      theirs += sim.colonies[1].lifetimeFoodGathered;
      killed += sim.colonies[1].unitsLost.worker;
    }
    return { theirs, killed };
  };

  const guarded = tally(guarding);
  const baseline = tally(control);
  // Deliberately not asserting food denial any more. It held at 8% when the
  // population ceiling was 40 per nest; at 100 the opponent fields around 275
  // workers across sixty piles and strips the map either way, so guarding six of
  // them cannot dent the total. Tracked in its own issue rather than papered
  // over here. What the posture still does is trade.
  check(
    'guarding kills substantially more enemy workers than sitting at home',
    guarded.killed > baseline.killed * 1.3,
    `${guarded.killed} vs ${baseline.killed}`,
  );

  const sim = new Simulation({ seed: '1', timeLimitSeconds: 900, definitions: [guarding, victim] });
  sim.run(4000);
  const guards = sim.unitsOf(0).filter((u) => u.type === 'soldier' && u.guardFoodId !== null);
  check('soldiers take up posts on food piles', guards.length > 0, `${guards.length} posted`);
  // Only guards that have had time to walk there: a soldier built ten seconds
  // ago is legitimately still in transit across a 200 cell map.
  // Posts churn: a pile runs out, its guards are released and re-post, so being
  // alive a while no longer implies having arrived. Assert most are on station
  // rather than all of them.
  const settled = guards.filter((guard) => sim.tick - guard.bornTick > 150 * 10);
  const onStation = settled.filter((guard) => {
    const pile = sim.food.get(guard.guardFoodId!);
    return !pile || Math.hypot(pile.x - guard.x, pile.y - guard.y) < 20;
  });
  check(
    'most guards that have had time to arrive are on their pile',
    settled.length > 0 && onStation.length >= settled.length * 0.5,
    `${onStation.length} on station of ${settled.length} settled`,
  );
  check(
    'guards are not posted on the enemy doorstep',
    guards.every((guard) => sim.distanceToNearestNest(1, guard) > 20),
    String(Math.min(...guards.map((g) => Math.round(sim.distanceToNearestNest(1, g))))),
  );

  // A post is held until the pile runs out, not re-picked every tick.
  const before = new Map(guards.map((g) => [g.id, g.guardFoodId]));
  sim.run(300);
  const stable = [...before].filter(([id, pile]) => {
    const unit = sim.units.get(id);
    return unit && (unit.guardFoodId === pile || !sim.food.has(pile!));
  }).length;
  check('guards hold their post rather than chasing', stable >= before.size * 0.8, `${stable}/${before.size} held`);

  const depleted = sim.unitsOf(0).find((u) => u.type === 'soldier' && u.guardFoodId !== null);
  const pile = depleted ? sim.food.get(depleted.guardFoodId!) : undefined;
  if (depleted && pile) {
    sim.removeFood(pile, false);
    check('a guard is released the moment its pile runs out', depleted.guardFoodId === null);
  } else {
    check('found a posted guard whose release can be tested', false);
  }
}

console.log('rule hysteresis');
{
  const flappyRule = (hold?: number) =>
    parse(
      {
        id: 'flappy',
        name: 'flappy',
        base: PRESETS.balanced,
        rules: [
          {
            id: 'on-a-threshold',
            when: [{ metric: 'food_stockpile', op: 'gte', value: 120 }],
            set: { aggression: 0.6 },
            ...(hold === undefined ? {} : { min_hold_seconds: hold }),
          },
        ],
      },
      'flappy',
    ).definition;

  const countActivations = (definition: ReturnType<typeof flappyRule>): number => {
    const sim = new Simulation({ seed: 'flap', timeLimitSeconds: 600, definitions: [definition, def('b', 'boom')] });
    sim.run(6001);
    return sim.events.filter((e) => e.type === 'rule_activated' && e.colony === 0).length;
  };

  const without = countActivations(flappyRule());
  check('a rule on a crossed threshold flaps without a hold', without > 1, `${without} activations`);

  const withHold = countActivations(flappyRule(600));
  check('min_hold_seconds stops the flapping', withHold === 1, `${withHold} activations`);
  check('the hold genuinely reduced the count', withHold < without, `${withHold} vs ${without}`);

  const parsed = parse(
    {
      id: 'holds',
      name: 'holds',
      base: PRESETS.balanced,
      rules: [
        { id: 'ok', when: [{ metric: 'my_workers', op: 'gte', value: 1 }], set: { aggression: 0.5 }, min_hold_seconds: 30 },
        { id: 'huge', when: [{ metric: 'my_workers', op: 'gte', value: 1 }], set: { aggression: 0.5 }, min_hold_seconds: 99999 },
        { id: 'bad', when: [{ metric: 'my_workers', op: 'gte', value: 1 }], set: { aggression: 0.5 }, min_hold_seconds: -5 },
      ],
    },
    'holds',
  );
  check('a valid hold is kept', parsed.definition.rules[0].min_hold_seconds === 30);
  check('an oversized hold is clamped', parsed.definition.rules[1].min_hold_seconds === 3600);
  check('a negative hold is rejected and the rule still runs', parsed.definition.rules[2].min_hold_seconds === undefined);
  check('the rejection is reported', parsed.issues.some((i) => i.path.includes('min_hold_seconds')));

  // A definition that sets no hold must behave exactly as before.
  const before = new Simulation({ seed: 'nohold', timeLimitSeconds: 600, definitions: [def('a', 'harass'), def('b', 'boom')] });
  before.run(6001);
  check('definitions without a hold are unaffected', before.finished && before.colonies[0].ruleActiveSince.size === 0);
}

console.log('stalemate detection');
{
  const stagnant = new Simulation({
    seed: '1',
    timeLimitSeconds: 90000,
    definitions: [def('a', 'turtle'), def('b', 'turtle')],
  });
  stagnant.run(900001);
  check(
    'two passive strategies end as a stalemate instead of burning the clock',
    stagnant.outcome.status === 'finished' && stagnant.outcome.reason === 'stalemate',
    stagnant.outcome.status === 'finished' ? stagnant.outcome.reason : 'running',
  );
  check('the stalemate ends the match far short of the limit', stagnant.simSeconds < 5000, `${Math.round(stagnant.simSeconds)}s`);
  check(
    'the stalemate is logged with its window',
    stagnant.events.some((e) => e.type === 'stalemate' && /600s/.test(e.text)),
  );

  // Deliberately a rules-based massing attack rather than preset-rush. A naive
  // rush against a boom is genuinely stagnant: it starves down to nothing while
  // the boom, on aggression 0.05, never walks over to finish the queen off. The
  // detector calling that a stalemate is correct, so it is no test of a war.
  const massing = parse(
    {
      id: 'massing',
      name: 'massing',
      base: { ...PRESETS.balanced, aggression: 0, min_worker_reserve: 10, target_nests: 2 },
      rules: [
        {
          id: 'commit',
          when: [{ metric: 'my_soldiers', op: 'gte', value: 12 }],
          set: { aggression: 1, soldier_posture: 'attack_enemy_nest', risk_tolerance: 0.85 },
        },
      ],
    },
    'massing',
  ).definition;
  // Opponent chosen by measurement, not assumption: since sieges were
  // introduced, a massing attack no longer reliably breaks preset-boom, so a
  // boom control would be testing the wrong thing again.
  const decisive = new Simulation({
    seed: '1',
    timeLimitSeconds: 90000,
    definitions: [massing, def('b', 'harass')],
  });
  decisive.run(900001);
  check(
    'a decisive match is still decided by elimination, not called a stalemate',
    decisive.outcome.status === 'finished' && decisive.outcome.reason === 'colony_eliminated',
    decisive.outcome.status === 'finished' ? decisive.outcome.reason : 'running',
  );

  // Constructed rather than borrowed from a preset matchup. This used to use
  // preset-rush against preset-boom, but the outcome of that pairing has moved
  // twice as the balance changed, and a control whose premise keeps expiring is
  // not testing the mechanism.
  const starved = new Simulation({
    seed: '1',
    timeLimitSeconds: 90000,
    definitions: [def('a', 'turtle'), def('b', 'boom')],
  });
  starved.run(3000);
  // Strip one colony to a queen with no food, so it can never produce again.
  for (const unit of [...starved.unitsOf(0)]) {
    if (unit.type !== 'queen') starved.units.delete(unit.id);
  }
  starved.colonies[0].food = 0;
  starved.run(900001);
  check(
    'a colony that can never produce again has its match resolved, not left to the clock',
    starved.outcome.status === 'finished' &&
      (starved.outcome.reason === 'stalemate' || starved.outcome.reason === 'colony_eliminated'),
    starved.outcome.status === 'finished' ? starved.outcome.reason : 'running',
  );
  check(
    'and it does not take the full time limit to say so',
    starved.simSeconds < 20000,
    `${Math.round(starved.simSeconds)}s of a 90000s limit`,
  );

  const disabled = new Simulation({
    seed: '1',
    timeLimitSeconds: 900,
    stalemateWindowSeconds: 0,
    definitions: [def('a', 'turtle'), def('b', 'turtle')],
  });
  disabled.run(9001);
  check(
    'the detector can be switched off',
    disabled.outcome.status === 'finished' && disabled.outcome.reason === 'time_limit',
    disabled.outcome.status === 'finished' ? disabled.outcome.reason : 'running',
  );
}

console.log('replay is version pinned');
{
  const record = runMatch({
    definitions: [def('a', 'rush'), def('b', 'boom')],
    seed: 'replay',
    timeLimitSeconds: 600,
  });
  check('a fresh record is stamped with the app version', record.appVersion === APP_VERSION, String(record.appVersion));
  check('a fresh record is stamped with the balance hash', record.balanceHash === balanceFingerprint(), String(record.balanceHash));
  check('a fresh record is replayable', isReplayable(record));

  const { identical } = replayRecord(record);
  check('replaying a same-version record reproduces it exactly', identical);

  // Both halves of the stamp must be load bearing, so test them separately.
  const wrongVersion = { ...record, appVersion: '0.0.1' };
  let refusedVersion = false;
  try {
    replayRecord(wrongVersion);
  } catch (error) {
    refusedVersion = error instanceof NotReplayable;
  }
  check('replaying a record from another app version is refused', refusedVersion);

  const wrongBalance = { ...record, balanceHash: 'deadbeef' };
  let refusedBalance = false;
  try {
    replayRecord(wrongBalance);
  } catch (error) {
    refusedBalance = error instanceof NotReplayable;
  }
  check('replaying a record made with different balance numbers is refused', refusedBalance);

  const unstamped = { ...record };
  delete (unstamped as { appVersion?: string }).appVersion;
  delete (unstamped as { balanceHash?: string }).balanceHash;
  let refusedUnstamped = false;
  try {
    replayRecord(unstamped as typeof record);
  } catch (error) {
    refusedUnstamped = error instanceof NotReplayable;
  }
  check('replaying a record from before version stamping is refused', refusedUnstamped);
  check('the balance fingerprint is stable across calls', balanceFingerprint() === balanceFingerprint());
}

console.log('expansion bias');
{
  const withBias = (bias: string) =>
    parse(
      { id: 'b', name: 'b', base: { ...PRESETS.boom, target_nests: 4, expansion_bias: bias }, rules: [] },
      'b',
    ).definition;

  const meanDistanceToEnemy = (bias: string) => {
    const sim = new Simulation({
      seed: '1',
      timeLimitSeconds: 900,
      definitions: [withBias(bias), def('o', 'turtle')],
    });
    sim.run(9001);
    const nests = sim.colonies[0].nests;
    return nests.reduce((sum, nest) => sum + sim.distanceToNearestNest(1, nest), 0) / nests.length;
  };

  const forward = meanDistanceToEnemy('toward_enemy');
  const neutral = meanDistanceToEnemy('toward_food');
  const back = meanDistanceToEnemy('toward_safety');
  check('toward_enemy settles closer to the enemy than the default', forward < neutral, `${forward.toFixed(0)} vs ${neutral.toFixed(0)}`);
  check('toward_safety settles further away than the default', back > neutral, `${back.toFixed(0)} vs ${neutral.toFixed(0)}`);

  const parsedBad = parse(
    { id: 'x', name: 'x', base: { ...PRESETS.boom, expansion_bias: 'toward_the_sun' }, rules: [] },
    'x',
  );
  check('an unknown bias falls back and is reported', parsedBad.definition.base.expansion_bias === 'toward_food' && parsedBad.issues.length > 0);

  // Omitting the knob must reproduce the old behaviour exactly.
  const omitted = parse({ id: 'y', name: 'y', base: { ...PRESETS.boom, expansion_bias: undefined }, rules: [] }, 'y');
  check('omitting the knob keeps the previous behaviour', omitted.definition.base.expansion_bias === 'toward_food');
}

console.log('rule conditions');
{
  const metrics = { my_soldiers: 5, enemy_soldiers: 9, my_workers: 30, sim_seconds: 100 } as never;

  const build = (when: unknown[]) =>
    parse(
      { id: 'c', name: 'c', base: PRESETS.balanced, rules: [{ id: 'r', when, set: { aggression: 0.9 } }] },
      'c',
    );

  // Comparing two metrics: previously impossible, an author had to guess an
  // absolute threshold instead of stating the relationship they meant.
  const versus = build([{ metric: 'my_soldiers', op: 'lt', metric2: 'enemy_soldiers' }]);
  check('a metric-versus-metric condition parses', versus.definition.rules.length === 1, JSON.stringify(versus.issues));
  check(
    'and evaluates against the other metric',
    evaluateRules(versus.definition, metrics).activeRuleIds.length === 1,
  );
  const versusFalse = build([{ metric: 'my_soldiers', op: 'gt', metric2: 'enemy_soldiers' }]);
  check('and is false when it should be', evaluateRules(versusFalse.definition, metrics).activeRuleIds.length === 0);

  // any_of: one holding is enough.
  const group = build([
    { any_of: [{ metric: 'my_workers', op: 'gte', value: 999 }, { metric: 'my_soldiers', op: 'gte', value: 3 }] },
  ]);
  check('an any_of group parses', group.definition.rules.length === 1, JSON.stringify(group.issues));
  check('one member holding is enough', evaluateRules(group.definition, metrics).activeRuleIds.length === 1);
  const noneHold = build([
    { any_of: [{ metric: 'my_workers', op: 'gte', value: 999 }, { metric: 'my_soldiers', op: 'gte', value: 999 }] },
  ]);
  check('no member holding means the rule does not fire', evaluateRules(noneHold.definition, metrics).activeRuleIds.length === 0);

  // Clauses are still ANDed with each other.
  const mixed = build([
    { metric: 'sim_seconds', op: 'gte', value: 50 },
    { any_of: [{ metric: 'my_soldiers', op: 'lt', metric2: 'enemy_soldiers' }] },
  ]);
  check('a group and a plain clause are ANDed together', evaluateRules(mixed.definition, metrics).activeRuleIds.length === 1);

  // Malformed forms must be rejected by path, not silently accepted.
  const badMetric2 = build([{ metric: 'my_soldiers', op: 'lt', metric2: 'vibes' }]);
  check('an unknown metric2 is rejected with its path', badMetric2.definition.rules.length === 0 && badMetric2.issues.some((i) => i.path.includes('metric2')));
  const emptyGroup = build([{ any_of: [] }]);
  check('an empty any_of is rejected', emptyGroup.definition.rules.length === 0 && emptyGroup.issues.some((i) => i.path.includes('any_of')));
  const noValue = build([{ metric: 'my_soldiers', op: 'gte' }]);
  check('a condition with neither value nor metric2 is rejected', noValue.definition.rules.length === 0);
  const both = build([{ metric: 'my_soldiers', op: 'lt', value: 3, metric2: 'enemy_soldiers' }]);
  check('having both value and metric2 is reported but metric2 wins', both.definition.rules.length === 1 && both.issues.some((i) => i.message.includes('metric2')));

  // Existing definitions must be untouched.
  const before = new Simulation({ seed: 'compat', timeLimitSeconds: 600, definitions: [def('a', 'boom'), def('b', 'rush')] });
  before.run(6001);
  check('plain value conditions still work exactly as before', before.finished && before.colonies[0].lifetimeFoodGathered > 0);
}

console.log('the ladder');
{
  const hash = balanceFingerprint();
  const row = (a: string, b: string, winner: string | null, balanceHash = hash): MatchSummaryRow => ({
    id: `${a}-${b}-${winner}-${Math.round(a.length + b.length)}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    appVersion: APP_VERSION,
    balanceHash,
    aVersion: 1,
    bVersion: 1,
    seed: '1',
    a,
    b,
    winner,
    reason: 'colony_eliminated',
    scores: [1, 0],
    durationSeconds: 100,
  });

  // A clear hierarchy: strong beats mid, mid beats weak, strong beats weak.
  const hierarchy = [
    ...Array.from({ length: 8 }, () => row('strong', 'mid', 'strong')),
    ...Array.from({ length: 8 }, () => row('mid', 'weak', 'mid')),
    ...Array.from({ length: 8 }, () => row('strong', 'weak', 'strong')),
  ];
  const ladder = buildLadder(hierarchy);
  check('the ladder ranks a clear hierarchy correctly', ladder.rows.map((r) => r.id).join(',') === 'strong,mid,weak', ladder.rows.map((r) => `${r.id}:${r.rating}`).join(' '));
  check('a dominant competitor rates above a losing one', ladder.rows[0].rating > ladder.rows[2].rating + 200);

  // The whole reason for Bradley-Terry over Elo: order must not matter.
  const shuffled = [...hierarchy].reverse();
  const other = buildLadder(shuffled);
  check(
    'ratings do not depend on the order matches were played',
    JSON.stringify(ladder.rows.map((r) => [r.id, r.rating])) === JSON.stringify(other.rows.map((r) => [r.id, r.rating])),
  );

  // Evenly matched competitors must not be separated by noise in the maths.
  const even = buildLadder([
    ...Array.from({ length: 6 }, () => row('x', 'y', 'x')),
    ...Array.from({ length: 6 }, () => row('x', 'y', 'y')),
  ]);
  check('an even record gives equal ratings', even.rows[0].rating === even.rows[1].rating, even.rows.map((r) => `${r.id}:${r.rating}`).join(' '));

  const drawn = buildLadder(Array.from({ length: 4 }, () => row('p', 'q', null)));
  check('draws count for both sides', drawn.rows.every((r) => r.draws === 4 && r.wins === 0));
  check('all draws leaves ratings level', drawn.rows[0].rating === drawn.rows[1].rating);

  // Comparability: results from other balance numbers are a different game.
  const mixed = buildLadder([...hierarchy, row('weak', 'strong', 'weak', 'deadbeef')]);
  check('matches from other balance numbers are ignored', mixed.matchesIgnored === 1 && mixed.matchesConsidered === hierarchy.length);
  check(
    'and cannot change the ranking',
    mixed.rows.map((r) => r.id).join(',') === 'strong,mid,weak',
  );

  // Revising a definition must not inherit the old rating.
  const versioned = buildLadder([
    ...Array.from({ length: 6 }, () => ({ ...row('same', 'other', 'same'), aVersion: 1 })),
    ...Array.from({ length: 6 }, () => ({ ...row('same', 'other', 'other'), aVersion: 2 })),
  ]);
  check(
    'a definition is ranked per version',
    versioned.rows.filter((r) => r.id === 'same').length === 2,
    versioned.rows.map((r) => r.key).join(' '),
  );

  check('a mirror match is not used for ranking', buildLadder([row('solo', 'solo', 'solo')]).rows.length === 0);
  check('win rates carry an interval', ladder.rows.every((r) => r.low <= r.winRate && r.winRate <= r.high));
}

console.log('map fairness');
{
  // The interval maths first, since every fairness verdict rests on it.
  const even = winRateInterval(5, 10);
  check('an even split brackets 50%', even.low <= 0.5 && even.high >= 0.5, `${even.low.toFixed(2)}-${even.high.toFixed(2)}`);
  const total = winRateInterval(10, 10);
  check('a clean sweep does not bracket 50%', total.low > 0.5, `${total.low.toFixed(2)}-${total.high.toFixed(2)}`);
  check('no games means nothing is disproved', winRateInterval(0, 0).high === 1);
  const wide = winRateInterval(3, 4);
  const narrow = winRateInterval(750, 1000);
  check(
    'a bigger sample gives a tighter interval',
    wide.high - wide.low > narrow.high - narrow.low,
    `${(wide.high - wide.low).toFixed(2)} vs ${(narrow.high - narrow.low).toFixed(2)}`,
  );

  const mirror = runMirror({
    definition: def('m', 'balanced'),
    seeds: ['1', '2', '3', '4', '5', '6'],
    timeLimitSeconds: 600,
  });
  check('a mirror match plays every seed', mirror.games === 6, String(mirror.games));
  check(
    'every mirror game is accounted for',
    mirror.sideAWins + mirror.sideBWins + mirror.draws === mirror.games,
    `${mirror.sideAWins}+${mirror.sideBWins}+${mirror.draws}`,
  );
  check('the reported rate sits inside its own interval', mirror.sideARate >= mirror.low && mirror.sideARate <= mirror.high);
  check(
    'a definition against itself is not decided by which side it played',
    mirror.fair,
    `side A won ${(mirror.sideARate * 100).toFixed(0)}% (${(mirror.low * 100).toFixed(0)}-${(mirror.high * 100).toFixed(0)}%)`,
  );
}

console.log('the project is installable');
{
  // Cheap guards on the install story. A clean clone reaching a running server
  // is verified by hand, but these stop the pieces silently disappearing.
  const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    license?: string;
    engines?: { node?: string };
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
  };

  check('a licence is declared', pkg.license === 'MIT', String(pkg.license));
  check('a LICENSE file exists', readFileSync(join(root, 'LICENSE'), 'utf8').includes('MIT License'));
  check('the required Node version is declared', !!pkg.engines?.node, String(pkg.engines?.node));
  check('.nvmrc agrees with engines', readFileSync(join(root, '.nvmrc'), 'utf8').trim() === '22');
  check('there is a start script', typeof pkg.scripts.start === 'string');
  check(
    'the runtime is a real dependency, not a dev one',
    typeof pkg.dependencies.tsx === 'string',
    'npm start runs the server through tsx, so it cannot be a devDependency',
  );
  check('a Dockerfile exists', readFileSync(join(root, 'Dockerfile'), 'utf8').includes('FROM node:'));
  check('the readme leads with the two command quick start', readFileSync(join(root, 'README.md'), 'utf8').includes('npm install\nnpm start'));
}

console.log('the agent brief matches the code');
{
  // A brief that has quietly fallen behind the simulation is worse than none at
  // all: a model reads it, believes it, and plays to rules that no longer exist.
  const briefPath = join(dirname(fileURLToPath(import.meta.url)), '../../docs/agent-brief.md');
  const brief = readFileSync(briefPath, 'utf8');

  const knobs = Object.keys(DEFAULT_STRATEGY);
  const missingKnobs = knobs.filter((knob) => !brief.includes(knob));
  check('the brief documents every knob', missingKnobs.length === 0, missingKnobs.join(', '));

  const missingMetrics = RULE_METRICS.filter((metric) => !brief.includes(metric));
  check('the brief documents every rule metric', missingMetrics.length === 0, missingMetrics.join(', '));

  const missingPostures = SOLDIER_POSTURES.filter((posture) => !brief.includes(posture));
  check('the brief documents every soldier posture', missingPostures.length === 0, missingPostures.join(', '));

  const missingPriorities = EXPANSION_PRIORITIES.filter((p) => !brief.includes(p));
  check('the brief documents every expansion priority', missingPriorities.length === 0, missingPriorities.join(', '));

  const missingOps = RULE_OPS.filter((op) => !brief.includes(`\`${op}\``));
  check('the brief documents every rule operator', missingOps.length === 0, missingOps.join(', '));

  // Numbers that a strategy author would plan around, and that a config change
  // would silently invalidate.
  check(
    'the brief quotes the real attacker cap',
    brief.includes(`${QUEEN_MAX_ATTACKERS} attackers can reach her`),
    `expected ${QUEEN_MAX_ATTACKERS}`,
  );
  check(
    'the brief quotes the real queen health',
    brief.includes(UNIT_STATS.queen.maxHp.toLocaleString('en-US')),
    `expected ${UNIT_STATS.queen.maxHp}`,
  );
  check(
    'the brief quotes the real population ceiling',
    brief.includes(`${UNITS_PER_NEST} unit`),
    `expected ${UNITS_PER_NEST}`,
  );
  check('the brief quotes the real nest cap', brief.includes(`(1-${MAX_NESTS_PER_COLONY})`));
  check(
    'the brief quotes the real recycling threshold',
    brief.includes(`${RECYCLE_PRESSURE_FRACTION * 100}%`),
    `expected ${RECYCLE_PRESSURE_FRACTION * 100}%`,
  );
  check('the brief names every starter definition it ranks', ['preset-boom', 'preset-blockade', 'example-adaptive'].every((id) => brief.includes(id)));
}

console.log('changelog');
{
  const versions = CHANGELOG.map((entry) => entry.version);
  check('every version is unique', new Set(versions).size === versions.length);
  check('versions look like semver', versions.every((v) => /^\d+\.\d+\.\d+$/.test(v)), versions.join(','));
  check('APP_VERSION is the newest entry', APP_VERSION === versions[0], `${APP_VERSION} vs ${versions[0]}`);
  check(
    'every timestamp parses and carries an offset',
    CHANGELOG.every((entry) => !Number.isNaN(Date.parse(entry.timestamp)) && /[+-]\d{2}:\d{2}$/.test(entry.timestamp)),
  );
  const times = CHANGELOG.map((entry) => Date.parse(entry.timestamp));
  check('entries are newest first', times.every((t, i) => i === 0 || t <= times[i - 1]));
  check('every entry records at least one change', CHANGELOG.every((entry) => entry.changes.length > 0));
  check('every entry has a title', CHANGELOG.every((entry) => entry.title.trim().length > 0));
  check(
    'reconstructed entries claim no commit',
    CHANGELOG.every((entry) => entry.precision !== 'reconstructed' || entry.commit === undefined),
  );
  check('the changelog is not empty', totalChanges() > 0, `${totalChanges()} changes`);
}

console.log('');
console.log(failures === 0 ? 'all checks passed' : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
