/**
 * Ground texture generation, kept pure and free of the canvas so the contrast
 * constraint can be asserted in the self test rather than checked by eye.
 *
 * Everything on screen is small and several things are dim: hurt units drop to
 * #7a5418 and #1d5c6e, and corpses are brown, the closest thing on screen to
 * soil and so the easiest to lose. The constraint is therefore a luminance
 * ceiling, not a look.
 */

/** Mean relative luminance the ground must not exceed. */
export const GROUND_LUMINANCE_CEILING = 0.006;
/** Contrast every unit colour must keep against the ground. */
export const GROUND_MIN_CONTRAST = 2.5;

const SOIL_BASE = { r: 15, g: 12, b: 9 };
const SOIL_GRAIN = 7;
const SOIL_GRIT_DENSITY = 0.0014;

/** Colours drawn on top of the ground, which all have to stay legible. */
export const UNIT_COLOURS: Record<string, string> = {
  'colony A healthy': '#f0a83c',
  'colony B healthy': '#45b8d8',
  'colony A hurt': '#7a5418',
  'colony B hurt': '#1d5c6e',
  corpse: '#7a6a52',
  food: '#6fbf5a',
};

function channelToLinear(value: number): number {
  const v = value / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * channelToLinear(r) + 0.7152 * channelToLinear(g) + 0.0722 * channelToLinear(b);
}

export function contrastRatio(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function hexToRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/**
 * RGBA pixels for a square of soil. Deterministic from the seed, so a match
 * replayed looks like the original rather than being reshuffled.
 */
export function generateSoil(size: number, seed: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(size * size * 4);

  let state = seed >>> 0;
  const rand = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  for (let i = 0; i < size * size; i++) {
    const x = i % size;
    const y = (i / size) | 0;
    // A broad tonal wash plus per-pixel grain. Two octaves of value noise would
    // look better but costs more than it is worth at this luminance.
    const wash = Math.sin(x * 0.013) * Math.cos(y * 0.011) * 2.5;
    const grain = (rand() - 0.5) * SOIL_GRAIN;
    const n = wash + grain;
    data[i * 4] = Math.max(0, SOIL_BASE.r + n * 1.1);
    data[i * 4 + 1] = Math.max(0, SOIL_BASE.g + n * 0.85);
    data[i * 4 + 2] = Math.max(0, SOIL_BASE.b + n * 0.6);
    data[i * 4 + 3] = 255;
  }

  // Sparse grit, only slightly lighter than the ground it sits on.
  const grits = Math.round(size * size * SOIL_GRIT_DENSITY);
  for (let i = 0; i < grits; i++) {
    const gx = Math.floor(rand() * size);
    const gy = Math.floor(rand() * size);
    const index = (gy * size + gx) * 4;
    data[index] = Math.min(255, data[index] + 16);
    data[index + 1] = Math.min(255, data[index + 1] + 13);
    data[index + 2] = Math.min(255, data[index + 2] + 9);
  }

  return data;
}

export interface GroundStats {
  mean: number;
  p99: number;
  peak: number;
}

export function groundLuminanceStats(data: Uint8ClampedArray): GroundStats {
  const values: number[] = [];
  for (let i = 0; i < data.length; i += 4) values.push(relativeLuminance(data[i], data[i + 1], data[i + 2]));
  values.sort((a, b) => a - b);
  return {
    mean: values.reduce((sum, v) => sum + v, 0) / values.length,
    p99: values[Math.floor(values.length * 0.99)],
    peak: values[values.length - 1],
  };
}
