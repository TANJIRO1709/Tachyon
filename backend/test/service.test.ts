/** End to end through InferenceService and the HTTP layer, with the stub
 *  backend and the offline hash embedder. */
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { sleep } from "../src/async.js";
import { Settings, loadSettings } from "../src/config.js";
import { HashEmbedder, dot } from "../src/embedder.js";
import { StubBackend } from "../src/modelBackend.js";
import { InferOptions, InferenceService, ServiceError } from "../src/service.js";
import { Telemetry } from "../src/telemetry.js";

function settings(o: Partial<Settings> = {}): Settings {
  return {
    ...loadSettings(),
    embedder: "hash",
    cache_threshold: 0.92,
    cache_degraded_threshold: 0.5,
    batch_window_ms: 20,
    max_batch_size: 16,
    breaker_failure_threshold: 2,
    breaker_cooldown_s: 0.3,
    breaker_probe_limit: 1,
    breaker_probe_success_required: 1,
    request_timeout_ms: 5000,
    log_to_stdout: false,
    ...o,
  };
}

const running: InferenceService[] = [];
afterEach(async () => {
  // Stop every service, even when a test failed, so no batcher keeps running.
  while (running.length) {
    const s = running.pop()!;
    if (s.ready || s.modelBatcher.running) await s.stop();
  }
});

async function started(s: Settings, backendOpts: ConstructorParameters<typeof StubBackend>[0] = {}) {
  const svc = new InferenceService(s, {
    embedder: new HashEmbedder(64),
    backend: new StubBackend({ baseMs: 10, perItemMs: 0.5, jitterMs: 1, seed: 7, ...backendOpts }),
    telemetry: new Telemetry({ reservoirSize: 1000, windowS: 60, logBufferSize: 500, logToStdout: false }),
  });
  await svc.start();
  running.push(svc);
  return svc;
}
const stub = (svc: InferenceService) => svc.backend as StubBackend;

async function expectError(p: Promise<unknown>, code: string): Promise<ServiceError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ServiceError);
    expect((e as ServiceError).code).toBe(code);
    return e as ServiceError;
  }
  throw new Error(`expected ${code}, got success`);
}

async function trip(svc: InferenceService) {
  stub(svc).setFault("error");
  for (let i = 0; i < svc.settings.breaker_failure_threshold; i++) {
    await expectError(svc.handle(`unique failing input ${i} zz${i}`), "MODEL_ERROR");
  }
  expect(svc.breaker.state).toBe("open");
}

describe("batching", () => {
  it("batches concurrent requests and routes every answer correctly", async () => {
    const svc = await started(settings({ cache_enabled: false }));
    const texts = Array.from({ length: 64 }, (_, i) => `distinct request ${i} about topic ${i * 31}`);
    const outs = await Promise.all(texts.map((t) => svc.handle(t)));
    outs.forEach((o, i) => {
      expect((o.output as any).echo).toBe(texts[i]);
      expect(o.source).toBe("model");
    });
    expect(Math.max(...outs.map((o) => o.batchSize!))).toBeGreaterThan(1);
    expect(new Set(outs.map((o) => o.batchId)).size).toBeLessThan(64);
  });
});

describe("caching", () => {
  it("serves a reworded query from cache without calling the model", async () => {
    const svc = await started(settings());
    const first = await svc.handle("What is Python?");
    expect(first.source).toBe("model");
    const calls = stub(svc).calls;
    const second = await svc.handle("Tell me about Python");
    expect(second).toMatchObject({ source: "cache", cached: true, matchedQuery: "What is Python?" });
    expect(second.output).toEqual(first.output);
    expect(stub(svc).calls).toBe(calls);
    expect((await svc.handle("What is Java?")).source).toBe("model");
  });

  it("bypass reads fresh and refreshes the entry instead of duplicating", async () => {
    const svc = await started(settings());
    await svc.handle("weather in rourkela");
    const fresh = await svc.handle("weather in rourkela", { cache: false });
    expect(fresh.source).toBe("model");
    expect(svc.cache!.stats.updates).toBe(1);
    expect(svc.cache!.size).toBe(1);
  });

  it("honours a per-request threshold", async () => {
    const svc = await started(settings());
    await svc.handle("python programming language basics");
    expect((await svc.handle("python language basics", { cacheThreshold: 0.999 })).source).toBe("model");
  });
});

