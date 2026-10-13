/**
 * Cache staleness vs inference cost, simulated with the production cache class.
 *
 * Queries arrive as a Poisson process over Zipf-popular topics. Each topic's
 * true answer changes at random, on average every `lifetimeS` seconds (a price,
 * a stock level, a status page). A hit is STALE if the answer changed after it
 * was cached. For each TTL: hit rate (inference saved) vs stale-serve rate
 * (wrong answers served). A fake clock makes hours of traffic take seconds.
 *
 *   npm run bench:staleness
 */
import { SemanticCache } from "../src/semanticCache.js";
import { expovariate, save, seeded } from "./common.js";

function simulate(ttlS: number, cfg: { lifetimeS: number; rps: number; topics: number; durationS: number; capacity: number }) {
  const rand = seeded(7);
  let t = 0;
  const dim = 64;
  const cache = new SemanticCache({ capacity: cfg.capacity, dim, ttlS, clock: () => t });
  // One fixed embedding per topic isolates TTL from similarity effects.
  const vecs = Array.from({ length: cfg.topics }, () => Float32Array.from({ length: dim }, () => rand() - 0.5));
  const weights = Array.from({ length: cfg.topics }, (_, r) => 1 / (r + 1) ** 1.1);
  const wsum = weights.reduce((a, b) => a + b, 0);
  const pick = () => {
    let x = rand() * wsum;
    for (let i = 0; i < weights.length; i++) if ((x -= weights[i]!) <= 0) return i;
    return weights.length - 1;
  };
  const version = new Array(cfg.topics).fill(0);
  const nextChange: number[] = Array.from({ length: cfg.topics }, () => expovariate(rand, 1 / cfg.lifetimeS) / 1000);

  let hits = 0, stale = 0, requests = 0;
  while (t < cfg.durationS) {
    t += expovariate(rand, cfg.rps) / 1000;
    const topic = pick();
    while (nextChange[topic]! <= t) {
      version[topic]++;
      nextChange[topic] = nextChange[topic]! + expovariate(rand, 1 / cfg.lifetimeS) / 1000;
    }
    requests++;
    const res = cache.lookup(vecs[topic]!, 0.99);
    if (res.kind === "hit") {
      hits++;
      if (res.response !== version[topic]) stale++;
    } else cache.put(vecs[topic]!, `t${topic}`, version[topic]);
  }
  return {
    ttl_s: ttlS,
    hit_rate: hits / requests,
    stale_rate_of_all: stale / requests,
    stale_rate_of_hits: hits ? stale / hits : 0,
    model_calls_per_1k: ((requests - hits) / requests) * 1000,
  };
}

const cfg = { lifetimeS: 600, rps: 20, topics: 500, durationS: 4 * 3600, capacity: 10_000 };
const ttls = [5, 15, 30, 60, 120, 300, 900, 1800, 3600];
const rows = ttls.map((ttl) => simulate(ttl, cfg));
console.log(`answers change on average every ${cfg.lifetimeS} s; ${cfg.rps} req/s over ${cfg.topics} Zipf topics; ${cfg.durationS / 3600} h simulated\n`);
console.log("| TTL | Hit rate | Model calls per 1k requests | Hits that were stale | Stale answers per 1k requests |\n| --- | --- | --- | --- | --- |");
for (const r of rows) {
  const ttl = r.ttl_s >= 60 ? `${r.ttl_s / 60} min` : `${r.ttl_s} s`;
  console.log(`| ${ttl} | ${(r.hit_rate * 100).toFixed(1)}% | ${Math.round(r.model_calls_per_1k)} | ${(r.stale_rate_of_hits * 100).toFixed(1)}% | ${Math.round(r.stale_rate_of_all * 1000)} |`);
}
save("staleness_sim.json", { config: cfg, rows });
