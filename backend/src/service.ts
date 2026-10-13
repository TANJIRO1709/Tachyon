/**
 * The request lifecycle, in this order:
 *
 *   validate -> (fast reject?) -> embed -> cache lookup -> breaker -> queue
 *   -> batch -> model -> demultiplex -> breaker feedback -> cache populate
 *
 * and, whenever the model cannot answer, the degradation ladder:
 *
 *   1. normal-threshold cache hit       full quality
 *   2. relaxed-threshold cache hit      degraded=true, similarity disclosed
 *   3. machine-readable error           with a real Retry-After
 */
import { createHash, randomUUID } from "node:crypto";
import { now } from "./async.js";
import {
  BatchMeta, BatchTimeoutError, BatcherClosedError, DynamicBatcher, QueueFullError, RequestTimeoutError,
} from "./batcher.js";
import { CircuitBreaker, Permit, Transition } from "./circuitBreaker.js";
import { Settings, mutableView } from "./config.js";
import { Embedder, HashEmbedder, buildEmbedder } from "./embedder.js";
import { HFBackend, ModelBackend, Output, StubBackend } from "./modelBackend.js";
import { CacheHit, CacheMiss, SemanticCache } from "./semanticCache.js";
import { Telemetry, registerComputedGauges } from "./telemetry.js";

export type InferOptions = {
  /** false = skip the cache READ (the fresh answer still refreshes the cache). */
  cache?: boolean;
  cacheThreshold?: number;
  maxWaitMs?: number;
};

export type Source = "cache" | "model" | "degraded_cache";

export type Timings = {
  embed_ms: number | null;
  cache_lookup_ms: number | null;
  queue_wait_ms: number | null;
  model_latency_ms: number | null;
  total_latency_ms: number | null;
};

export type InferOutcome = {
  requestId: string;
  output: unknown;
  source: Source;
  cached: boolean;
  degraded: boolean;
  degradedReason: string | null;
  similarity: number | null;
  matchedQuery: string | null;
  cacheAgeS: number | null;
  batchId: string | null;
  batchSize: number | null;
  circuitState: string;
  timings: Timings;
};

export class ServiceError extends Error {
  timings: Timings | null = null;
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly retryAfterS: number | null = null,
    readonly circuitState: string | null = null,
  ) {
    super(message);
  }
}

type Work = { text: string; permit: Permit };

type Ctx = {
  requestId: string;
  text: string;
  t0: number;
  timings: Timings;
  cache: string; // hit | miss | bypass | disabled | skipped
  similarity: number | null;
  bestMissSimilarity: number | null;
  matchedQuery: string | null;
  batchId: string | null;
  batchSize: number | null;
  probe: boolean;
};

const r = (v: number | null | undefined, nd = 3): number | null =>
  v === null || v === undefined ? null : Math.round(v * 10 ** nd) / 10 ** nd;

export class InferenceService {
  readonly telemetry: Telemetry;
  readonly breaker: CircuitBreaker;
  readonly modelBatcher: DynamicBatcher<Work, Output>;
  embedBatcher: DynamicBatcher<string, Float32Array> | null = null;
  embedder: Embedder | null = null;
  backend: ModelBackend | null = null;
  cache: SemanticCache | null = null;
  ready = false;
  readonly counts: Record<string, number> = {};
  private sweeper: NodeJS.Timeout | null = null;
  private readonly startedAt = now();

  constructor(
    readonly settings: Settings,
    private readonly overrides: { embedder?: Embedder; backend?: ModelBackend; telemetry?: Telemetry } = {},
  ) {
    this.telemetry = overrides.telemetry ?? new Telemetry({
      reservoirSize: settings.reservoir_size,
      windowS: settings.percentile_window_s,
      logBufferSize: settings.log_buffer_size,
      logToStdout: settings.log_to_stdout,
    });
    this.breaker = new CircuitBreaker(this.breakerConfig(), { onTransition: (t) => this.onTransition(t) });
    this.modelBatcher = new DynamicBatcher("model", (work) => this.backend!.inferBatch(work.map((w) => w.text)), {
      windowMs: () => this.settings.batch_window_ms,
      maxBatchSize: () => this.settings.max_batch_size,
      enabled: () => this.settings.batching_enabled,
      adaptive: () => this.settings.adaptive_window,
      minWindowMs: () => this.settings.min_batch_window_ms,
      maxInflight: Math.max(1, settings.model_concurrency),
      queueMax: settings.queue_max_size,
      batchTimeoutMs: settings.batch_timeout_ms,
      onBatch: (work, meta, err) => this.onModelBatch(work, meta, err),
    });
    registerComputedGauges(this.telemetry, () => this.stats());
  }

