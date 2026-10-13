/**
 * Load test: batched vs unbatched serving, measured the same way.
 *
 * closed loop  N clients, each sends its next request as soon as the last one
 *              returns. Measures maximum THROUGHPUT at a concurrency level.
 * open loop    requests arrive on a Poisson schedule at a fixed rate whatever
 *              the server is doing: how real traffic behaves, and the honest
 *              test of LATENCY UNDER LOAD, since an overloaded server cannot
 *              push back on arrivals.
 *
 * Each run toggles batching through the admin API on the same live server, with
 * the cache disabled and a unique input per request, so every request reaches
 * the model and the only variable is batching.
 *
 *   npm run bench:load -- --url http://localhost:8000
 */
import os from "node:os";
import { randomUUID } from "node:crypto";
import { api, arg, expovariate, percentile, save, seeded } from "./common.js";

type Result = {
  load: "closed" | "open"; mode: "batched" | "unbatched"; level: number; duration_s: number; completed: number;
  errors: Record<string, number>; throughput_rps: number; p50_ms: number | null; p95_ms: number | null; p99_ms: number | null;
  mean_ms: number | null; mean_batch_size: number | null; model_calls: number;
};

const url = arg("url", "http://localhost:8000");
const durationS = Number(arg("duration", "8"));
const concurrency = arg("concurrency", "1,4,16,64").split(",").filter(Boolean).map(Number);
const rates = arg("rates", "10,40,100").split(",").filter(Boolean).map(Number);