describe("breaker and degradation", () => {
  it("serves a relaxed cache hit as degraded when the circuit is open", async () => {
    const svc = await started(settings({ cache_threshold: 0.99, cache_degraded_threshold: 0.5 }));
    const seeded = await svc.handle("python programming language tutorial for beginners");
    await trip(svc);
    const q = "python programming language tutorial";
    const [a, b] = await svc.embedder!.embed([q, (seeded.output as any).echo]);
    const sim = dot(a!, b!);
    expect(sim).toBeGreaterThan(0.5);
    expect(sim).toBeLessThan(0.99);
    const out = await svc.handle(q);
    expect(out).toMatchObject({ source: "degraded_cache", degraded: true, degradedReason: "circuit_open" });
    expect(out.similarity!).toBeCloseTo(sim, 3);
    expect(out.output).toEqual(seeded.output);
    const snap = svc.cache!.snapshot();
    expect([snap.degraded_hits, snap.hits]).toEqual([1, 0]);
  });

  it("fails fast with Retry-After when nothing similar is cached", async () => {
    const svc = await started(settings());
    await trip(svc);
    const e = await expectError(svc.handle("completely unrelated submarine question"), "CIRCUIT_OPEN");
    expect(e.status).toBe(503);
    expect(e.retryAfterS!).toBeGreaterThan(0);
  });

  it("skips the embedding when open with an empty cache", async () => {
    const svc = await started(settings());
    await trip(svc);
    svc.cache!.clear();
    const e = await expectError(svc.handle("anything at all"), "CIRCUIT_OPEN");
    expect(e.timings!.embed_ms).toBeNull();
  });

  it("gives a bypass client the error, not a stale answer", async () => {
    const svc = await started(settings());
    await svc.handle("python data structures");
    await trip(svc);
    await expectError(svc.handle("python data structures", { cache: false }), "CIRCUIT_OPEN");
  });

  it("degrades on a model error even while the circuit is closed", async () => {
    const svc = await started(settings({ breaker_failure_threshold: 10, cache_threshold: 0.99 }));
    await svc.handle("rust ownership borrowing rules lifetimes");
    stub(svc).setFault("error");
    const out = await svc.handle("rust ownership borrowing rules");
    expect(out).toMatchObject({ source: "degraded_cache", degradedReason: "model_error" });
    expect(svc.breaker.state).toBe("closed");
  });

  it("recovers through half-open", async () => {
    const svc = await started(settings());
    await trip(svc);
    stub(svc).setFault("none");
    await sleep(svc.settings.breaker_cooldown_s * 1000 + 50);
    expect((await svc.handle("fresh probe input kappa")).source).toBe("model");
    expect(svc.breaker.state).toBe("closed");
    expect(svc.breaker.history.map((t) => [t.from, t.to])).toEqual([["closed", "open"], ["open", "half_open"], ["half_open", "closed"]]);
  });

  it("returns 429 when the queue is full", async () => {
    const s = settings({ cache_enabled: false, queue_max_size: 2, max_batch_size: 1, batch_window_ms: 1 });
    const svc = await started(s, { baseMs: 200, perItemMs: 0, jitterMs: 0 });
    const res = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => svc.handle(`load ${i}`)));
    const errs = res.flatMap((r) => (r.status === "rejected" ? [r.reason as ServiceError] : []));
    expect(errs.map((e) => e.code)).toContain("QUEUE_FULL");
    expect(errs.every((e) => e.status === 429)).toBe(true);
  });

  it("releases the probe permit when the client times out", async () => {
    const s = settings({ cache_enabled: false, breaker_failure_threshold: 1, breaker_probe_limit: 1 });
    const svc = await started(s);
    await trip(svc);
    stub(svc).setFault("slow", { extraLatencyMs: 500 });
    await sleep(s.breaker_cooldown_s * 1000 + 50);
    await expectError(svc.handle("probe that will time out", { maxWaitMs: 50 } as InferOptions), "REQUEST_TIMEOUT");
    expect(svc.breaker.state).toBe("half_open");
    expect(svc.breaker.probesSent).toBe(0); // not wedged
  });
});

