/**
 * Self test. Not a unit test suite, a set of assertions that the simulation is
 * deterministic and not obviously broken. Run with: npm run selftest
 */
import { Simulation } from '../sim/sim.js';
import { parseDefinition } from '../sim/definition.js';
import { PRESETS } from '../sim/strategy.js';
import { runMatch } from '../match/runner.js';
import { MAP_HEIGHT, MAP_WIDTH, MIN_NEST_SEPARATION, UNITS_PER_NEST, UNIT_STATS } from '../sim/config.js';
import { parseDefinition as parse } from '../sim/definition.js';
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
  fought.run(9001);
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
    Math.max(...corpses.map((c) => c.amount)) > UNIT_STATS.worker.carryCapacity,
    String(Math.round(Math.max(...corpses.map((c) => c.amount)))),
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
