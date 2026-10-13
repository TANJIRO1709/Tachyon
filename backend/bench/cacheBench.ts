/**
 * Live semantic-cache benchmark with a correctness check.
 *
 * A pool of topics, each asked through several phrasings, with Zipf-skewed
 * popularity like real query logs. Every response carries the text that first
 * produced it (`output.echo`), so each hit can be judged: did the user get the
 * answer to THEIR topic (correct) or a different one (a false positive)? A hit
 * rate without that number is meaningless.
 *
 *   npm run bench:cache -- --url http://localhost:8000 --threshold 0.92
 */
import { api, arg, percentile, save, seeded } from "./common.js";

const SUBJECTS = [
  "capital of France", "capital of Germany", "capital of Japan", "capital of Brazil",
  "boiling point of water", "freezing point of water", "speed of light", "speed of sound",
  "height of Mount Everest", "height of the Eiffel Tower", "author of Pride and Prejudice",
  "author of War and Peace", "time zone of Tokyo", "time zone of London",
  "meaning of HTTP 404", "meaning of HTTP 500", "population of India", "population of Canada",
  "inventor of the telephone", "inventor of the light bulb", "largest planet in the solar system",
  "smallest planet in the solar system", "chemical formula of water", "chemical formula of salt",
  "distance from Earth to the Moon", "distance from Earth to the Sun", "founder of Microsoft",
  "founder of Amazon", "tallest animal", "fastest land animal",
];
const TEMPLATES = [
  "What is the {s}?", "Tell me the {s}", "{s}?", "Can you explain the {s} please",
  "What's the {s}", "I would like to know the {s}", "Give me the {s}",
];

const url = arg("url", "http://localhost:8000");
const total = Number(arg("requests", "1500"));
const concurrency = Number(arg("concurrency", "16"));
const thresholdArg = arg("threshold", "");
const zipf = Number(arg("zipf", "1.1"));

const rand = seeded(42);
const weights = SUBJECTS.map((_, r) => 1 / (r + 1) ** zipf);
const wsum = weights.reduce((a, b) => a + b, 0);
const pickTopic = () => {
  let x = rand() * wsum;
  for (let i = 0; i < weights.length; i++) if ((x -= weights[i]!) <= 0) return i;
  return weights.length - 1;
};
const queue = Array.from({ length: total }, () => {
  const t = pickTopic();
  return { topic: t, text: TEMPLATES[Math.floor(rand() * TEMPLATES.length)]!.replace("{s}", SUBJECTS[t]!) };
});

const stats0 = await api(`${url}/v1/stats`);
const original = { cache_enabled: stats0.config.cache_enabled, cache_threshold: stats0.config.cache_threshold, batching_enabled: stats0.config.batching_enabled };
const patch: Record<string, unknown> = { cache_enabled: true, batching_enabled: true };
if (thresholdArg) patch.cache_threshold = Number(thresholdArg);
await api(`${url}/v1/admin/config`, { method: "PATCH", body: JSON.stringify(patch) });
await fetch(`${url}/v1/admin/cache`, { method: "DELETE" });
await fetch(`${url}/v1/admin/circuit/reset`, { method: "POST" });
const threshold = (await api(`${url}/v1/stats`)).config.cache_threshold as number;

type Row = { topic: number; text: string; status: number; ms: number; cached?: boolean; similarity?: number; echo?: string; matched?: string };
const rows: Row[] = [];
const originTopic = new Map<string, number>(); // text that first produced an answer -> its topic
let idx = 0;
const t0 = performance.now();
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (idx < queue.length) {
    const { topic, text } = queue[idx++]!;
    const s = performance.now();
    const r = await fetch(`${url}/v1/infer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: text }) });
    const b: any = await r.json();
    const ms = performance.now() - s;
    if (r.status !== 200) { rows.push({ topic, text, status: r.status, ms }); continue; }
    const echo = b.output.echo as string;
    if (!b.cached && !originTopic.has(echo)) originTopic.set(echo, topic);
    rows.push({ topic, text, status: 200, ms, cached: b.cached, similarity: b.similarity, echo, matched: b.matched_query });
  }
}));
const elapsed = (performance.now() - t0) / 1000;
const server = await api(`${url}/v1/stats`);
await api(`${url}/v1/admin/config`, { method: "PATCH", body: JSON.stringify(original) });

const ok = rows.filter((r) => r.status === 200);
const hits = ok.filter((r) => r.cached);
const misses = ok.filter((r) => !r.cached);
const wrong = hits.filter((h) => (originTopic.get(h.echo!) ?? h.topic) !== h.topic);
const r2 = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);
const result = {
  threshold, embedder: server.embedder, requests: rows.length, topics: SUBJECTS.length, phrasings_per_topic: TEMPLATES.length,
  hit_rate: ok.length ? Math.round((hits.length / ok.length) * 10_000) / 10_000 : 0,
  wrong_answer_rate_of_hits: hits.length ? Math.round((wrong.length / hits.length) * 10_000) / 10_000 : 0,
  wrong_answers: wrong.length,
  avg_hit_similarity: hits.length ? Math.round((hits.reduce((a, h) => a + h.similarity!, 0) / hits.length) * 10_000) / 10_000 : null,
  model_calls: misses.length,
  inference_calls_saved: hits.length,
  client_hit_latency_ms: { p50: r2(percentile(hits.map((h) => h.ms), 50)), p99: r2(percentile(hits.map((h) => h.ms), 99)) },
  client_miss_latency_ms: { p50: r2(percentile(misses.map((h) => h.ms), 50)), p99: r2(percentile(misses.map((h) => h.ms), 99)) },
  server_cache_hit_latency_ms: server.latency.total_cache_hits,
  server_model_path_latency_ms: server.latency.total_model_path,
  throughput_rps: Math.round((ok.length / elapsed) * 10) / 10,
  wrong_examples: wrong.slice(0, 5).map((w) => ({ asked: w.text, served_answer_for: w.matched, similarity: w.similarity })),
  hit_examples: hits.filter((h) => h.text !== h.matched).slice(0, 5).map((h) => ({ asked: h.text, matched: h.matched, similarity: h.similarity })),
};
save(`cache_${result.embedder}_${threshold.toFixed(2)}.json`, result);
console.log(JSON.stringify(result, null, 2));