  // ------------------------------------------------------------ lifecycle
  private breakerConfig() {
    const s = this.settings;
    return {
      failureThreshold: s.breaker_failure_threshold,
      latencyThresholdMs: s.breaker_latency_threshold_ms,
      cooldownS: s.breaker_cooldown_s,
      probeLimit: s.breaker_probe_limit,
      probeSuccessRequired: s.breaker_probe_success_required,
    };
  }

  /** Push runtime config changes into components that copy values. */
  syncConfig(): void {
    this.breaker.config = this.breakerConfig();
    if (this.cache) this.cache.ttlS = this.settings.cache_ttl_s;
  }

  async start(): Promise<void> {
    const s = this.settings;
    const t0 = now();
    const progress = (message: string) => this.telemetry.log("model_download", { message });
    if (!this.overrides.embedder && s.embedder !== "hash") {
      this.telemetry.log("model_loading", { model: s.embedder_model, note: "first start downloads the weights; /readyz returns 503 until ready" });
    }
    this.embedder = this.overrides.embedder ?? (await buildEmbedder(s.embedder, { dim: s.embedding_dim, model: s.embedder_model, log: progress }));
    if (this.overrides.backend) this.backend = this.overrides.backend;
    else if (s.model_backend === "stub") {
      this.backend = new StubBackend({ baseMs: s.stub_latency_ms, perItemMs: s.stub_per_item_ms, jitterMs: s.stub_jitter_ms, concurrency: s.model_concurrency });
    } else if (s.model_backend === "hf") {
      this.telemetry.log("model_loading", { model: s.hf_model, task: s.hf_task });
      this.backend = await HFBackend.load(s.hf_model, s.hf_task, s.model_concurrency, progress);
    } else throw new RangeError(`unknown MODEL_BACKEND '${s.model_backend}'`);

    this.cache = new SemanticCache({ capacity: s.cache_max_entries, dim: this.embedder.dim, ttlS: s.cache_ttl_s, topK: s.cache_top_k });

    // The hash embedder costs microseconds; batching it would only add the
    // window. A real model gets one forward pass per micro-batch instead.
    if (!(this.embedder instanceof HashEmbedder)) {
      const emb = this.embedder;
      this.embedBatcher = new DynamicBatcher("embed", (texts) => emb.embed(texts), {
        windowMs: () => this.settings.embed_batch_window_ms,
        maxBatchSize: () => this.settings.embed_max_batch_size,
        maxInflight: 1,
        queueMax: s.queue_max_size * 2,
        batchTimeoutMs: 10_000,
      });
      this.embedBatcher.start();
    }
    this.modelBatcher.start();
    this.sweeper = setInterval(() => {
      const removed = this.cache?.sweepExpired() ?? 0;
      if (removed) this.telemetry.log("cache_sweep", { removed, entries: this.cache?.size });
    }, s.cache_sweep_interval_s * 1000);
    this.sweeper.unref();
    this.ready = true;
    this.telemetry.log("startup", {
      embedder: this.embedder.name, embedding_dim: this.embedder.dim, backend: this.backend.name,
      batching_enabled: s.batching_enabled, batch_window_ms: s.batch_window_ms, max_batch_size: s.max_batch_size,
      cache_capacity: s.cache_max_entries, cache_threshold: s.cache_threshold, cache_ttl_s: s.cache_ttl_s,
      startup_ms: r(now() - t0, 1), node: process.version,
    });
  }

  async stop(): Promise<void> {
    this.ready = false;
    if (this.sweeper) clearInterval(this.sweeper);
    // Embeddings first: requests mid-embed still need the model batcher.
    await this.embedBatcher?.stop();
    await this.modelBatcher.stop();
    this.telemetry.log("shutdown", { batches: this.modelBatcher.batches });
  }

  // ---------------------------------------------------------------- hooks
  private onTransition(t: Transition): void {
    const tel = this.telemetry;
    tel.circuitTransitions.inc({ from_state: t.from, to_state: t.to });
    if (t.to === "open") tel.circuitTrips.inc();
    tel.log("circuit_transition", {
      from_state: t.from, to_state: t.to, reason: t.reason,
      trips: this.breaker.stats.trips, cooldown_s: this.breaker.config.cooldownS,
    }, t.to === "open" ? "warn" : "info");
  }

