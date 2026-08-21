import { MAP_HEIGHT, MAP_WIDTH, NEST_RADIUS, UNIT_STATS } from '../sim/config.js';
import type { Simulation } from '../sim/sim.js';
import type { ColonyId, Unit } from '../sim/types.js';

const COLONY_COLOURS: [string, string] = ['#f0a83c', '#45b8d8'];
const COLONY_DIM: [string, string] = ['#7a5418', '#1d5c6e'];

export interface RenderOptions {
  showIntel: boolean;
  /**
   * Draw the world as this colony believes it to be: its own units and nests,
   * the food it has found, and remembered enemy positions as ghosts. -1 draws
   * everything, which is what an observer sees.
   */
  fogView: -1 | 0 | 1;
}

/** Zoom limits. 1 fits the whole map, which is the default and the old view. */
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;

/**
 * Top down canvas view.
 *
 * Almost a pure projection of sim state, with one deliberate exception: it holds
 * the view transform, because zoom and pan are properties of how you are looking
 * rather than of the match. `resize()` recomputes the base scale, so the
 * transform has to be re-clamped there.
 */
export class Renderer {
  private ctx: CanvasRenderingContext2D;
  /** Device pixels per world cell at zoom 1, so the whole map fits. */
  private baseScale = 1;
  /** Device pixels per world cell as currently viewed. */
  private scale = 1;
  private zoom = 1;
  /** World coordinate at the top left of the view. */
  private panX = 0;
  private panY = 0;

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
    this.baseScale = (size * dpr) / MAP_WIDTH;
    this.applyZoom(this.zoom);
  }

  /** How many world cells fit across the view at the current zoom. */
  private visibleCells(): number {
    return this.canvas.width / this.scale;
  }

  /**
   * Pan is clamped so the map always fills the view. At zoom 1 that pins it to
   * the origin, which is why the default view is pixel-identical to before zoom
   * existed, and at any zoom it means the map cannot be lost off screen.
   */
  private clampPan(): void {
    const span = Math.max(0, MAP_WIDTH - this.visibleCells());
    this.panX = Math.min(span, Math.max(0, this.panX));
    this.panY = Math.min(span, Math.max(0, this.panY));
  }

  private applyZoom(zoom: number): void {
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    this.scale = this.baseScale * this.zoom;
    this.clampPan();
  }

  /**
   * Zoom keeping the world point under the cursor where it is. Zooming to the
   * centre of the map while looking at a corner is worse than not zooming.
   * Coordinates are CSS pixels relative to the canvas.
   */
  zoomAt(cssX: number, cssY: number, factor: number): void {
    const dpr = window.devicePixelRatio || 1;
    const px = cssX * dpr;
    const py = cssY * dpr;
    const worldX = this.panX + px / this.scale;
    const worldY = this.panY + py / this.scale;

    this.applyZoom(this.zoom * factor);

    this.panX = worldX - px / this.scale;
    this.panY = worldY - py / this.scale;
    this.clampPan();
  }

  /** Drag the view by a distance in CSS pixels. */
  panBy(cssDx: number, cssDy: number): void {
    const dpr = window.devicePixelRatio || 1;
    this.panX -= (cssDx * dpr) / this.scale;
    this.panY -= (cssDy * dpr) / this.scale;
    this.clampPan();
  }

  resetView(): void {
    this.panX = 0;
    this.panY = 0;
    this.applyZoom(1);
  }

  /** For the HUD, and for tests that need to assert what is on screen. */
  getView(): { zoom: number; panX: number; panY: number; pixelsPerCell: number } {
    const dpr = window.devicePixelRatio || 1;
    return { zoom: this.zoom, panX: this.panX, panY: this.panY, pixelsPerCell: this.scale / dpr };
  }

  draw(sim: Simulation, options: RenderOptions): void {
    const { ctx } = this;
    const s = this.scale;
    if (Math.abs(this.canvas.clientWidth * (window.devicePixelRatio || 1) - this.canvas.width) > 2) this.resize();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0d0b09';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Everything below draws in world coordinates times scale, so panning is a
    // single translate rather than an offset threaded through every call. That
    // also keeps the fog ghosts, intel spokes and founding-queen paths aligned
    // for free, which is the part most likely to drift if done piecemeal.
    ctx.save();
    ctx.translate(-this.panX * this.scale, -this.panY * this.scale);

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

    // Food and corpses. Under fog, only what the viewing colony has found.
    const visibleFood =
      options.fogView === -1
        ? [...sim.food.values()]
        : [...sim.colonies[options.fogView].knownFood.values()]
            .map((known) => sim.food.get(known.foodId))
            .filter((source): source is NonNullable<typeof source> => !!source);
    for (const source of visibleFood) {
      const radius = Math.max(1.2, Math.sqrt(Math.max(source.amount, 1)) * 0.16) * s;
      if (source.kind === 'corpse') {
        ctx.fillStyle = '#7a6a52';
        ctx.fillRect(source.x * s - radius * 0.6, source.y * s - radius * 0.6, radius * 1.2, radius * 1.2);
      } else {
        const depletion = source.amount / source.initialAmount;
        // Tinted by type so density is visible: dull for leaf litter, green for
        // seeds, amber for honeydew.
        const tint =
          source.type === 'honeydew' ? '214, 176, 74' : source.type === 'leaf_litter' ? '104, 122, 74' : '111, 191, 90';
        ctx.fillStyle = `rgba(${tint}, ${0.35 + 0.55 * depletion})`;
        ctx.beginPath();
        ctx.arc(source.x * s, source.y * s, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Nests. A colony can have several once it has produced more queens.
    for (const colony of sim.colonies) {
      // Under fog, their nests are only the ones the viewer knows about.
      const nests =
        options.fogView === -1 || colony.id === options.fogView
          ? colony.nests
          : sim.believedEnemyNests(options.fogView).map((known) => ({ ...known, x: known.x, y: known.y }));
      ctx.strokeStyle = COLONY_COLOURS[colony.id];
      ctx.fillStyle = 'rgba(255,255,255,0.04)';
      ctx.lineWidth = Math.max(1, s * 0.25);
      for (const nest of nests) {
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

    if (options.fogView === -1) {
      for (const unit of sim.units.values()) this.drawUnit(unit);
    } else {
      const viewer = options.fogView;
      for (const unit of sim.units.values()) {
        if (unit.owner === viewer) this.drawUnit(unit);
      }
      // Remembered enemies, drawn hollow and faded by how stale the memory is.
      for (const belief of sim.believedEnemies(viewer)) {
        const age = (sim.tick - belief.lastSeenTick) / 10;
        this.drawGhost(belief.x, belief.y, belief.type, viewer === 0 ? 1 : 0, age);
      }
    }

    ctx.restore();
  }

  /**
   * A remembered enemy. Hollow, because it is a belief rather than a sighting,
   * and fading with age so stale intelligence looks stale.
   */
  private drawGhost(x: number, y: number, type: string, owner: number, ageSeconds: number): void {
    const { ctx } = this;
    const s = this.scale;
    const fade = Math.max(0.15, 1 - ageSeconds / 120);
    ctx.strokeStyle = owner === 0 ? `rgba(240,168,60,${fade})` : `rgba(69,184,216,${fade})`;
    ctx.lineWidth = 1;
    const r = (type === 'queen' ? 2.4 : type === 'soldier' ? 1.25 : 0.72) * s;
    ctx.beginPath();
    ctx.arc(x * s, y * s, r, 0, Math.PI * 2);
    ctx.stroke();
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
