import { downloadLogger, loadTransformers } from "./transformers.js";

export interface Embedder {
  readonly name: string;
  readonly dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

const STOPWORDS = new Set(
  `a an the is are was were be been being am do does did doing have has had
   of to in on at for from by with about into over under as than then so
   and or but if not no nor what which who whom whose when where why how
   i me my we our you your he him his she her it its they them their this
   that these those there here can could would should will shall may might
   must please tell explain describe give show let know define meaning
   some any all just also very really quite`.split(/\s+/),
);

function stem(tok: string): string {
  for (const suf of ["ing", "ies", "es", "ed", "s"]) {
    if (tok.length > suf.length + 2 && tok.endsWith(suf)) return tok.slice(0, -suf.length) + (suf === "ies" ? "y" : "");
  }
  return tok;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function normaliseInPlace(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i]! /= n;
  return v;
}

export class HashEmbedder implements Embedder {
  readonly name = "hash";
  constructor(readonly dim = 384) {}

  private add(v: Float32Array, feature: string, weight: number): void {
    const h = fnv1a(feature);
    // Signed hashing: the sign bit makes collisions cancel on average instead
    // of always adding similarity.
    const sign = fnv1a("s" + feature) & 1 ? 1 : -1;
    v[h % this.dim]! += sign * weight;
  }

  embedOne(text: string): Float32Array {
    const v = new Float32Array(this.dim);
    const raw = text.toLowerCase().replaceAll("'s", "");
    const tokens = (raw.match(/[a-z0-9]+/g) ?? []).map(stem);
    const content = tokens.filter((t) => !STOPWORDS.has(t));
    for (const tok of content.length ? content : tokens) {
      this.add(v, "w:" + tok, 1);
      const padded = `#${tok}#`;
      const grams = padded.length - 2;
      for (let i = 0; i < grams; i++) this.add(v, "c:" + padded.slice(i, i + 3), 0.5 / grams);
    }
    if (!v.some((x) => x !== 0)) this.add(v, "raw:" + text, 1); // empty / punctuation-only input
    return normaliseInPlace(v);
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.embedOne(t));
  }
}

type FeatureExtractor = (texts: string[], opts: { pooling: "mean"; normalize: boolean }) => Promise<{ data: Float32Array; dims: number[] }>;

export class MiniLMEmbedder implements Embedder {
  readonly name = "minilm";
  private constructor(private readonly extractor: FeatureExtractor, readonly dim: number, readonly model: string) {}

  static async load(model: string, log: (msg: string) => void = () => {}): Promise<MiniLMEmbedder> {
    const { pipeline } = await loadTransformers();
    const extractor = (await pipeline("feature-extraction", model, {
      dtype: "fp32",
      progress_callback: downloadLogger(model, log),
    })) as unknown as FeatureExtractor;
    const probe = await extractor(["warm up"], { pooling: "mean", normalize: true });
    return new MiniLMEmbedder(extractor, probe.dims.at(-1)!, model);
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!texts.length) return [];
    // ONNX Runtime runs the forward pass on its own native threads, so the
    // event loop keeps accepting and batching requests meanwhile.
    const out = await this.extractor(texts, { pooling: "mean", normalize: true });
    const d = out.dims.at(-1)!;
    return texts.map((_, i) => out.data.slice(i * d, (i + 1) * d));
  }
}

export async function buildEmbedder(
  kind: string,
  opts: { dim: number; model: string; log?: (msg: string) => void },
): Promise<Embedder> {
  if (kind === "minilm") return MiniLMEmbedder.load(opts.model, opts.log);
  if (kind === "hash") return new HashEmbedder(opts.dim);
  throw new RangeError(`unknown EMBEDDER '${kind}' (expected 'minilm' or 'hash')`);
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}
