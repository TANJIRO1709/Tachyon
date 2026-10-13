/** Manually advanced clock (seconds), so TTL and cooldown tests never sleep. */
export class FakeClock {
  t = 1000;
  readonly fn = () => this.t;
  advance(s: number) {
    this.t += s;
  }
}

export function unit(components: number[], dim = 8): Float32Array {
  const v = new Float32Array(dim);
  components.forEach((c, i) => (v[i] = c));
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

/** A unit vector whose cosine similarity with `base` is exactly `sim`. */
export function atSimilarity(base: Float32Array, sim: number): Float32Array {
  const n = Math.hypot(...base);
  const b = base.map((x) => x / n);
  // Any direction orthogonal to b.
  let minI = 0;
  for (let i = 1; i < b.length; i++) if (Math.abs(b[i]!) < Math.abs(b[minI]!)) minI = i;
  const o = new Float32Array(b.length);
  o[minI] = 1;
  const proj = o.reduce((s, x, i) => s + x * b[i]!, 0);
  for (let i = 0; i < o.length; i++) o[i]! -= proj * b[i]!;
  const on = Math.hypot(...o);
  const k = Math.sqrt(Math.max(0, 1 - sim * sim));
  return b.map((x, i) => sim * x + k * (o[i]! / on));
}

export function seededRandom(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
