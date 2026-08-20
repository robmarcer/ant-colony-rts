import { MAP_HEIGHT, MAP_WIDTH, NEST_RADIUS, UNIT_STATS } from '../sim/config.js';
import type { Simulation } from '../sim/sim.js';
import type { ColonyId, Unit } from '../sim/types.js';

const COLONY_COLOURS: [string, string] = ['#f0a83c', '#45b8d8'];
const COLONY_DIM: [string, string] = ['#7a5418', '#1d5c6e'];

export interface RenderOptions {
  showIntel: boolean;
}

/** Top down canvas view. Purely a projection of sim state, holds no state itself. */
export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private scale = 1;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    this.ctx = ctx;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const size = this.canvas.clientWidth || 720;
    this.canvas.width = Math.round(size * dpr);
    this.canvas.height = Math.round(size * dpr);
    this.scale = (size * dpr) / MAP_WIDTH;
  }

  draw(sim: Simulation, options: RenderOptions): void {
    const { ctx } = this;
    const s = this.scale;
    if (Math.abs(this.canvas.clientWidth * (window.devicePixelRatio || 1) - this.canvas.width) > 2) this.resize();

    ctx.fillStyle = '#0d0b09';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Faint grid, one line every 10 cells, to give a sense of distance.
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    for (let i = 10; i < MAP_WIDTH; i += 10) {
      ctx.beginPath();
      ctx.moveTo(i * s, 0);
      ctx.lineTo(i * s, MAP_HEIGHT * s);
      ctx.moveTo(0, i * s);
      ctx.lineTo(MAP_WIDTH * s, i * s);
      ctx.stroke();
    }

    if (options.showIntel) this.drawIntel(sim);

    // Food and corpses.
    for (const source of sim.food.values()) {
      const radius = Math.max(1.2, Math.sqrt(Math.max(source.amount, 1)) * 0.16) * s;
      if (source.kind === 'corpse') {
        ctx.fillStyle = '#7a6a52';
        ctx.fillRect(source.x * s - radius * 0.6, source.y * s - radius * 0.6, radius * 1.2, radius * 1.2);
      } else {
        const depletion = source.amount / source.initialAmount;
        ctx.fillStyle = `rgba(111, 191, 90, ${0.35 + 0.55 * depletion})`;
        ctx.beginPath();
        ctx.arc(source.x * s, source.y * s, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Nests. A colony can have several once it has produced more queens.
    for (const colony of sim.colonies) {
      ctx.strokeStyle = COLONY_COLOURS[colony.id];
      ctx.fillStyle = 'rgba(255,255,255,0.04)';
      ctx.lineWidth = Math.max(1, s * 0.25);
      for (const nest of colony.nests) {
        ctx.beginPath();
        ctx.arc(nest.x * s, nest.y * s, NEST_RADIUS * s, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }

    // Queens still walking to a site, with a dashed line to where they are going.
    ctx.setLineDash([3, 3]);
    for (const unit of sim.units.values()) {
      if (unit.type !== 'queen' || unit.foundingSite === null) continue;
      ctx.strokeStyle = COLONY_COLOURS[unit.owner];
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(unit.x * s, unit.y * s);
      ctx.lineTo(unit.foundingSite.x * s, unit.foundingSite.y * s);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(unit.foundingSite.x * s, unit.foundingSite.y * s, NEST_RADIUS * s, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    for (const unit of sim.units.values()) this.drawUnit(unit);
  }

  /**
   * Draws each colony's shared food memory as spokes from the nest. This is the
   * colony intel mechanic made visible: what the colony knows, not what exists.
   */
  private drawIntel(sim: Simulation): void {
    const { ctx } = this;
    const s = this.scale;
    ctx.lineWidth = 1;
    for (const colony of sim.colonies) {
      ctx.strokeStyle = colony.id === 0 ? 'rgba(240,168,60,0.16)' : 'rgba(69,184,216,0.16)';
      for (const known of colony.knownFood.values()) {
        // Drawn from the nest that is actually closest, which is also the one
        // workers will haul to.
        let from = colony.nests[0];
        let bestDist = Infinity;
        for (const nest of colony.nests) {
          const d = Math.hypot(nest.x - known.x, nest.y - known.y);
          if (d < bestDist) {
            bestDist = d;
            from = nest;
          }
        }
        if (!from) continue;
        ctx.beginPath();
        ctx.moveTo(from.x * s, from.y * s);
        ctx.lineTo(known.x * s, known.y * s);
        ctx.stroke();
      }
    }
  }

  private drawUnit(unit: Unit): void {
    const { ctx } = this;
    const s = this.scale;
    const x = unit.x * s;
    const y = unit.y * s;
    const health = unit.hp / unit.maxHp;
    const colour = health > 0.45 ? COLONY_COLOURS[unit.owner] : COLONY_DIM[unit.owner];
    ctx.fillStyle = colour;

    if (unit.type === 'queen') {
      const r = s * 2.4;
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const angle = (i / 6) * Math.PI * 2 - Math.PI / 2;
        const px = x + Math.cos(angle) * r;
        const py = y + Math.sin(angle) * r;
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      // A founding queen gets a pale outline so she reads as in transit.
      ctx.strokeStyle = unit.foundingSite === null ? '#12100e' : '#eee6d8';
      ctx.lineWidth = Math.max(1, s * 0.25);
      ctx.stroke();
      return;
    }

    if (unit.type === 'soldier') {
      const r = s * 1.25;
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r * 0.9, y + r * 0.8);
      ctx.lineTo(x - r * 0.9, y + r * 0.8);
      ctx.closePath();
      ctx.fill();
      return;
    }

    const r = s * 0.72;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    // A loaded worker gets a green pip, so hauling is visible at a glance.
    if (unit.carrying > 0) {
      ctx.fillStyle = '#6fbf5a';
      ctx.beginPath();
      ctx.arc(x, y, r * 0.45, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

export function colonyColour(id: ColonyId): string {
  return COLONY_COLOURS[id];
}

export { UNIT_STATS };