describe("observability", () => {
  it("writes the required fields and joins requests to their batch", async () => {
    const svc = await started(settings());
    const out = await svc.handle("observability check alpha");
    const rec = svc.telemetry.recentLogs({ event: "request" }).at(-1)!;
    for (const k of ["request_id", "batch_id", "cache", "model_latency_ms", "total_latency_ms", "error"]) expect(rec).toHaveProperty(k);
    expect(rec).toMatchObject({ request_id: out.requestId, batch_id: out.batchId, cache: "miss" });
    expect(svc.telemetry.recentLogs({ event: "batch" }).filter((l) => l.batch_id === out.batchId)).toHaveLength(1);
  });

  it("serves the HTTP surface and a valid /metrics", async () => {
    const s = settings();
    const svc = new InferenceService(s, {
      embedder: new HashEmbedder(64),
      backend: new StubBackend({ baseMs: 5, perItemMs: 0.1, jitterMs: 0 }),
      telemetry: new Telemetry({ reservoirSize: 1000, windowS: 60, logBufferSize: 500, logToStdout: false }),
    });
    await svc.start();
    const app = await buildApp(s, svc);
    await app.ready();
    try {
      const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
        app.inject({ method: "POST", url, payload: payload as object, headers });

      let r = await post("/v1/infer", { input: "What is Python?" }, { "x-request-id": "abc-123" });
      expect(r.statusCode).toBe(200);
      expect(r.headers["x-request-id"]).toBe("abc-123");
      expect(r.json()).toMatchObject({ request_id: "abc-123", cached: false });
      const hit = (await post("/v1/infer", { input: "Tell me about Python" })).json();
      expect(hit.cached).toBe(true);
      expect(hit.similarity).toBeGreaterThanOrEqual(0.92);

      r = await post("/v1/infer", { input: "" });
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe("INVALID_REQUEST");

      const batch = (await post("/v1/infer/batch", { inputs: ["a b c", "d e f"] })).json();
      expect(batch.results.map((x: any) => x.ok)).toEqual([true, true]);

      const text = (await app.inject({ method: "GET", url: "/metrics" })).body;
      for (const name of [
        "tachyon_request_rate_per_second",
        'tachyon_latency_ms{scope="total",quantile="p99"}',
        'tachyon_latency_ms{scope="model",quantile="p99"}',
        "tachyon_batch_size_bucket",
        "tachyon_cache_hit_rate",
        "tachyon_cache_avg_hit_similarity",
        "tachyon_cache_estimated_inference_calls_saved",
        'tachyon_circuit_state{state="closed"} 1',
        "tachyon_circuit_trips_total",
        "tachyon_model_duration_seconds_bucket",
        "tachyon_queue_depth",
        "tachyon_nodejs_eventloop_lag_p99_seconds",
      ]) expect(text).toContain(name);
      const types = text.split("\n").filter((l) => l.startsWith("# TYPE "));
      expect(new Set(types).size).toBe(types.length); // no family declared twice

      expect((await app.inject({ method: "PATCH", url: "/v1/admin/config", payload: { cache_threshold: 2 } })).statusCode).toBe(400);
      const ok = (await app.inject({ method: "PATCH", url: "/v1/admin/config", payload: { max_batch_size: 4, breaker_cooldown_s: 5 } })).json();
      expect(ok.changed).toEqual({ max_batch_size: 4, breaker_cooldown_s: 5 });
      expect(svc.breaker.config.cooldownS).toBe(5);

      expect((await post("/v1/admin/backend/fault", { mode: "error" })).statusCode).toBe(204);
      for (let i = 0; i < 2; i++) await post("/v1/infer", { input: `zz failing ${i} qq` });
      r = await post("/v1/infer", { input: "yy totally new zebra" });
      expect(r.statusCode).toBe(503);
      expect(r.json().error.code).toBe("CIRCUIT_OPEN");
      expect(Number(r.headers["retry-after"])).toBeGreaterThanOrEqual(1);
      const logs = (await app.inject({ method: "GET", url: "/v1/logs/recent?event=circuit_transition" })).json().logs;
      expect(logs.at(-1).to_state).toBe("open");
    } finally {
      await app.close();
    }
  });
});

