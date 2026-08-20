/**
 * Match viewer. The browser runs the same Simulation class the server does, so
 * a "replay" is just re-running the deterministic sim from (definitions, seed).
 * No frame data is ever stored or streamed.
 */
import { Simulation } from '../sim/sim.js';
import { SCORE_WEIGHTS, TICKS_PER_SECOND, UNIT_STATS } from '../sim/config.js';
import { describeStrategy } from '../sim/rules.js';
import type { BehaviourDefinition } from '../sim/definition.js';
import type { ColonyId, MatchEvent } from '../sim/types.js';
import type { StrategyConfig } from '../sim/strategy.js';
import { Renderer } from './renderer.js';
import { APP_VERSION, CHANGELOG, totalChanges, type ChangeArea } from '../meta/changelog.js';

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
};

const canvas = el<HTMLCanvasElement>('canvas');
const renderer = new Renderer(canvas);

const defASelect = el<HTMLSelectElement>('defA');
const defBSelect = el<HTMLSelectElement>('defB');
const pastSelect = el<HTMLSelectElement>('pastMatch');
const seedInput = el<HTMLInputElement>('seed');
const limitInput = el<HTMLInputElement>('limit');
const showIntel = el<HTMLInputElement>('showIntel');
const playPause = el<HTMLButtonElement>('playPause');
const eventLog = el<HTMLOListElement>('eventLog');
const summary = el<HTMLDivElement>('summary');
const changelog = el<HTMLDivElement>('changelog');

let sim: Simulation | null = null;
let playing = false;
let speed: number | 'max' = 2;
let loggedEvents = 0;
let lastKnobs: [string, string] = ['', ''];