  /** Runs once per batch, before any caller is resumed. */
  private onModelBatch(work: Work[], meta: BatchMeta, error: Error | null): void {
    const tel = this.telemetry;
    const ok = error === null;
    const slow = ok && meta.processMs > this.settings.breaker_latency_threshold_ms;
    // One backend call = one breaker observation, however many rode in it.
    this.breaker.record(work.map((w) => w.permit), { ok, latencyMs: meta.processMs });

    tel.modelLatency.observe(meta.processMs / 1000);
    tel.rModel.add(meta.processMs);
    tel.batchSize.observe(meta.batchSize);
    tel.rBatchSize.add(meta.batchSize);
    const outcome = ok && !slow ? "ok" : slow ? "slow" : "error";
    tel.batches.inc({ reason: meta.dispatchReason, outcome });
    if (error instanceof BatchTimeoutError) tel.modelErrors.inc({ kind: "timeout" });
    else if (error) tel.modelErrors.inc({ kind: "exception" });
    else if (slow) tel.modelErrors.inc({ kind: "slow" });

    tel.log("batch", {
      batch_id: meta.batchId, batch_size: meta.batchSize, dispatch_reason: meta.dispatchReason,
      window_ms: r(meta.windowMs, 2), mean_queue_wait_ms: r(meta.meanQueueWaitMs), max_queue_wait_ms: r(meta.maxQueueWaitMs),
      model_latency_ms: r(meta.processMs), probes: work.filter((w) => w.permit.probe).length, outcome,
      error: error ? `${error.name}: ${error.message}` : null, circuit_state: this.breaker.state,
    }, outcome === "ok" ? "info" : "warn");
  }

  // ---------------------------------------------------------------- embed
  private async embed(text: string): Promise<Float32Array> {
    if (this.embedBatcher) return (await this.embedBatcher.submit(text))[0];
    return (await this.embedder!.embed([text]))[0]!;
  }

  // --------------------------------------------------------------- handle
  async handle(text: string, opts: InferOptions = {}, requestId?: string): Promise<InferOutcome> {
    if (!this.ready) throw new ServiceError("NOT_READY", 503, "Service is starting up or shutting down.", 2);
    const s = this.settings;
    const cache = this.cache!;
    const ctx: Ctx = {
      requestId: requestId ?? randomUUID(), text, t0: now(),
      timings: { embed_ms: null, cache_lookup_ms: null, queue_wait_ms: null, model_latency_ms: null, total_latency_ms: null },
      cache: "disabled", similarity: null, bestMissSimilarity: null, matchedQuery: null, batchId: null, batchSize: null, probe: false,
    };
    const cacheOn = s.cache_enabled;
    const readCache = cacheOn && opts.cache !== false;
    const threshold = opts.cacheThreshold ?? s.cache_threshold;

    try {
      // Fast reject: the breaker will refuse AND nothing in cache can stand in.
      // Skip the embedding entirely.
      if (this.breaker.peekRejects() && (!readCache || cache.size === 0)) {
        this.breaker.stats.rejected++;
        this.telemetry.shed.inc({ reason: "circuit_open" });
        ctx.cache = "skipped";
        throw this.circuitError();
      }

      let vec: Float32Array | null = null;
      let miss: CacheMiss | undefined;
      if (cacheOn) {
        const t = now();
        vec = await this.embed(text);
        ctx.timings.embed_ms = now() - t;
        this.telemetry.embedLatency.observe(ctx.timings.embed_ms / 1000);
        this.telemetry.rEmbed.add(ctx.timings.embed_ms);
      }

      // 1. Normal lookup, before the queue: hits never occupy a queue slot or
      //    a batch position.
      if (readCache && vec) {
        const t = now();
        const res = cache.lookup(vec, threshold);
        ctx.timings.cache_lookup_ms = now() - t;
        this.telemetry.cacheLookupLatency.observe(ctx.timings.cache_lookup_ms / 1000);
        if (res.kind === "hit") {
          ctx.cache = "hit";
          this.telemetry.cacheLookups.inc({ result: "hit" });
          this.telemetry.cacheHitSimilarity.observe({ mode: "normal" }, res.similarity);
          this.telemetry.cacheCallsSaved.inc();
          return this.finish(ctx, res.response, "cache", res);
        }
        ctx.cache = "miss";
        ctx.bestMissSimilarity = res.bestSimilarity;
        miss = res;
        this.telemetry.cacheLookups.inc({ result: "miss" });
      } else if (cacheOn) {
        ctx.cache = "bypass";
        this.telemetry.cacheLookups.inc({ result: "bypass" });
      }

      // 2. Breaker.
      const permit = this.breaker.allow();
      if (!permit) {
        this.telemetry.shed.inc({ reason: "circuit_open" });
        return this.degradeOrThrow(ctx, vec, readCache, this.circuitError(), "circuit_open");
      }
      ctx.probe = permit.probe;

      // 3. Queue -> batch -> model.
      const timeoutMs = opts.maxWaitMs ?? s.request_timeout_ms;
      let output: Output;
      let info;
      try {
        [output, info] = await this.modelBatcher.submit({ text, permit }, { timeoutMs });
      } catch (err) {
        if (err instanceof QueueFullError) {
          this.breaker.release(permit);
          this.telemetry.shed.inc({ reason: "queue_full" });
          throw new ServiceError("QUEUE_FULL", 429, "Request queue is full; the system is shedding load.", this.queueRetryAfter(), this.breaker.state);
        }
        if (err instanceof RequestTimeoutError) {
          // The batch may still run; release() is a no-op if it already counted.
          this.breaker.release(permit);
          throw new ServiceError("REQUEST_TIMEOUT", 504, `No response within ${(timeoutMs / 1000).toFixed(1)} s.`, null, this.breaker.state);
        }
        if (err instanceof BatcherClosedError) {
          this.breaker.release(permit);
          throw new ServiceError("SHUTTING_DOWN", 503, "Service is shutting down.", 5);
        }
        if (err instanceof BatchTimeoutError) {
          return this.degradeOrThrow(ctx, vec, readCache, new ServiceError("MODEL_TIMEOUT", 504, err.message, null, this.breaker.state), "model_timeout");
        }
        return this.degradeOrThrow(
          ctx, vec, readCache,
          new ServiceError("MODEL_ERROR", 502, `Model backend failed: ${(err as Error).message}`, 1, this.breaker.state),
          "model_error",
        );
      }

      ctx.batchId = info.batchId;
      ctx.batchSize = info.batchSize;
      ctx.timings.queue_wait_ms = info.queueWaitMs;
      ctx.timings.model_latency_ms = info.processMs;
      this.telemetry.queueWait.observe(info.queueWaitMs / 1000);
      this.telemetry.rQueue.add(info.queueWaitMs);

      // 4. Populate. Write-through even when the read was bypassed: a bypass
      //    asks for a fresh answer, and that answer refreshes the cache.
      // The miss from step 1 lets put() dedupe without a second full scan.
      if (cacheOn && vec) cache.put(vec, text, output, miss);
      return this.finish(ctx, output, "model");
    } catch (err) {
      if (err instanceof ServiceError) {
        this.finishError(ctx, err);
        throw err;
      }
      throw err;
    }
  }

