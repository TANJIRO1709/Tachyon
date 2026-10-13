/**
 * Semantic correctness with the REAL embedder: does the cache match meaning,
 * or just strings? Needs the MiniLM weights (downloaded from the HuggingFace
 * Hub on first run, no key), so it only runs when asked:
 *
 *   npm run test:minilm
 *   npm run bench:sweep            # then pick CACHE_THRESHOLD from the table
 *
 * The assertions are about properties, not per-pair magic numbers: paraphrases
 * score far above different questions, far above what the lexical fallback
 * manages, unrelated questions never come close, and the production threshold
 * keeps the labelled "different" set out.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { loadSettings } from "../src/config.js";
import { HashEmbedder, MiniLMEmbedder, dot } from "../src/embedder.js";
import { DIFFERENT, PARAPHRASES } from "../src/labelledPairs.js";
import { SemanticCache } from "../src/semanticCache.js";

const enabled = process.env.MINILM === "1";
const UNRELATED = DIFFERENT.slice(-3);
const SAME_TEMPLATE = DIFFERENT.slice(0, -3);

async function sims(e: { embed(t: string[]): Promise<Float32Array[]> }, pairs: [string, string][]) {
  const a = await e.embed(pairs.map((p) => p[0]));
  const b = await e.embed(pairs.map((p) => p[1]));
  return a.map((v, i) => dot(v, b[i]!));
}
const median = (xs: number[]) => {
  const s = [...xs].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

describe.skipIf(!enabled)("semantic cache with MiniLM", () => {
  let embedder: MiniLMEmbedder;
  beforeAll(async () => {
    embedder = await MiniLMEmbedder.load(loadSettings().embedder_model);
  }, 120_000);

  it("scores paraphrases far above different questions", async () => {
    expect(median(await sims(embedder, PARAPHRASES))).toBeGreaterThan(median(await sims(embedder, DIFFERENT)) + 0.15);
  });

  it("beats the lexical fallback on paraphrases", async () => {
    const semantic = await sims(embedder, PARAPHRASES);
    const lexical = await sims(new HashEmbedder(384), PARAPHRASES);
    expect(mean(semantic)).toBeGreaterThan(mean(lexical) + 0.15);
    expect(Math.min(...semantic)).toBeGreaterThan(Math.min(...lexical));
  });

  it.each(UNRELATED)("never matches unrelated questions: %s / %s", async (a, b) => {
    const cache = new SemanticCache({ capacity: 8, dim: embedder.dim, ttlS: 60 });
    cache.put((await embedder.embed([a]))[0]!, a, "ANSWER");
    expect(cache.lookup((await embedder.embed([b]))[0]!, 0.6).kind).toBe("miss");
  });

  it.each(SAME_TEMPLATE)("keeps same-template, different-subject questions apart at the shipped threshold: %s / %s", async (a, b) => {
    const threshold = loadSettings().cache_threshold;
    const cache = new SemanticCache({ capacity: 8, dim: embedder.dim, ttlS: 60 });
    cache.put((await embedder.embed([a]))[0]!, a, "ANSWER");
    expect(cache.lookup((await embedder.embed([b]))[0]!, threshold).kind).toBe("miss");
  });
});