// -------------------------------------------------------------------- API calls

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error(`${path} responded ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

interface DefinitionRow { id: string; name: string; rules: number; author?: string }

async function loadLists(): Promise<void> {
  const definitions = await api<DefinitionRow[]>('/api/definitions');
  for (const [index, select] of [defASelect, defBSelect].entries()) {
    // The list is refreshed after every match, so keep whatever the user picked
    // rather than snapping back to the defaults.
    const current = select.value;
    select.innerHTML = '';
    for (const row of definitions) {
      const option = document.createElement('option');
      option.value = row.id;
      option.textContent = `${row.id} (${row.rules} rules)`;
      select.append(option);
    }
    const preferred = index === 0 ? 'example-mass-rush' : 'preset-boom';
    const wanted = definitions.some((d) => d.id === current) ? current : preferred;
    select.value = definitions.some((d) => d.id === wanted) ? wanted : (definitions[index]?.id ?? '');
  }

  const matches = await api<
    Array<{
      id: string;
      a: string;
      b: string;
      winner: string | null;
      seed: string | number;
      appVersion?: string;
      replayable?: boolean;
    }>
  >('/api/matches?limit=40');
  pastSelect.innerHTML = '<option value="">-</option>';
  for (const row of matches) {
    const option = document.createElement('option');
    option.value = row.id;
    const label = `${row.a} vs ${row.b} seed ${row.seed} → ${row.winner ?? 'draw'}`;
    // A replay re-runs the simulation, so a record made by different code would
    // quietly show a different game. Better to disable it and say why.
    if (row.replayable) {
      option.textContent = label;
    } else {
      option.textContent = `${label} (needs ${row.appVersion ?? 'an older build'})`;
      option.disabled = true;
    }
    pastSelect.append(option);
  }
}

// ---------------------------------------------------------------- match control

async function startMatch(aId: string, bId: string, seed: string, timeLimitSeconds: number): Promise<void> {
  const [a, b] = await Promise.all([
    api<{ definition: BehaviourDefinition }>(`/api/definitions/${aId}`),
    api<{ definition: BehaviourDefinition }>(`/api/definitions/${bId}`),
  ]);
  sim = new Simulation({ seed, timeLimitSeconds, definitions: [a.definition, b.definition] });
  loggedEvents = 0;
  lastKnobs = ['', ''];
  tickCarry = 0;
  eventLog.innerHTML = '';
  summary.classList.add('hidden');
  playing = true;
  playPause.textContent = 'Pause';
  render();
}

async function replayMatch(id: string): Promise<void> {
  const record = await api<{
    definitions: [BehaviourDefinition, BehaviourDefinition];
    seed: string | number;
    timeLimitSeconds: number;
  }>(`/api/matches/${id}?view=summary`);
  sim = new Simulation({
    seed: record.seed,
    timeLimitSeconds: record.timeLimitSeconds,
    definitions: record.definitions,
  });
  loggedEvents = 0;
  lastKnobs = ['', ''];
  tickCarry = 0;
  eventLog.innerHTML = '';
  summary.classList.add('hidden');
  seedInput.value = String(record.seed);
  limitInput.value = String(record.timeLimitSeconds);
  playing = true;
  playPause.textContent = 'Pause';
  render();
}

// ----------------------------------------------------------------------- loop

let lastFrame = performance.now();
/**
 * Fractional ticks carried between frames. At 60fps and 1x speed a frame is
 * only 0.16 of a tick, so rounding per frame would floor to zero and the match
 * would never advance.
 */
let tickCarry = 0;

function frame(now: number): void {
  const elapsed = Math.min(0.25, (now - lastFrame) / 1000);
  lastFrame = now;

  if (sim && playing && !sim.finished) {
    if (speed === 'max') {
      // Burn a fixed slice of the frame budget rather than a tick count, so
      // "max" stays responsive on any machine.
      const deadline = performance.now() + 12;
      while (performance.now() < deadline && !sim.finished) sim.run(20);
      tickCarry = 0;
    } else {
      tickCarry += elapsed * TICKS_PER_SECOND * speed;
      const ticks = Math.min(4000, Math.floor(tickCarry));
      tickCarry -= ticks;
      if (ticks > 0) sim.run(ticks);
    }
    if (sim.finished) {
      playing = false;
      playPause.textContent = 'Play';
      showSummary();
      void loadLists();
    }
  }

  render();
  requestAnimationFrame(frame);
}

function render(): void {
  if (!sim) return;
  renderer.draw(sim, { showIntel: showIntel.checked });
  updatePanels();
  appendEvents();
  const progress = Math.min(1, sim.tick / sim.timeLimitTicks);
  el<HTMLDivElement>('progressFill').style.width = `${progress * 100}%`;
  el<HTMLSpanElement>('clock').textContent = `${Math.floor(sim.simSeconds)}s / ${sim.timeLimitSeconds}s`;
}

// ------------------------------------------------------------------------ HUD

function knobRows(strategy: StrategyConfig): Array<[string, string]> {
  return [
    ['production', `${strategy.unit_production_ratio.worker.toFixed(2)}w / ${strategy.unit_production_ratio.soldier.toFixed(2)}s`],
    ['aggression', strategy.aggression.toFixed(2)],
    ['expansion', strategy.expansion_priority],
    ['worker reserve', String(strategy.min_worker_reserve)],
    ['posture', strategy.soldier_posture],
    ['risk', strategy.risk_tolerance.toFixed(2)],
    ['target nests', String(strategy.target_nests)],
  ];
}

function updatePanels(): void {
  if (!sim) return;
  for (const id of [0, 1] as ColonyId[]) {
    const colony = sim.colonies[id];
    const queens = sim.queensOf(id);
    const founding = sim.foundingQueensOf(id).length;
    const panel = el<HTMLDivElement>(id === 0 ? 'panelA' : 'panelB');
    const hp = sim.lowestQueenHealth(id);
    const building = queens
      .filter((queen) => queen.build)
      .map((queen) => `${queen.build!.type} ${(queen.build!.totalSeconds - queen.build!.secondsRemaining).toFixed(0)}/${queen.build!.totalSeconds}s`)
      .join(', ');
    const knobs = knobRows(colony.strategy);
    const changed = describeStrategy(colony.strategy) !== lastKnobs[id];
    lastKnobs[id] = describeStrategy(colony.strategy);

    panel.className = `panel ${id === 0 ? 'a' : 'b'}`;
    panel.innerHTML = `
      <h3>${escape(colony.name)}</h3>
      <p class="sub">${escape(colony.definition.id)} v${colony.definition.version ?? 1} by ${escape(colony.definition.author ?? '?')}</p>
      <div class="stats">
        <div class="stat"><b>${Math.floor(colony.food)}</b><span>food</span></div>
        <div class="stat"><b>${sim.countUnits(id, 'worker')}</b><span>workers</span></div>
        <div class="stat"><b>${sim.countUnits(id, 'soldier')}</b><span>soldiers</span></div>
        <div class="stat"><b>${colony.nests.length}${founding > 0 ? `+${founding}` : ''}</b><span>nests</span></div>
      </div>
      <div class="hp ${hp < 0.4 ? 'low' : ''}"><div style="width:${(hp * 100).toFixed(0)}%"></div></div>
      <p class="sub">queens ${queens.length}${founding > 0 ? ` (${founding} walking)` : ''},
        weakest ${queens.length ? `${Math.round(hp * 100)}%` : 'none'} · hauled ${Math.round(colony.lifetimeFoodGathered)} ·
        kills ${colony.kills} · lost ${colony.unitsLost.worker + colony.unitsLost.soldier} ·
        building ${building || 'nothing'}</p>
      <ul class="knobs">
        ${knobs.map(([key, value]) => `<li class="${changed ? 'changed' : ''}"><span>${key}</span><b>${escape(value)}</b></li>`).join('')}
      </ul>
      <ul class="rules">
        ${
          colony.definition.rules.length === 0
            ? '<li>no rules, static knobs</li>'
            : colony.definition.rules
                .map((rule) => {
                  const on = colony.activeRuleIds.includes(rule.id!);
                  return `<li class="${on ? 'on' : 'off'}">${escape(rule.id!)}${rule.note ? ` — ${escape(rule.note)}` : ''}</li>`;
                })
                .join('')
        }
      </ul>`;
  }
}

function appendEvents(): void {
  if (!sim) return;
  const fresh = sim.events.slice(loggedEvents);
  loggedEvents = sim.events.length;
  for (const event of fresh) {
    if (!event.major && event.type === 'unit_lost') continue; // too noisy for the live log
    const item = document.createElement('li');
    item.className = `${event.colony !== null ? `c${event.colony}` : ''} ${event.major ? 'major' : ''}`;
    item.innerHTML = `<span class="t">${Math.floor(event.simSeconds)}s</span> ${escape(event.text)}`;
    eventLog.prepend(item);
  }
  while (eventLog.childElementCount > 300) eventLog.lastElementChild?.remove();
}

// -------------------------------------------------------------------- summary

function showSummary(): void {
  if (!sim || sim.outcome.status !== 'finished') return;
  const outcome = sim.outcome;
  const [a, b] = [sim.scoreOf(0), sim.scoreOf(1)];
  const rows = (id: ColonyId, score = id === 0 ? a : b) => {
    const colony = sim!.colonies[id];
    return `
      <h3>${escape(colony.name)}</h3>
      <table>
        <tr><td>workers / soldiers</td><td>${sim!.countUnits(id, 'worker')} / ${sim!.countUnits(id, 'soldier')}</td></tr>
        <tr><td>queens / nests</td><td>${sim!.queensOf(id).length} / ${colony.nests.length}</td></tr>
        <tr><td>nests founded</td><td>${colony.nestsFounded}</td></tr>
        <tr><td>produced</td><td>w${colony.unitsProduced.worker} / s${colony.unitsProduced.soldier} / q${colony.unitsProduced.queen - 1}</td></tr>
        <tr><td>lost</td><td>w${colony.unitsLost.worker} / s${colony.unitsLost.soldier}</td></tr>
        <tr><td>kills</td><td>${colony.kills}</td></tr>
        <tr><td>food stockpile</td><td>${Math.round(colony.food)}</td></tr>
        <tr><td>food hauled</td><td>${Math.round(colony.lifetimeFoodGathered)}</td></tr>
        <tr><td>colony</td><td>${sim!.isAlive(id) ? 'alive' : 'eliminated'}</td></tr>
        <tr><td><b>score</b></td><td><b>${score.total.toFixed(0)}</b></td></tr>
      </table>`;
  };

  const winner = outcome.winner === null ? 'Draw' : `${sim.colonies[outcome.winner].name} wins`;
  summary.innerHTML = `
    <div class="card">
      <h2>${escape(winner)}</h2>
      <p class="formula">${outcome.reason.replace(/_/g, ' ')} at ${Math.floor(sim.simSeconds)}s ·
        ${escape(scoreFormula())}
        Score only decides matches that reach the time limit; losing every queen loses outright.</p>
      <div class="cols"><div>${rows(0)}</div><div>${rows(1)}</div></div>
      <h3>Key events</h3>
      <div class="timeline">
        ${sim.events
          .filter((e) => e.major)
          .map((e: MatchEvent) => `<div><span class="t">${Math.floor(e.simSeconds)}s</span> ${escape(e.text)}</div>`)
          .join('')}
      </div>
      <p><button id="closeSummary">Close</button></p>
    </div>`;
  summary.classList.remove('hidden');
  el<HTMLButtonElement>('closeSummary').onclick = () => summary.classList.add('hidden');
}

/** Built from the weights themselves, so the wording cannot drift from the maths. */
function scoreFormula(): string {
  return (
    `score = ${SCORE_WEIGHTS.queenAlive} per living queen + ${SCORE_WEIGHTS.worker} per worker` +
    ` + ${SCORE_WEIGHTS.soldier} per soldier + ${SCORE_WEIGHTS.foodStockpile} per food stockpiled` +
    ` + ${SCORE_WEIGHTS.lifetimeFood} per food hauled.`
  );
}

// --------------------------------------------------------------- changelog view

const AREA_LABELS: Record<ChangeArea, string> = {
  sim: 'sim',
  ai: 'unit ai',
  balance: 'balance',
  perf: 'perf',
  api: 'api',
  ui: 'viewer',
  tests: 'tests',
  docs: 'docs',
  tooling: 'tooling',
};

/**
 * Rendered in the timestamp's own offset, not the reader's, so an entry always
 * shows the moment it was recorded.
 */
function formatWhen(iso: string): string {
  const offset = iso.slice(-6);
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  const minutes = match ? (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : 0;
  const shifted = new Date(new Date(iso).getTime() + minutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return (
    `${days[shifted.getUTCDay()]} ${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    ` ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())} (UTC${offset})`
  );
}

