/**
 * Metrics and structured logs.
 *
 * Two latency mechanisms, on purpose:
 * - Prometheus histograms with fixed buckets: cheap, and they aggregate
 *   correctly across replicas, but any percentile derived from them is only as
 *   precise as the bucket edges.
 * - Time-windowed reservoirs: raw samples from the last N seconds, sorted at
 *   scrape time for EXACT p50/p95/p99. Exact, but local to one process.
 *
 * The hot path only writes into a ring buffer, O(1). Sorting happens when
 * someone scrapes, never while a request is being served.
 */
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

const LATENCY_BUCKETS_S = [0.001, 0.0025, 0.005, 0.0075, 0.01, 0.015, 0.02, 0.03, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.5, 0.75, 1, 2, 5, 10];
const BATCH_SIZE_BUCKETS = [1, 2, 4, 8, 12, 16, 24, 32, 48, 64, 128, 256];
const SIMILARITY_BUCKETS = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.92, 0.94, 0.96, 0.98, 0.99, 1];

export type Pct = { p50: number | null; p95: number | null; p99: number | null; mean: number | null; max: number | null; samples: number };

/** Linear interpolation between closest ranks: the same definition numpy uses. */
function quantile(sorted: Float64Array, q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export class TimedReservoir {
  private readonly ts: Float64Array;
  private readonly val: Float64Array;
  private i = 0;
  total = 0;

  constructor(readonly size: number, public windowS: number, private readonly clock: () => number = () => performance.now() / 1000) {
    this.ts = new Float64Array(Math.max(1, size)).fill(-Infinity);
    this.val = new Float64Array(Math.max(1, size));
  }

  add(value: number): void {
    this.ts[this.i] = this.clock();
    this.val[this.i] = value;
    this.i = (this.i + 1) % this.ts.length;
    this.total++;
  }

  recent(windowS = this.windowS): Float64Array {
    const cutoff = this.clock() - windowS;
    const out: number[] = [];
    for (let k = 0; k < this.ts.length; k++) if (this.ts[k]! >= cutoff) out.push(this.val[k]!);
    return Float64Array.from(out);
  }

  count(windowS = this.windowS): number {
    const cutoff = this.clock() - windowS;
    let n = 0;
    for (let k = 0; k < this.ts.length; k++) if (this.ts[k]! >= cutoff) n++;
    return n;
  }

  summary(windowS = this.windowS): Pct {
    const v = this.recent(windowS);
    if (!v.length) return { p50: null, p95: null, p99: null, mean: null, max: null, samples: 0 };
    const s = v.slice().sort();
    const r = (x: number) => Math.round(x * 1000) / 1000;
    let sum = 0;
    for (const x of s) sum += x;
    return {
      p50: r(quantile(s, 0.5)),
      p95: r(quantile(s, 0.95)),
      p99: r(quantile(s, 0.99)),
      mean: r(sum / s.length),
      max: r(s[s.length - 1]!),
      samples: s.length,
    };
  }
}

export type LogRecord = { seq: number; ts: string; level: string; event: string; [k: string]: unknown };

export class Telemetry {
  readonly registry = new Registry();
  readonly startedAt = Date.now();

  readonly requests: Counter<"status" | "source">;
  readonly requestLatency: Histogram<"source">;
  readonly modelLatency: Histogram;
  readonly queueWait: Histogram;
  readonly embedLatency: Histogram;
  readonly cacheLookupLatency: Histogram;
  readonly batchSize: Histogram;
  readonly batches: Counter<"reason" | "outcome">;
  readonly cacheLookups: Counter<"result">;
  readonly cacheHitSimilarity: Histogram<"mode">;
  readonly cacheCallsSaved: Counter;
  readonly modelErrors: Counter<"kind">;
  readonly circuitTrips: Counter;
  readonly circuitTransitions: Counter<"from_state" | "to_state">;
  readonly shed: Counter<"reason">;

  readonly rTotal: TimedReservoir;
  readonly rModel: TimedReservoir;      // per batch
  readonly rQueue: TimedReservoir;
  readonly rEmbed: TimedReservoir;
  readonly rTotalCache: TimedReservoir;
  readonly rTotalModel: TimedReservoir;
  readonly rBatchSize: TimedReservoir;

  private readonly logBuffer: LogRecord[] = [];
  private seq = 0;
  logToStdout: boolean;

  constructor(opts: { reservoirSize: number; windowS: number; logBufferSize: number; logToStdout?: boolean }) {
    this.logToStdout = opts.logToStdout ?? true;
    this.logBufferSize = opts.logBufferSize;
    const registers = [this.registry];
    // RSS, heap, GC, and event-loop delay: in a single-threaded server a
    // blocked loop is the first thing to rule out when latency spikes.
    collectDefaultMetrics({ register: this.registry, prefix: "tachyon_" });

    this.requests = new Counter({ name: "tachyon_requests_total", help: "Inference requests by outcome. source: cache | model | degraded_cache | rejected | error", labelNames: ["status", "source"], registers });
    this.requestLatency = new Histogram({ name: "tachyon_request_duration_seconds", help: "End-to-end request latency as the client saw it.", labelNames: ["source"], buckets: LATENCY_BUCKETS_S, registers });
    this.modelLatency = new Histogram({ name: "tachyon_model_duration_seconds", help: "Backend latency per batch, measured around the backend call only.", buckets: LATENCY_BUCKETS_S, registers });
    this.queueWait = new Histogram({ name: "tachyon_queue_wait_seconds", help: "Time a request waited in the batch queue before dispatch.", buckets: LATENCY_BUCKETS_S, registers });
    this.embedLatency = new Histogram({ name: "tachyon_embed_duration_seconds", help: "Time to obtain a request's embedding (includes embed batching wait).", buckets: LATENCY_BUCKETS_S, registers });
    this.cacheLookupLatency = new Histogram({ name: "tachyon_cache_lookup_duration_seconds", help: "Similarity search time.", buckets: LATENCY_BUCKETS_S, registers });
    this.batchSize = new Histogram({ name: "tachyon_batch_size", help: "Requests per model batch.", buckets: BATCH_SIZE_BUCKETS, registers });
    this.batches = new Counter({ name: "tachyon_batches_total", help: "Model batches dispatched, by what triggered dispatch.", labelNames: ["reason", "outcome"], registers });
    this.cacheLookups = new Counter({ name: "tachyon_cache_lookups_total", help: "Cache lookups at the normal threshold. result: hit | miss | bypass", labelNames: ["result"], registers });
    this.cacheHitSimilarity = new Histogram({ name: "tachyon_cache_hit_similarity", help: "Cosine similarity of cache hits. mode: normal | degraded", labelNames: ["mode"], buckets: SIMILARITY_BUCKETS, registers });
    this.cacheCallsSaved = new Counter({ name: "tachyon_cache_inference_calls_saved_total", help: "Requests answered from cache instead of the model.", registers });
    this.modelErrors = new Counter({ name: "tachyon_model_errors_total", help: "Failed batches by kind: exception | timeout | slow", labelNames: ["kind"], registers });
    this.circuitTrips = new Counter({ name: "tachyon_circuit_trips_total", help: "Times the circuit breaker has opened.", registers });
    this.circuitTransitions = new Counter({ name: "tachyon_circuit_transitions_total", help: "Circuit breaker state transitions.", labelNames: ["from_state", "to_state"], registers });
    this.shed = new Counter({ name: "tachyon_load_shed_total", help: "Requests rejected before reaching the queue. reason: queue_full | circuit_open", labelNames: ["reason"], registers });

    const mk = () => new TimedReservoir(opts.reservoirSize, opts.windowS);
    this.rTotal = mk();
    this.rModel = mk();
    this.rQueue = mk();
    this.rEmbed = mk();
    this.rTotalCache = mk();
    this.rTotalModel = mk();
    this.rBatchSize = mk();
  }
  private readonly logBufferSize: number;

  // -------------------------------------------------------------- logging
  log(event: string, fields: Record<string, unknown> = {}, level: "info" | "warn" | "error" = "info"): LogRecord {
    const rec: LogRecord = { seq: ++this.seq, ts: new Date().toISOString(), level, event, ...fields };
    this.logBuffer.push(rec);
    if (this.logBuffer.length > this.logBufferSize) this.logBuffer.shift();
    if (this.logToStdout) {
      try {
        process.stdout.write(JSON.stringify(rec) + "\n");
      } catch {
        // Logging must never fail a request.
      }
    }
    return rec;
  }

  recentLogs(opts: { afterSeq?: number; limit?: number; event?: string } = {}): LogRecord[] {
    const out = this.logBuffer.filter((r) => r.seq > (opts.afterSeq ?? 0) && (!opts.event || r.event === opts.event));
    return out.slice(-(opts.limit ?? 200));
  }

  get logSeq(): number {
    return this.seq;
  }

  // ---------------------------------------------------------- computed view
  latencySummary(windowS?: number) {
    return {
      window_s: windowS ?? this.rTotal.windowS,
      total: this.rTotal.summary(windowS),
      total_cache_hits: this.rTotalCache.summary(windowS),
      total_model_path: this.rTotalModel.summary(windowS),
      model_per_batch: this.rModel.summary(windowS),
      queue_wait: this.rQueue.summary(windowS),
      embed: this.rEmbed.summary(windowS),
    };
  }

  /** Recent batch sizes bucketed for display. Prometheus carries the
   *  cumulative histogram; this is the same data over the recent window. */
  batchSizeDistribution() {
    const vals = this.rBatchSize.recent();
    const edges: [number, number][] = [[1, 1], [2, 3], [4, 7], [8, 15], [16, 31], [32, 63], [64, Infinity]];
    return edges.map(([lo, hi]) => {
      let n = 0;
      for (const v of vals) if (v >= lo && v <= hi) n++;
      return { bucket: lo === hi ? String(lo) : hi === Infinity ? `${lo}+` : `${lo}–${hi}`, batches: n };
    });
  }

  requestRate(windowS = 10): number {
    return this.rTotal.count(windowS) / windowS;
  }
}

/** Gauges computed at scrape time from live component state. Each reads one
 *  shared snapshot, computed at most once per scrape. */
export function registerComputedGauges(tel: Telemetry, compute: () => any): void {
  let cache: { at: number; value: any } | null = null;
  const snap = () => {
    const t = performance.now();
    if (!cache || t - cache.at > 50) cache = { at: t, value: compute() };
    return cache.value;
  };
  const registers = [tel.registry];
  const simple = (name: string, help: string, pick: (s: any) => number | null | undefined) =>
    new Gauge({
      name, help, registers,
      collect() {
        this.reset();
        const v = pick(snap());
        if (v !== null && v !== undefined && Number.isFinite(v)) this.set(v);
      },
    });

  // ONE family, many label sets.
  new Gauge({
    name: "tachyon_latency_ms",
    help: "Exact latency percentiles over the recent window, milliseconds. total = end to end; model = backend call per batch; queue = batch wait.",
    labelNames: ["scope", "quantile"],
    registers,
    collect() {
      this.reset();
      const lat = snap().latency;
      const scopes: [string, string][] = [
        ["total", "total"], ["total_cache_hits", "cache_hit"], ["total_model_path", "model_path"],
        ["model_per_batch", "model"], ["queue_wait", "queue"], ["embed", "embed"],
      ];
      for (const [key, scope] of scopes) {
        for (const q of ["p50", "p95", "p99"] as const) {
          const v = lat[key][q];
          if (v !== null) this.set({ scope, quantile: q }, v);
        }
      }
    },
  });
  simple("tachyon_request_rate_per_second", "Requests per second over the last 10 s.", (s) => s.request_rate_rps);
  simple("tachyon_cache_hit_rate", "Hits / (hits + misses) since start.", (s) => s.cache.hit_rate);
  simple("tachyon_cache_avg_hit_similarity", "Mean cosine similarity of normal cache hits since start.", (s) => s.cache.avg_hit_similarity);
  simple("tachyon_cache_entries", "Live cache entries.", (s) => s.cache.entries);
  simple("tachyon_cache_capacity", "Configured cache capacity.", (s) => s.cache.capacity);
  simple("tachyon_cache_estimated_inference_calls_saved", "Requests answered from cache rather than the model.", (s) => s.cache.inference_calls_saved);
  simple("tachyon_cache_estimated_model_ms_saved", "Calls saved times the recent mean model-path latency.", (s) => s.estimated_model_ms_saved);
  new Gauge({
    name: "tachyon_circuit_state",
    help: "1 for the current state, 0 otherwise.",
    labelNames: ["state"],
    registers,
    collect() {
      const st = snap().circuit.state;
      for (const s of ["closed", "open", "half_open"]) this.set({ state: s }, st === s ? 1 : 0);
    },
  });
  simple("tachyon_circuit_consecutive_failures", "Current consecutive failure count.", (s) => s.circuit.consecutive_failures);
  simple("tachyon_circuit_time_in_state_seconds", "Seconds since the last transition.", (s) => s.circuit.time_in_state_s);
  simple("tachyon_queue_depth", "Requests waiting in the batch queue.", (s) => s.batcher.queue_depth);
  simple("tachyon_batches_inflight", "Batches currently on the device.", (s) => s.batcher.inflight);
  simple("tachyon_batch_window_effective_ms", "Current batch window after adaptation.", (s) => s.batcher.effective_window_ms);
  simple("tachyon_batch_size_recent_mean", "EWMA of recent batch sizes.", (s) => s.batcher.recent_mean_batch_size);
}
