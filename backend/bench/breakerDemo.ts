/**
 * Circuit breaker under steady traffic: inject an outage, watch it trip, serve
 * from cache, probe, and recover. Prints a per-second timeline of what clients
 * received and the transition log the server wrote.
 *
 *   npm run bench:breaker -- --url http://localhost:8000
 */
import { api, arg, expovariate, save, seeded } from "./common.js";

const url = arg("url", "http://localhost:8000");
const rps = Number(arg("rps", "30"));
const rand = seeded(3);
const QUESTIONS = [
  "capital of France", "speed of light", "boiling point of water", "height of Mount Everest",
  "author of Pride and Prejudice", "time zone of Tokyo", "population of India", "largest planet",
].map((s) => `What is the ${s}?`);
/** Genuinely distinct content words each time, so nothing cached is similar.
 *  (Varying only a number would make every novel question a near-duplicate.) */
const novel = () => {
  const w = () => Array.from({ length: 3 }, () => "bcdfghjklmnprstvz"[Math.floor(rand() * 17)]! + "aeiou"[Math.floor(rand() * 5)]!).join("");
  return `how does the ${w()} ${w()} work`;
};

const orig = (await api(`${url}/v1/stats`)).config;
await api(`${url}/v1/admin/config`, { method: "PATCH", body: JSON.stringify({
  cache_enabled: true, batching_enabled: true, breaker_cooldown_s: 4, breaker_failure_threshold: 5,
  breaker_probe_limit: 3, breaker_probe_success_required: 3,
}) });
await fetch(`${url}/v1/admin/cache`, { method: "DELETE" });
await fetch(`${url}/v1/admin/circuit/reset`, { method: "POST" });
const seq0 = (await api(`${url}/v1/stats`)).log_seq;
// Warm the cache with the popular questions.
await Promise.all(QUESTIONS.map((q) => api(`${url}/v1/infer`, { method: "POST", body: JSON.stringify({ input: q }) })));

const timeline = new Map<number, Record<string, number>>();
const start = performance.now();
const events = new Map<number, [string, string]>([[3, ["error", "backend starts failing"]], [12, ["none", "backend recovers"]]]);
const tasks: Promise<void>[] = [];
let next = start;
while (performance.now() - start < 20_000) {
  const sec = Math.floor((performance.now() - start) / 1000);
  const ev = events.get(sec);
  if (ev) {
    events.delete(sec);
    await fetch(`${url}/v1/admin/backend/fault`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: ev[0] }) });
    console.log(`  t=${String(sec).padStart(2)}s  >>> ${ev[1]}`);
  }
  const d = next - performance.now();
  if (d > 0) await new Promise((r) => setTimeout(r, d));
  const s = Math.floor((performance.now() - start) / 1000);
  // 60% popular (cacheable), 40% never seen before.
  const text = rand() < 0.6 ? QUESTIONS[Math.floor(rand() * QUESTIONS.length)]! : novel();
  tasks.push((async () => {
    const r = await fetch(`${url}/v1/infer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: text }) });
    const b: any = await r.json();
    const kind = r.status === 200 ? ({ model: "model", cache: "cache", degraded_cache: "degraded" } as Record<string, string>)[b.source]! : b.error.code;
    const row = timeline.get(s) ?? {};
    row[kind] = (row[kind] ?? 0) + 1;
    timeline.set(s, row);
  })());
  next += expovariate(rand, rps);
}
await Promise.all(tasks);
const logs = (await api(`${url}/v1/logs/recent?after_seq=${seq0}&event=circuit_transition&limit=50`)).logs;
await api(`${url}/v1/admin/config`, { method: "PATCH", body: JSON.stringify({
  cache_enabled: orig.cache_enabled, breaker_cooldown_s: orig.breaker_cooldown_s, breaker_failure_threshold: orig.breaker_failure_threshold,
  breaker_probe_limit: orig.breaker_probe_limit, breaker_probe_success_required: orig.breaker_probe_success_required,
}) });

const cols = ["model", "cache", "degraded", "MODEL_ERROR", "CIRCUIT_OPEN"];
console.log(`\n| Second | ${cols.join(" | ")} |\n| --- | ${cols.map(() => "---").join(" | ")} |`);
for (const s of [...timeline.keys()].sort((a, b) => a - b)) console.log(`| ${s} | ${cols.map((c) => timeline.get(s)![c] ?? 0).join(" | ")} |`);
console.log("\nTransition log:");
for (const l of logs) console.log(`  ${l.ts}  ${String(l.from_state).padStart(9)} -> ${String(l.to_state).padEnd(9)}  ${l.reason}`);
save("breaker_demo.json", { timeline: Object.fromEntries(timeline), transitions: logs });