async function one(lat: number[], errors: Record<string, number>) {
  const t0 = performance.now();
  try {
    const r = await fetch(`${url}/v1/infer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: `benchmark request ${randomUUID()}`, options: { max_wait_ms: 60_000 } }),
    });
    const body: any = await r.json();
    if (r.status === 200) lat.push(performance.now() - t0);
    else errors[body?.error?.code ?? String(r.status)] = (errors[body?.error?.code ?? String(r.status)] ?? 0) + 1;
  } catch (e) {
    const k = (e as Error).name;
    errors[k] = (errors[k] ?? 0) + 1;
  }
}

async function closedLoop(n: number) {
  const lat: number[] = [];
  const errors: Record<string, number> = {};
  const stopAt = performance.now() + durationS * 1000;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: n }, async () => {
    while (performance.now() < stopAt) await one(lat, errors);
  }));
  return { lat, errors, elapsed: (performance.now() - t0) / 1000 };
}

async function openLoop(rps: number) {
  const lat: number[] = [];
  const errors: Record<string, number> = {};
  const rand = seeded(rps);
  const tasks: Promise<void>[] = [];
  const t0 = performance.now();
  let next = t0;
  while (next - t0 < durationS * 1000) {
    const d = next - performance.now();
    if (d > 0) await new Promise((r) => setTimeout(r, d));
    tasks.push(one(lat, errors));
    next += expovariate(rand, rps);
  }
  await Promise.all(tasks); // stragglers' latency is the point of an open-loop test
  return { lat, errors, elapsed: (performance.now() - t0) / 1000 };
}

async function counters() {
  const s = await api(`${url}/v1/stats`);
  return { batches: s.batcher.batches as number, items: s.batcher.items as number };
}

async function runOne(load: "closed" | "open", mode: "batched" | "unbatched", level: number): Promise<Result> {
  await api(`${url}/v1/admin/config`, { method: "PATCH", body: JSON.stringify({ batching_enabled: mode === "batched", cache_enabled: false }) });
  await fetch(`${url}/v1/admin/cache`, { method: "DELETE" });
  await fetch(`${url}/v1/admin/circuit/reset`, { method: "POST" });
  await new Promise((r) => setTimeout(r, 500));
  const c0 = await counters();
  const { lat, errors, elapsed } = load === "closed" ? await closedLoop(level) : await openLoop(level);
  const c1 = await counters();
  const batches = c1.batches - c0.batches;
  const res: Result = {
    load, mode, level, duration_s: Math.round(elapsed * 100) / 100, completed: lat.length, errors,
    throughput_rps: Math.round((lat.length / elapsed) * 100) / 100,
    p50_ms: percentile(lat, 50), p95_ms: percentile(lat, 95), p99_ms: percentile(lat, 99),
    mean_ms: lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : null,
    mean_batch_size: batches ? Math.round(((c1.items - c0.items) / batches) * 100) / 100 : null,
    model_calls: batches,
  };
  const f = (v: number | null) => (v === null ? "       -" : v.toFixed(1).padStart(8));
  console.log(`  ${load.padEnd(6)} ${mode.padEnd(9)} level=${String(level).padStart(4)}  rps=${res.throughput_rps.toFixed(1).padStart(6)}  p50=${f(res.p50_ms)}  p95=${f(res.p95_ms)}  p99=${f(res.p99_ms)}  batch=${res.mean_batch_size}  errors=${JSON.stringify(errors)}`);
  return res;
}

const cell = (v: number | null) => (v === null ? "—" : v >= 100 ? Math.round(v).toLocaleString("en-US") : v.toFixed(1));

function markdown(results: Result[], meta: Record<string, unknown>): string {
  const by = new Map(results.map((r) => [`${r.load}|${r.mode}|${r.level}`, r]));
  const out: string[] = [];
  out.push("### Closed loop: throughput at fixed concurrency\n");
  out.push("| Concurrent clients | Mode | Throughput (req/s) | p50 ms | p95 ms | p99 ms | Mean batch | Model calls |");
  out.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const lv of concurrency) for (const mode of ["unbatched", "batched"] as const) {
    const r = by.get(`closed|${mode}|${lv}`);
    if (r) out.push(`| ${lv} | ${mode} | ${r.throughput_rps.toFixed(1)} | ${cell(r.p50_ms)} | ${cell(r.p95_ms)} | ${cell(r.p99_ms)} | ${r.mean_batch_size ?? "—"} | ${r.model_calls} |`);
  }
  out.push("\n| Concurrent clients | Throughput gain | p50 change | p99 change |");
  out.push("| --- | --- | --- | --- |");
  for (const lv of concurrency) {
    const u = by.get(`closed|unbatched|${lv}`);
    const b = by.get(`closed|batched|${lv}`);
    if (u && b && u.p50_ms && b.p50_ms && u.p99_ms && b.p99_ms) {
      const pct = (x: number, y: number) => `${((y - x) / x) * 100 >= 0 ? "+" : ""}${Math.round(((y - x) / x) * 100)}%`;
      out.push(`| ${lv} | ${(b.throughput_rps / u.throughput_rps).toFixed(2)}× | ${pct(u.p50_ms, b.p50_ms)} | ${pct(u.p99_ms, b.p99_ms)} |`);
    }
  }
  if (rates.length) {
    out.push("\n### Open loop: latency at a fixed arrival rate\n");
    out.push("| Offered load (req/s) | Mode | Served (req/s) | p50 ms | p95 ms | p99 ms | Mean batch | Errors |");
    out.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const rt of rates) for (const mode of ["unbatched", "batched"] as const) {
      const r = by.get(`open|${mode}|${rt}`);
      if (r) {
        const errs = Object.entries(r.errors).map(([k, v]) => `${k} ${v}`).join(", ") || "0";
        out.push(`| ${rt} | ${mode} | ${r.throughput_rps.toFixed(1)} | ${cell(r.p50_ms)} | ${cell(r.p95_ms)} | ${cell(r.p99_ms)} | ${r.mean_batch_size ?? "—"} | ${errs} |`);
      }
    }
  }
  out.push(`\n_Measured ${meta.when} on ${meta.machine}. Backend: ${meta.backend}. ${durationS} s per run, unique input per request, cache disabled._`);
  return out.join("\n");
}

const stats = await api(`${url}/v1/stats`);
const original = { batching_enabled: stats.config.batching_enabled, cache_enabled: stats.config.cache_enabled };
const be = stats.backend ?? {};
const backendDesc = be.backend === "stub"
  ? `stub, ${be.base_ms} ms base + ${be.per_item_ms} ms/item ± ${be.jitter_ms} ms, device concurrency ${be.concurrency}`
  : `${be.backend} ${be.model ?? ""}`;
const results: Result[] = [];
try {
  console.log("closed loop");
  for (const c of concurrency) for (const m of ["unbatched", "batched"] as const) results.push(await runOne("closed", m, c));
  if (rates.length) {
    console.log("open loop");
    for (const r of rates) for (const m of ["unbatched", "batched"] as const) results.push(await runOne("open", m, r));
  }
} finally {
  await api(`${url}/v1/admin/config`, { method: "PATCH", body: JSON.stringify(original) });
}
const meta = {
  when: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC",
  machine: `${os.platform()} ${os.arch()}, ${os.cpus().length} CPUs, Node ${process.version}`,
  backend: backendDesc,
  duration_s: durationS,
  server_config: stats.config,
  embedder: stats.embedder,
};
save("batching.json", { meta, results });
const md = markdown(results, meta);
save("batching.md", md + "\n");
console.log("\n" + md);