  // ---------------------------------------------------------- degradation
  private circuitError(): ServiceError {
    return new ServiceError(
      "CIRCUIT_OPEN", 503,
      "Model backend is unavailable and no sufficiently similar cached response exists.",
      this.breaker.retryAfterS(), this.breaker.state,
    );
  }

  /** Rungs 2 and 3. A client that bypassed the cache asked for freshness
   *  explicitly, so it gets the error, not a stale answer. */
  private degradeOrThrow(ctx: Ctx, vec: Float32Array | null, readCache: boolean, err: ServiceError, reason: string): InferOutcome {
    if (readCache && vec) {
      const res = this.cache!.lookup(vec, this.settings.cache_degraded_threshold, { record: false });
      if (res.kind === "hit") {
        this.cache!.noteDegradedHit(res.similarity);
        this.telemetry.cacheHitSimilarity.observe({ mode: "degraded" }, res.similarity);
        this.telemetry.cacheCallsSaved.inc();
        return this.finish(ctx, res.response, "degraded_cache", res, reason);
      }
    }
    throw err;
  }

  private queueRetryAfter(): number {
    const lat = this.telemetry.rModel.summary().mean ?? this.settings.stub_latency_ms;
    const perBatch = this.settings.batching_enabled ? Math.max(1, this.settings.max_batch_size) : 1;
    return Math.max(0.1, Math.round(((this.modelBatcher.queueDepth / perBatch) * lat) / 10) / 100);
  }

  // --------------------------------------------------------------- finish
  private count(key: string): void {
    this.counts[key] = (this.counts[key] ?? 0) + 1;
  }

