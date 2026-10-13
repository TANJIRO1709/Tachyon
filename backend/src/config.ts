/**
 * Every tunable in one place.
 *
 * Values come from environment variables at boot. A subset can be changed at
 * runtime through PATCH /v1/admin/config, so a demo can show the effect of a
 * change without a restart. Keys are snake_case because they are also the
 * JSON field names of the admin API.
 */

const env = process.env;
const str = (k: string, d: string) => env[k] ?? d;
const int = (k: string, d: number) => {
  const v = Number.parseInt(env[k] ?? "", 10);
  return Number.isFinite(v) ? v : d;
};
const float = (k: string, d: number) => {
  const v = Number.parseFloat(env[k] ?? "");
  return Number.isFinite(v) ? v : d;
};
const bool = (k: string, d: boolean) => {
  const v = env[k];
  return v === undefined ? d : ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
};

export function loadSettings() {
  return {
    // serving
    host: str("HOST", "0.0.0.0"),
    port: int("PORT", 8000),

    // batching
    batching_enabled: bool("BATCHING_ENABLED", true),
    batch_window_ms: float("BATCH_WINDOW_MS", 50),
    max_batch_size: int("MAX_BATCH_SIZE", 16),
    /** Shrink the wait when batches are not filling, so light load does not
     *  pay the full window for a batch that will never fill. */
    adaptive_window: bool("ADAPTIVE_WINDOW", true),
    min_batch_window_ms: float("MIN_BATCH_WINDOW_MS", 5),
    queue_max_size: int("QUEUE_MAX_SIZE", 1000),
    request_timeout_ms: float("REQUEST_TIMEOUT_MS", 30_000),
    batch_timeout_ms: float("BATCH_TIMEOUT_MS", 20_000),

    // semantic cache
    cache_enabled: bool("CACHE_ENABLED", true),
    cache_max_entries: int("CACHE_MAX_ENTRIES", 10_000),
    cache_threshold: float("CACHE_THRESHOLD", 0.92),
    /** Relaxed threshold used only when the model cannot answer, where an
     *  approximate answer (flagged degraded) beats an error. */
    cache_degraded_threshold: float("CACHE_DEGRADED_THRESHOLD", 0.82),
    cache_ttl_s: float("CACHE_TTL_S", 300),
    cache_sweep_interval_s: float("CACHE_SWEEP_INTERVAL_S", 60),
    cache_top_k: int("CACHE_TOP_K", 5),

    // circuit breaker
    breaker_failure_threshold: int("BREAKER_FAILURE_THRESHOLD", 5),
    breaker_latency_threshold_ms: float("BREAKER_LATENCY_THRESHOLD_MS", 2000),
    breaker_cooldown_s: float("BREAKER_COOLDOWN_S", 10),
    breaker_probe_limit: int("BREAKER_PROBE_LIMIT", 3),
    breaker_probe_success_required: int("BREAKER_PROBE_SUCCESS_REQUIRED", 3),

    // embedder
    /** "minilm": all-MiniLM-L6-v2 via Transformers.js (real semantics).
     *  "hash": offline lexical fallback for tests. It matches rewordings that
     *  share content words, NOT true paraphrases. */
    embedder: str("EMBEDDER", "minilm"),
    embedding_dim: int("EMBEDDING_DIM", 384),
    embedder_model: str("EMBEDDER_MODEL", "Xenova/all-MiniLM-L6-v2"),
    /** Weight precision for the embedder. "fp32" is full precision, ~90 MB.
     *  "q8" is quantised to 8-bit: roughly a quarter of the memory and faster,
     *  at some cost in similarity precision. Worth it on a 512 MB host; re-run
     *  the threshold sweep after switching, because the scores shift. */
    embedder_dtype: str("EMBEDDER_DTYPE", "fp32"),
    embed_batch_window_ms: float("EMBED_BATCH_WINDOW_MS", 3),
    embed_max_batch_size: int("EMBED_MAX_BATCH_SIZE", 64),

    // model backend
    /** "stub": simulated single accelerator. "hf": real HuggingFace model. */
    model_backend: str("MODEL_BACKEND", "stub"),
    /** Batches the device runs at once. One GPU is 1: batches serialise on it,
     *  which is exactly why packing more requests into each batch pays. */
    model_concurrency: int("MODEL_CONCURRENCY", 1),
    stub_latency_ms: float("STUB_LATENCY_MS", 80),
    /** Marginal cost per item inside a batch: a batch of n costs
     *  base + n * per_item, not n * base. */
    stub_per_item_ms: float("STUB_PER_ITEM_MS", 3),
    stub_jitter_ms: float("STUB_JITTER_MS", 15),
    hf_model: str("HF_MODEL", "Xenova/distilbert-base-uncased-finetuned-sst-2-english"),
    hf_task: str("HF_TASK", "sentiment-analysis"),

    // observability
    reservoir_size: int("RESERVOIR_SIZE", 10_000),
    /** Percentiles cover samples from the last N seconds, so a spike shows
     *  immediately and stops showing once it is over. */
    percentile_window_s: float("PERCENTILE_WINDOW_S", 60),
    log_buffer_size: int("LOG_BUFFER_SIZE", 1000),
    /** 80-character previews of the input and matched query in request logs.
     *  Turn off where inputs may hold personal data. */
    log_inputs: bool("LOG_INPUTS", true),
    log_to_stdout: bool("LOG_TO_STDOUT", true),

    max_input_chars: int("MAX_INPUT_CHARS", 4000),
    cors_origins: str("CORS_ORIGINS", "http://localhost:3000"),
    /** When set, every /v1/admin/* route requires `X-Admin-Token` to match.
     *  Left empty (the default) the admin API is open, which is what makes the
     *  public demo interactive: a visitor can break the model and watch the
     *  breaker recover. Set it before putting anything that costs money or
     *  touches real data behind this server. */
    admin_token: str("ADMIN_TOKEN", ""),
  };
}

