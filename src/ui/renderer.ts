import { MAP_HEIGHT, MAP_WIDTH, NEST_RADIUS, UNIT_STATS } from '../sim/config.js';
import type { Simulation } from '../sim/sim.js';
import type { ColonyId, Unit } from '../sim/types.js';
import { generateSoil } from './soil.js';

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
  /**
   * Cached soil. A deliberate exception to this class being a pure projection:
   * regenerating it per frame would make the ground crawl. Invalidated in
   * resize(), since scale and device pixel ratio change there.
   */
  private soil: HTMLCanvasElement | null = null;
  private soilSeed = 1;

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
    this.soil = null;
  }

  /**
   * Build the soil once, at map resolution rather than screen resolution, so it
   * scales with zoom instead of being regenerated. Deterministic from the match
   * seed, so a replay looks the same as the original.
   */
  private buildSoil(): HTMLCanvasElement {
    const size = Math.max(1, Math.round(MAP_WIDTH * this.baseScale));
    const tile = document.createElement('canvas');
    tile.width = size;
    tile.height = size;
    const tctx = tile.getContext('2d')!;
    const image = tctx.createImageData(size, size);
    image.data.set(generateSoil(size, this.soilSeed));
    tctx.putImageData(image, 0, 0);
    return tile;
  }

  /** Set by the viewer so the ground is stable per match. */
  setSoilSeed(seed: number): void {
    if (seed === this.soilSeed) return;
    this.soilSeed = seed;
    this.soil = null;
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

    // Soil, blitted from the cached tile and stretched by the current zoom.
    if (!this.soil) this.soil = this.buildSoil();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.soil, 0, 0, MAP_WIDTH * s, MAP_HEIGHT * s);

    // The grid keeps its job of giving a sense of distance, but at 4% white over
    // soil it read like a cutting mat, so it is now sparse and much fainter.
    ctx.strokeStyle = 'rgba(200,180,140,0.035)';
    ctx.lineWidth = 1;
    for (let i = 25; i < MAP_WIDTH; i += 25) {
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

    // Nests, drawn as holes in the earth: a dark mouth with a raised spoil rim.
    // Units are drawn after this, so an ant standing at the centre paints over
    // the hole; the rim is then drawn again on top at the end, which is what
    // makes an ant at the mouth read as descending into it.
    const nestsToDraw: Array<{ x: number; y: number; owner: ColonyId }> = [];
    for (const colony of sim.colonies) {
      const nests =
        options.fogView === -1 || colony.id === options.fogView
          ? colony.nests
          : sim.believedEnemyNests(options.fogView).map((known) => ({ x: known.x, y: known.y }));
      for (const nest of nests) {
        nestsToDraw.push({ x: nest.x, y: nest.y, owner: colony.id });
        this.drawNestHole(nest.x, nest.y, colony.id);
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

    // The rim again, over the units, so an ant at the mouth is half swallowed.
    for (const nest of nestsToDraw) this.drawNestRim(nest.x, nest.y, nest.owner);

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

  /**
   * An ant, pointing where it is going.
   *
   * Three segments along the heading, abdomen at the back and head at the front,
   * because a body with a front and a back is what makes a direction readable.
   * At the whole-map view this is a few pixels and reads as a dot, which is fine;
   * it is drawn for the zoomed view, where a worker is about 42px.
   */
  private drawUnit(unit: Unit): void {
    const { ctx } = this;
    const s = this.scale;
    const health = unit.hp / unit.maxHp;
    const colour = health > 0.45 ? COLONY_COLOURS[unit.owner] : COLONY_DIM[unit.owner];

    ctx.save();
    ctx.translate(unit.x * s, unit.y * s);
    ctx.rotate(unit.heading);
    ctx.fillStyle = colour;

    if (unit.type === 'queen') {
      // Long abdomen, which is what makes a queen a queen.
      this.segment(2.6 * s, 0, 1.5 * s);
      this.segment(0.2 * s, 0, 1.0 * s);
      this.segment(-1.3 * s, 0, 0.85 * s);
      ctx.strokeStyle = unit.foundingSite === null ? '#12100e' : '#eee6d8';
      ctx.lineWidth = Math.max(1, s * 0.18);
      ctx.beginPath();
      ctx.arc(2.6 * s, 0, 1.5 * s, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      return;
    }

    if (unit.type === 'soldier') {
      this.segment(0.85 * s, 0, 0.62 * s);
      this.segment(-0.15 * s, 0, 0.5 * s);
      // Mandibles: a wedge at the front, so a soldier reads as armed and the
      // triangle finally points where it is actually going.
      ctx.beginPath();
      ctx.moveTo(-1.5 * s, 0);
      ctx.lineTo(-0.3 * s, 0.62 * s);
      ctx.lineTo(-0.3 * s, -0.62 * s);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      return;
    }

    // Worker.
    this.segment(0.62 * s, 0, 0.42 * s);
    this.segment(-0.05 * s, 0, 0.32 * s);
    this.segment(-0.6 * s, 0, 0.26 * s);
    if (unit.carrying > 0) {
      // The load, carried out front where an ant would hold it.
      ctx.fillStyle = '#6fbf5a';
      ctx.beginPath();
      ctx.arc(1.15 * s, 0, 0.3 * s, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * The mouth of a nest: a dark hole with a spoil rim in the colony's colour.
   * Drawn before units so they paint over it, then the rim is repeated on top.
   */
  private drawNestHole(x: number, y: number, owner: ColonyId): void {
    const { ctx } = this;
    const s = this.scale;
    const r = NEST_RADIUS * s;

    // Spoil heap: slightly lighter than soil, spread wider than the mouth.
    const spoil = ctx.createRadialGradient(x * s, y * s, r * 0.7, x * s, y * s, r * 1.5);
    spoil.addColorStop(0, 'rgba(64, 52, 38, 0.85)');
    spoil.addColorStop(1, 'rgba(64, 52, 38, 0)');
    ctx.fillStyle = spoil;
    ctx.beginPath();
    ctx.arc(x * s, y * s, r * 1.5, 0, Math.PI * 2);
    ctx.fill();

    // The hole itself, darker than any ground so it reads as depth.
    const mouth = ctx.createRadialGradient(x * s, y * s, 0, x * s, y * s, r);
    mouth.addColorStop(0, '#000000');
    mouth.addColorStop(0.75, '#05040300');
    mouth.addColorStop(0.75, 'rgba(6, 5, 4, 0.95)');
    mouth.addColorStop(1, 'rgba(20, 16, 12, 0.4)');
    ctx.fillStyle = mouth;
    ctx.beginPath();
    ctx.arc(x * s, y * s, r, 0, Math.PI * 2);
    ctx.fill();
  }

  /**
   * The near lip of the mouth, drawn after units. Only the lower arc, so an ant
   * on the far side is occluded and one on the near side is not: that asymmetry
   * is what sells descending rather than standing on a dark circle.
   */
  private drawNestRim(x: number, y: number, owner: ColonyId): void {
    const { ctx } = this;
    const s = this.scale;
    const r = NEST_RADIUS * s;
    ctx.strokeStyle = COLONY_COLOURS[owner];
    ctx.lineWidth = Math.max(1, s * 0.35);
    ctx.beginPath();
    ctx.arc(x * s, y * s, r, 0, Math.PI, false);
    ctx.stroke();

    // A thin full ring so the nest is still findable at the whole-map view,
    // where the arc alone is only a couple of pixels.
    ctx.lineWidth = Math.max(1, s * 0.12);
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.arc(x * s, y * s, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /** One body segment, in the unit's local rotated frame. */
  private segment(x: number, y: number, radius: number): void {
    const { ctx } = this;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0.6, radius), 0, Math.PI * 2);
    ctx.fill();
  }
}

export function colonyColour(id: ColonyId): string {
  return COLONY_COLOURS[id];
}

export { UNIT_STATS };