  private finish(ctx: Ctx, output: unknown, source: Source, hit?: CacheHit, degradedReason?: string): InferOutcome {
    const total = now() - ctx.t0;
    ctx.timings.total_latency_ms = total;
    if (hit) {
      ctx.similarity = hit.similarity;
      ctx.matchedQuery = hit.matchedQuery;
    }
    const tel = this.telemetry;
    tel.requests.inc({ status: "200", source });
    tel.requestLatency.observe({ source }, total / 1000);
    tel.rTotal.add(total);
    if (source === "model") tel.rTotalModel.add(total);
    else tel.rTotalCache.add(total);
    this.count(source);
    this.logRequest(ctx, { status: 200, source, degradedReason: degradedReason ?? null, error: null, cacheAgeS: hit?.ageS ?? null });
    const timings = Object.fromEntries(Object.entries(ctx.timings).map(([k, v]) => [k, r(v)])) as Timings;
    return {
      requestId: ctx.requestId, output, source, cached: !!hit, degraded: !!degradedReason, degradedReason: degradedReason ?? null,
      similarity: hit ? r(hit.similarity, 4) : null, matchedQuery: hit?.matchedQuery ?? null, cacheAgeS: hit ? r(hit.ageS, 2) : null,
      batchId: ctx.batchId, batchSize: ctx.batchSize, circuitState: this.breaker.state, timings,
    };
  }

  private finishError(ctx: Ctx, err: ServiceError): void {
    const total = now() - ctx.t0;
    ctx.timings.total_latency_ms = total;
    err.timings = Object.fromEntries(Object.entries(ctx.timings).map(([k, v]) => [k, r(v)])) as Timings;
    const source = err.status === 429 || err.status === 503 ? "rejected" : "error";
    this.telemetry.requests.inc({ status: String(err.status), source });
    this.telemetry.requestLatency.observe({ source }, total / 1000);
    this.telemetry.rTotal.add(total);
    this.count(source);
    this.logRequest(ctx, { status: err.status, source, degradedReason: null, error: err.code, cacheAgeS: null });
  }

  private logRequest(ctx: Ctx, o: { status: number; source: string; degradedReason: string | null; error: string | null; cacheAgeS: number | null }): void {
    const fields: Record<string, unknown> = {
      request_id: ctx.requestId,
      batch_id: ctx.batchId,
      batch_size: ctx.batchSize,
      cache: o.source === "degraded_cache" ? "degraded_hit" : ctx.cache,
      similarity: r(ctx.similarity, 4),
      best_miss_similarity: r(ctx.bestMissSimilarity, 4),
      cache_age_s: r(o.cacheAgeS, 2),
      degraded: o.degradedReason !== null,
      degraded_reason: o.degradedReason,
      circuit_state: this.breaker.state,
      probe: ctx.probe,
      source: o.source,
      embed_ms: r(ctx.timings.embed_ms),
      cache_lookup_ms: r(ctx.timings.cache_lookup_ms),
      queue_wait_ms: r(ctx.timings.queue_wait_ms),
      model_latency_ms: r(ctx.timings.model_latency_ms),
      total_latency_ms: r(ctx.timings.total_latency_ms),
      status: o.status,
      error: o.error,
      input_sha256: createHash("sha256").update(ctx.text).digest("hex").slice(0, 16),
      input_chars: ctx.text.length,
    };
    if (this.settings.log_inputs) {
      fields.input_preview = ctx.text.slice(0, 80);
      fields.matched_query = ctx.matchedQuery ? ctx.matchedQuery.slice(0, 80) : null;
    }
    this.telemetry.log("request", fields, o.status === 200 ? "info" : "warn");
  }

  // ---------------------------------------------------------------- stats
  stats() {
    const tel = this.telemetry;
    const cache = this.cache?.snapshot() ?? {
      entries: 0, capacity: this.settings.cache_max_entries, hit_rate: 0, avg_hit_similarity: null, inference_calls_saved: 0,
    };
    const latency = tel.latencySummary();
    const modelPathMean = latency.total_model_path.mean;
    const saved = cache.inference_calls_saved;
    return {
      uptime_s: Math.round((now() - this.startedAt) / 100) / 10,
      ready: this.ready,
      embedder: this.embedder?.name ?? null,
      request_rate_rps: r(tel.requestRate()),
      requests_by_source: { ...this.counts },
      latency,
      // Short window for live charts: a spike shows within a second and clears
      // within five, instead of lingering for the whole percentile window.
      latency_recent: tel.latencySummary(5),
      cache,
      estimated_model_ms_saved: modelPathMean !== null ? r(saved * modelPathMean, 1) : null,
      circuit: this.breaker.snapshot(),
      batcher: this.modelBatcher.snapshot(),
      batch_size_distribution: tel.batchSizeDistribution(),
      embed_batcher: this.embedBatcher?.snapshot() ?? null,
      backend: this.backend?.describe() ?? null,
      config: mutableView(this.settings),
      log_seq: tel.logSeq,
    };
  }
}