export type Settings = ReturnType<typeof loadSettings>;

/** Fields a client may change at runtime, with their accepted range. */
export const MUTABLE = {
  batching_enabled: [0, 1],
  batch_window_ms: [1, 1000],
  max_batch_size: [1, 256],
  adaptive_window: [0, 1],
  cache_enabled: [0, 1],
  cache_threshold: [0, 1],
  cache_degraded_threshold: [0, 1],
  cache_ttl_s: [1, 86_400],
  breaker_failure_threshold: [1, 100],
  breaker_latency_threshold_ms: [1, 600_000],
  breaker_cooldown_s: [1, 3600],
  breaker_probe_limit: [1, 100],
  breaker_probe_success_required: [1, 100],
} as const satisfies Partial<Record<keyof Settings, readonly [number, number]>>;

export type MutableKey = keyof typeof MUTABLE;
const INTEGER_KEYS = new Set<string>([
  "max_batch_size", "breaker_failure_threshold", "breaker_probe_limit", "breaker_probe_success_required",
]);

export function mutableView(s: Settings): Record<MutableKey, number | boolean> {
  const out = {} as Record<MutableKey, number | boolean>;
  for (const k of Object.keys(MUTABLE) as MutableKey[]) out[k] = s[k];
  return out;
}

/** Apply a runtime patch. Returns the fields that actually changed.
 *  Throws on an unknown field or an out-of-range value; nothing is applied
 *  unless every field is valid. */
export function applyPatch(s: Settings, patch: Record<string, unknown>): Record<string, number | boolean> {
  const staged: [MutableKey, number | boolean][] = [];
  for (const [key, raw] of Object.entries(patch)) {
    if (!(key in MUTABLE)) throw new RangeError(`'${key}' is not runtime-mutable`);
    const k = key as MutableKey;
    const [lo, hi] = MUTABLE[k];
    let value: number | boolean;
    let numeric: number;
    if (typeof s[k] === "boolean") {
      if (typeof raw !== "boolean" && raw !== 0 && raw !== 1) throw new RangeError(`'${k}' must be true or false`);
      value = Boolean(raw);
      numeric = value ? 1 : 0;
    } else {
      numeric = Number(raw);
      if (typeof raw === "boolean" || !Number.isFinite(numeric)) throw new RangeError(`'${k}' must be a number`);
      if (INTEGER_KEYS.has(k) && !Number.isInteger(numeric)) throw new RangeError(`'${k}' must be an integer`);
      value = numeric;
    }
    if (numeric < lo || numeric > hi) throw new RangeError(`'${k}' must be between ${lo} and ${hi}, got ${numeric}`);
    staged.push([k, value]);
  }
  const changed: Record<string, number | boolean> = {};
  for (const [k, v] of staged) {
    if (s[k] !== v) {
      (s as Record<string, unknown>)[k] = v;
      changed[k] = v;
    }
  }
  return changed;
}
