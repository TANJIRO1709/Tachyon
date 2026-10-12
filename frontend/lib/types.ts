export type Pct = { p50: number | null; p95: number | null; p99: number | null; mean: number | null; max: number | null; samples: number };

export type LatencySummary = {
  window_s: number;
  total: Pct;
  total_cache_hits: Pct;
  total_model_path: Pct;
  model_per_batch: Pct;
  queue_wait: Pct;
  embed: Pct;
};

export type CircuitState = "closed" | "open" | "half_open";

export type Stats = {
  uptime_s: number;
  ready: boolean;
  embedder: string | null;
  request_rate_rps: number;
  requests_by_source: Partial<Record<Source, number>>;
  latency: LatencySummary;
  latency_recent: LatencySummary;
  cache: {
    entries: number;
    capacity: number;
    hit_rate: number;
    avg_hit_similarity: number | null;
    avg_degraded_hit_similarity: number | null;
    inference_calls_saved: number;
    hits: number;
    misses: number;
    degraded_hits: number;
    evictions_lru: number;
    evictions_ttl: number;
    ttl_s: number;
  };
  estimated_model_ms_saved: number | null;
  circuit: {
    state: CircuitState;
    consecutive_failures: number;
    failure_threshold: number;
    latency_threshold_ms: number;
    cooldown_s: number;
    probe_limit: number;
    probe_success_required: number;
    probes_sent: number;
    probes_ok: number;
    time_in_state_s: number;
    retry_after_s: number;
    trips: number;
    rejected: number;
    history: { ago_s: number; from: string; to: string; reason: string }[];
  };
  batcher: {
    enabled: boolean;
    window_ms: number;
    effective_window_ms: number;
    max_batch_size: number;
    queue_depth: number;
    queue_max: number;
    inflight: number;
    batches: number;
    items: number;
    mean_batch_size: number;
    recent_mean_batch_size: number;
    dispatch_reasons: Record<string, number>;
  };
  batch_size_distribution: { bucket: string; batches: number }[];
  backend: {
    backend: string;
    model?: string;
    base_ms?: number;
    per_item_ms?: number;
    fault: { mode: string; failure_rate: number; extra_latency_ms: number; remaining_s: number | null } | null;
  } | null;
  config: Config;
  log_seq: number;
};

export type Config = {
  batch_window_ms: number;
  max_batch_size: number;
  adaptive_window: boolean;
  cache_enabled: boolean;
  cache_threshold: number;
  cache_degraded_threshold: number;
  cache_ttl_s: number;
  breaker_failure_threshold: number;
  breaker_latency_threshold_ms: number;
  breaker_cooldown_s: number;
  breaker_probe_limit: number;
  breaker_probe_success_required: number;
  batching_enabled: boolean;
};

export type Source = "model" | "cache" | "degraded_cache" | "rejected" | "error";

export type LogRecord = {
  seq: number;
  ts: string;
  level: string;
  event: string;
  [k: string]: unknown;
};

export type InferResponse = {
  request_id: string;
  output: Record<string, unknown>;
  cached: boolean;
  degraded: boolean;
  degraded_reason: string | null;
  source: "model" | "cache" | "degraded_cache";
  similarity: number | null;
  matched_query: string | null;
  batch_id: string | null;
  batch_size: number | null;
  circuit_state: CircuitState;
  model_latency_ms: number | null;
  total_latency_ms: number;
};

export type InferError = {
  request_id: string;
  error: { code: string; message: string; retry_after_ms: number | null; circuit_state: CircuitState | null };
};

/** One point per stream snapshot, kept client-side for the charts. */
export type Point = {
  t: number; // epoch ms
  rps: Record<"model" | "cache" | "degraded_cache" | "rejected", number>;
  total: Pct;
  model: Pct;
  cacheHit: Pct;
  queue: Pct;
  queueDepth: number;
  state: CircuitState;
};