function renderChangelog(): void {
  const entries = CHANGELOG.map((entry) => {
    const provenance = entry.commit
      ? `commit ${escape(entry.commit)}`
      : entry.precision === 'commit'
        ? 'committed'
        : 'reconstructed, no commit';
    const items = entry.changes
      .map(
        (change) =>
          `<li><span class="tag ${change.fix ? 'fix' : ''}">${escape(change.fix ? 'fix' : AREA_LABELS[change.area])}</span>` +
          `<span class="text">${escape(change.detail)}</span></li>`,
      )
      .join('');
    return `
      <div class="entry">
        <h3>${escape(entry.version)} — ${escape(entry.title)}</h3>
        <p class="when">${escape(formatWhen(entry.timestamp))} · ${provenance} · ${entry.changes.length} changes</p>
        <ul>${items}</ul>
      </div>`;
  }).join('');

  changelog.innerHTML = `
    <div class="card">
      <h2>Changelog</h2>
      <p class="provenance">
        Version ${escape(APP_VERSION)} · ${CHANGELOG.length} releases · ${totalChanges()} recorded changes.
        Entries marked "reconstructed" predate version control on this project: their times come from file
        modification times and saved match records, so they are accurate to the hour and have no commits behind
        them. Later entries carry a git commit.
      </p>
      ${entries}
      <p><button id="closeChangelog">Close</button></p>
    </div>`;
  changelog.classList.remove('hidden');
  el<HTMLButtonElement>('closeChangelog').onclick = () => {
    changelog.classList.add('hidden');
    if (location.hash === '#changelog') history.replaceState(null, '', location.pathname);
  };
}

