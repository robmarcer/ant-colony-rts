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
import { APP_VERSION } from '../meta/changelog.js';
import { changelogHtml } from './changelog-view.js';

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
const fogView = el<HTMLSelectElement>('fogView');
const zoomLevel = el<HTMLSpanElement>('zoomLevel');
const playPause = el<HTMLButtonElement>('playPause');
const eventLog = el<HTMLOListElement>('eventLog');
const summary = el<HTMLDivElement>('summary');
const docsPanel = el<HTMLElement>('docsPanel');

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
  renderer.draw(sim, {
    showIntel: showIntel.checked,
    fogView: Number(fogView.value) as -1 | 0 | 1,
  });
  updatePanels();
  appendEvents();
  zoomLevel.textContent = `${renderer.getView().zoom.toFixed(1)}x`;
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

// ------------------------------------------------------------------ docs panel

/**
 * One panel, docked beside the match rather than over it.
 *
 * A full screen overlay was the original design and the complaint was that it
 * covered the match. Separate tabs fixed that but cost a tab per look, and
 * measured worse on the thing they were chosen for: a hidden tab throttles
 * requestAnimationFrame to 1fps, so the match ran at roughly a quarter speed.
 * Docking keeps the canvas visible and the loop in the foreground.
 */
function openPanel(title: string, body: string): void {
  docsPanel.innerHTML = `<button class="close" id="closePanel" title="Escape also closes">close</button>${body}`;
  docsPanel.scrollTop = 0;
  docsPanel.classList.remove('hidden');
  el<HTMLButtonElement>('closePanel').onclick = closePanel;
}

function closePanel(): void {
  docsPanel.classList.add('hidden');
  docsPanel.innerHTML = '';
}

async function openInstructions(): Promise<void> {
  // Fetched, not bundled, so the panel shows exactly what the API serves.
  let brief: string;
  try {
    const response = await fetch('/api/brief');
    if (!response.ok) throw new Error(`the API responded ${response.status}`);
    brief = await response.text();
  } catch (error) {
    openPanel(
      'Instructions',
      `<h1>Instructions for an LLM</h1><p class="provenance">Could not reach the API: ${escape(
        error instanceof Error ? error.message : String(error),
      )}</p>`,
    );
    return;
  }

  openPanel(
    'Instructions',
    `<h1>Instructions for an LLM</h1>
     <p class="provenance">Paste this into the model you want writing strategies, and tell it the API is at
       <code>${escape(location.origin)}/api</code>. Live from <code>GET /api/brief</code>.</p>
     <p><button id="copyBrief" class="primary">Copy the brief</button> <span id="copiedNote" class="provenance"></span></p>
     <pre id="briefText"></pre>`,
  );
  (el<HTMLPreElement>('briefText') as HTMLPreElement).textContent = brief;
  el<HTMLButtonElement>('copyBrief').onclick = async () => {
    const note = el<HTMLSpanElement>('copiedNote');
    try {
      await navigator.clipboard.writeText(brief);
      note.textContent = `copied ${brief.length} characters`;
    } catch {
      note.textContent = 'clipboard refused, select the text below instead';
    }
  };
}

function escape(input: string): string {
  return input.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// --------------------------------------------------------------------- wiring

el<HTMLSpanElement>('versionNumber').textContent = `v${APP_VERSION}`;

// The links stay real URLs so they can be opened in a tab deliberately or
// bookmarked, but a plain click opens the panel instead of navigating.
el<HTMLAnchorElement>('changelogLink').onclick = (event) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey) return;
  event.preventDefault();
  openPanel('Changelog', changelogHtml());
};

el<HTMLAnchorElement>('instructionsLink').onclick = (event) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey) return;
  event.preventDefault();
  void openInstructions();
};

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

// ------------------------------------------------------------------ view input

/**
 * Wheel zooms toward the pointer. passive: false because the page scrolls
 * otherwise, and zooming the map while the document jumps is unusable.
 */
canvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    renderer.zoomAt(event.clientX - rect.left, event.clientY - rect.top, Math.exp(-event.deltaY * 0.0015));
  },
  { passive: false },
);

let dragging = false;
let lastX = 0;
let lastY = 0;

canvas.addEventListener('pointerdown', (event) => {
  dragging = true;
  lastX = event.clientX;
  lastY = event.clientY;
  canvas.classList.add('dragging');
  canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener('pointermove', (event) => {
  if (!dragging) return;
  renderer.panBy(event.clientX - lastX, event.clientY - lastY);
  lastX = event.clientX;
  lastY = event.clientY;
});

for (const type of ['pointerup', 'pointercancel'] as const) {
  canvas.addEventListener(type, () => {
    dragging = false;
    canvas.classList.remove('dragging');
  });
}

canvas.addEventListener('dblclick', () => renderer.resetView());

const zoomStep = (factor: number) => {
  // Anchored on the middle of the view, since there is no pointer involved.
  const rect = canvas.getBoundingClientRect();
  renderer.zoomAt(rect.width / 2, rect.height / 2, factor);
};
el<HTMLButtonElement>('zoomIn').onclick = () => zoomStep(1.5);
el<HTMLButtonElement>('zoomOut').onclick = () => zoomStep(1 / 1.5);
el<HTMLButtonElement>('zoomReset').onclick = () => renderer.resetView();

window.addEventListener('keydown', (event) => {
  // Arrows pan, plus and minus zoom, 0 fits. Skipped while typing in a field.
  const target = event.target as HTMLElement | null;
  if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
  const step = 40;
  if (event.key === 'ArrowLeft') return renderer.panBy(step, 0);
  if (event.key === 'ArrowRight') return renderer.panBy(-step, 0);
  if (event.key === 'ArrowUp') return renderer.panBy(0, step);
  if (event.key === 'ArrowDown') return renderer.panBy(0, -step);
  if (event.key === '+' || event.key === '=') return zoomStep(1.5);
  if (event.key === '-') return zoomStep(1 / 1.5);
  if (event.key === '0') return renderer.resetView();
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !docsPanel.classList.contains('hidden')) {
    closePanel();
    return;
  }
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
