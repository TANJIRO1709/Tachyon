/**
 * Offline threshold sweep over the hand-labelled pairs. For each threshold:
 * the share of true paraphrases that would hit (recall) and the share of
 * different questions that would wrongly hit (false positives). Pick the
 * highest recall whose false-positive rate you can live with.
 *
 *   npm run bench:sweep                 # MiniLM (downloads weights once)
 *   EMBEDDER=hash npm run bench:sweep   # the offline lexical fallback
 */
import { buildEmbedder, dot } from "../src/embedder.js";
import { loadSettings } from "../src/config.js";
import { DIFFERENT, PARAPHRASES } from "../src/labelledPairs.js";
import { save } from "./common.js";

const THRESHOLDS = [0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.88, 0.9, 0.92, 0.94, 0.96];
const s = loadSettings();
const emb = await buildEmbedder(s.embedder, { dim: s.embedding_dim, model: s.embedder_model });

async function sims(pairs: [string, string][]) {
  const a = await emb.embed(pairs.map((p) => p[0]));
  const b = await emb.embed(pairs.map((p) => p[1]));
  return a.map((v, i) => dot(v, b[i]!));
}
const pos = await sims(PARAPHRASES);
const neg = await sims(DIFFERENT);
const med = (xs: number[]) => { const t = [...xs].sort((x, y) => x - y); const m = t.length >> 1; return t.length % 2 ? t[m]! : (t[m - 1]! + t[m]!) / 2; };
const share = (xs: number[], t: number) => xs.filter((x) => x >= t).length / xs.length;
const rows = THRESHOLDS.map((t) => ({ threshold: t, paraphrase_hit_rate: share(pos, t), false_positive_rate: share(neg, t) }));

console.log(`embedder=${emb.name}  paraphrase pairs=${pos.length}  different pairs=${neg.length}`);
console.log(`paraphrase similarity: min ${Math.min(...pos).toFixed(3)}  median ${med(pos).toFixed(3)}`);
console.log(`different  similarity: max ${Math.max(...neg).toFixed(3)}  median ${med(neg).toFixed(3)}\n`);
console.log("| Threshold | Paraphrases that hit | Different questions that wrongly hit |\n| --- | --- | --- |");
for (const r of rows) console.log(`| ${r.threshold.toFixed(2)} | ${Math.round(r.paraphrase_hit_rate * 100)}% | ${Math.round(r.false_positive_rate * 100)}% |`);
console.log("\nHardest different pairs (highest similarity):");
for (const i of neg.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]).slice(0, 3).map((x) => x[1])) {
  console.log(`  ${neg[i]!.toFixed(3)}  "${DIFFERENT[i]![0]}" vs "${DIFFERENT[i]![1]}"`);
}
console.log("Hardest paraphrases (lowest similarity):");
for (const i of pos.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]).slice(0, 3).map((x) => x[1])) {
  console.log(`  ${pos[i]!.toFixed(3)}  "${PARAPHRASES[i]![0]}" vs "${PARAPHRASES[i]![1]}"`);
}
save(`threshold_sweep_${emb.name}.json`, { embedder: emb.name, rows, paraphrase_sims: pos, different_sims: neg });