function escape(input: string): string {
  return input.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// --------------------------------------------------------------------- wiring

el<HTMLSpanElement>('versionNumber').textContent = `v${APP_VERSION}`;

el<HTMLAnchorElement>('versionLink').onclick = (event) => {
  event.preventDefault();
  history.replaceState(null, '', '#changelog');
  renderChangelog();
};

// Deep link, so the changelog can be shared or bookmarked.
if (location.hash === '#changelog') renderChangelog();

el<HTMLButtonElement>('newMatch').onclick = () =>
  void startMatch(defASelect.value, defBSelect.value, seedInput.value || '1', Number(limitInput.value) || 600);

el<HTMLButtonElement>('restart').onclick = () => {
  if (!sim) return;
  const [a, b] = sim.colonies.map((colony) => colony.definition.id);
  void startMatch(a, b, seedInput.value || '1', Number(limitInput.value) || 600);
};

playPause.onclick = () => {
  if (!sim) return;
  playing = !playing && !sim.finished;
  playPause.textContent = playing ? 'Pause' : 'Play';
};

for (const button of document.querySelectorAll<HTMLButtonElement>('.speeds button')) {
  button.onclick = () => {
    const value = button.dataset.speed!;
    speed = value === 'max' ? 'max' : Number(value);
    for (const other of document.querySelectorAll('.speeds button')) other.classList.remove('active');
    button.classList.add('active');
  };
}
document.querySelector('.speeds button[data-speed="2"]')?.classList.add('active');

pastSelect.onchange = () => {
  if (pastSelect.value) void replayMatch(pastSelect.value);
};

window.addEventListener('keydown', (event) => {
  if (event.code === 'Space') {
    event.preventDefault();
    playPause.click();
  }
});

void (async () => {
  await loadLists();
  await startMatch(defASelect.value, defBSelect.value, seedInput.value, Number(limitInput.value));
  requestAnimationFrame(frame);
})();

export { UNIT_STATS };