describe("admin token", () => {
  async function appWith(token: string) {
    const s = settings({ admin_token: token });
    const svc = new InferenceService(s, {
      embedder: new HashEmbedder(64),
      backend: new StubBackend({ baseMs: 5, perItemMs: 0, jitterMs: 0 }),
      telemetry: new Telemetry({ reservoirSize: 100, windowS: 60, logBufferSize: 50, logToStdout: false }),
    });
    await svc.start();
    running.push(svc);
    const app = await buildApp(s, svc);
    await app.ready();
    return app;
  }

  it("leaves the admin API open when no token is set", async () => {
    const app = await appWith("");
    try {
      expect((await app.inject({ method: "GET", url: "/v1/admin/circuit" })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("requires the header when a token is set, and never echoes it back", async () => {
    const app = await appWith("s3cret");
    try {
      const denied = await app.inject({ method: "GET", url: "/v1/admin/circuit" });
      expect(denied.statusCode).toBe(401);
      expect(denied.json().error.code).toBe("UNAUTHORIZED");

      expect((await app.inject({ method: "GET", url: "/v1/admin/circuit", headers: { "x-admin-token": "wrong" } })).statusCode).toBe(401);

      const ok = await app.inject({ method: "GET", url: "/v1/admin/config", headers: { "x-admin-token": "s3cret" } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().all.admin_token).toBe("set");
      expect(ok.body).not.toContain("s3cret");

      // Inference and metrics stay public: only /v1/admin/* is guarded.
      expect((await app.inject({ method: "POST", url: "/v1/infer", payload: { input: "still open" } })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe("admin token and CORS", () => {
  async function appWith(over: Partial<Settings>) {
    const s = settings(over);
    const svc = new InferenceService(s, {
      embedder: new HashEmbedder(64),
      backend: new StubBackend({ baseMs: 5, perItemMs: 0, jitterMs: 0 }),
      telemetry: new Telemetry({ reservoirSize: 100, windowS: 60, logBufferSize: 50, logToStdout: false }),
    });
    await svc.start();
    running.push(svc);
    const app = await buildApp(s, svc);
    await app.ready();
    return app;
  }

  it("leaves the admin API open when no token is set", async () => {
    const app = await appWith({ admin_token: "" });
    try {
      expect((await app.inject({ method: "GET", url: "/v1/admin/circuit" })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("requires the header when a token is set, and never echoes the token back", async () => {
    const app = await appWith({ admin_token: "s3cret" });
    try {
      const denied = await app.inject({ method: "GET", url: "/v1/admin/circuit" });
      expect(denied.statusCode).toBe(401);
      expect(denied.json().error.code).toBe("UNAUTHORIZED");
      expect((await app.inject({ method: "GET", url: "/v1/admin/circuit", headers: { "x-admin-token": "wrong" } })).statusCode).toBe(401);

      const ok = await app.inject({ method: "GET", url: "/v1/admin/config", headers: { "x-admin-token": "s3cret" } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().all.admin_token).toBe("set");
      expect(ok.body).not.toContain("s3cret"); // the value itself never leaves

      // Only /v1/admin/* is guarded: inference and metrics stay public.
      expect((await app.inject({ method: "POST", url: "/v1/infer", payload: { input: "still open" } })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("echoes any origin when CORS_ORIGINS is '*', and only listed ones otherwise", async () => {
    const star = await appWith({ cors_origins: "*" });
    try {
      const r = await star.inject({ method: "GET", url: "/healthz", headers: { origin: "https://tachyon-xyz.vercel.app" } });
      expect(r.headers["access-control-allow-origin"]).toBe("https://tachyon-xyz.vercel.app");
    } finally {
      await star.close();
    }
    const pinned = await appWith({ cors_origins: "https://known.example" });
    try {
      const allowed = await pinned.inject({ method: "GET", url: "/healthz", headers: { origin: "https://known.example" } });
      expect(allowed.headers["access-control-allow-origin"]).toBe("https://known.example");
      const blocked = await pinned.inject({ method: "GET", url: "/healthz", headers: { origin: "https://evil.example" } });
      expect(blocked.headers["access-control-allow-origin"]).toBeUndefined();
    } finally {
      await pinned.close();
    }
  });
});
