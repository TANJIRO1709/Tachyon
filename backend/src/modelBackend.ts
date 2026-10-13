/**
 * Model backends. The serving layer only sees `inferBatch`.
 *
 * StubBackend  simulates one accelerator. One batch occupies the device at a
 *              time (`concurrency`), and a batch of n costs
 *
 *                  baseMs + n * perItemMs + gaussian jitter
 *
 *              the shape of real GPU inference: a large fixed cost per forward
 *              pass plus a small marginal cost per sequence. That fixed cost is
 *              exactly what batching amortises. Faults can be injected at
 *              runtime for breaker demos.
 *
 * HFBackend    a real HuggingFace model run in-process via Transformers.js
 *              (default: DistilBERT SST-2 sentiment). No hosted API, no key.
 */
import { createHash } from "node:crypto";
import { Semaphore, monotonicS, sleep } from "./async.js";
import { downloadLogger, loadTransformers } from "./transformers.js";

export class BackendError extends Error { override name = "BackendError"; }

export type Output = Record<string, unknown>;

export interface ModelBackend {
  readonly name: string;
  inferBatch(inputs: string[]): Promise<Output[]>;
  describe(): Record<string, unknown>;
}

export type FaultMode = "none" | "error" | "slow" | "flaky";
type Fault = { mode: FaultMode; failureRate: number; extraLatencyMs: number; until: number | null };

/** Small seedable PRNG (mulberry32), so benchmark runs are reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class StubBackend implements ModelBackend {
  readonly name = "stub";
  calls = 0;
  items = 0;
  private fault: Fault = { mode: "none", failureRate: 0, extraLatencyMs: 0, until: null };
  private readonly device: Semaphore;
  private readonly rand: () => number;
  readonly baseMs: number;
  readonly perItemMs: number;
  readonly jitterMs: number;
  readonly concurrency: number;

  constructor(opts: { baseMs?: number; perItemMs?: number; jitterMs?: number; concurrency?: number; seed?: number } = {}) {
    this.baseMs = opts.baseMs ?? 80;
    this.perItemMs = opts.perItemMs ?? 3;
    this.jitterMs = opts.jitterMs ?? 15;
    this.concurrency = Math.max(1, opts.concurrency ?? 1);
    this.device = new Semaphore(this.concurrency);
    this.rand = opts.seed === undefined ? Math.random : rng(opts.seed);
  }

  setFault(mode: FaultMode, opts: { failureRate?: number; extraLatencyMs?: number; durationS?: number | null } = {}): void {
    if (!["none", "error", "slow", "flaky"].includes(mode)) throw new RangeError("mode must be none, error, slow or flaky");
    this.fault = {
      mode,
      failureRate: Math.min(1, Math.max(0, opts.failureRate ?? 0)),
      extraLatencyMs: Math.max(0, opts.extraLatencyMs ?? 0),
      until: opts.durationS ? monotonicS() + opts.durationS : null,
    };
  }

  private activeFault(): Fault {
    const f = this.fault;
    return f.mode !== "none" && (f.until === null || monotonicS() < f.until)
      ? f
      : { mode: "none", failureRate: 0, extraLatencyMs: 0, until: null };
  }

  private gauss(): number {
    // Box-Muller
    const u = 1 - this.rand();
    const v = this.rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  costMs(n: number): number {
    const jitter = this.jitterMs > 0 ? this.gauss() * this.jitterMs : 0;
    // Never faster than half the base: jitter cannot make inference free.
    return Math.max(this.baseMs * 0.5, this.baseMs + n * this.perItemMs + jitter);
  }

  /** Deterministic per input, so a test can check every caller in a batch got
   *  the answer for THEIR input and not a neighbour's. */
  static fakeOutput(text: string): Output {
    const digest = createHash("sha256").update(text).digest("hex");
    const score = Number.parseInt(digest.slice(0, 8), 16) / 0xffffffff;
    return {
      label: score >= 0.5 ? "POSITIVE" : "NEGATIVE",
      score: Math.round((0.5 + Math.abs(score - 0.5)) * 10_000) / 10_000,
      input_sha256: digest.slice(0, 16),
      echo: text.slice(0, 120),
    };
  }

  inferBatch(inputs: string[]): Promise<Output[]> {
    return this.device.run(async () => {
      const fault = this.activeFault();
      let cost = this.costMs(inputs.length);
      if (fault.mode === "slow") cost += fault.extraLatencyMs;
      await sleep(cost);
      this.calls++;
      this.items += inputs.length;
      if (fault.mode === "error") throw new BackendError("injected fault: backend error");
      if (fault.mode === "flaky" && this.rand() < fault.failureRate) throw new BackendError("injected fault: flaky backend");
      return inputs.map(StubBackend.fakeOutput);
    });
  }

  describe() {
    const f = this.activeFault();
    return {
      backend: this.name,
      base_ms: this.baseMs,
      per_item_ms: this.perItemMs,
      jitter_ms: this.jitterMs,
      concurrency: this.concurrency,
      calls: this.calls,
      items: this.items,
      fault: {
        mode: f.mode,
        failure_rate: f.failureRate,
        extra_latency_ms: f.extraLatencyMs,
        remaining_s: f.until !== null ? Math.round((f.until - monotonicS()) * 10) / 10 : null,
      },
    };
  }
}

type Classifier = (texts: string[]) => Promise<unknown[]>;

export class HFBackend implements ModelBackend {
  readonly name = "hf";
  calls = 0;
  items = 0;
  private readonly device: Semaphore;

  private constructor(private readonly pipe: Classifier, readonly model: string, readonly task: string, readonly concurrency: number) {
    this.device = new Semaphore(Math.max(1, concurrency));
  }

  static async load(model: string, task: string, concurrency = 1, log: (msg: string) => void = () => {}): Promise<HFBackend> {
    const { pipeline } = await loadTransformers();
    const pipe = (await pipeline(task as "sentiment-analysis", model, {
      progress_callback: downloadLogger(model, log),
    })) as unknown as Classifier;
    return new HFBackend(pipe, model, task, concurrency);
  }

  inferBatch(inputs: string[]): Promise<Output[]> {
    return this.device.run(async () => {
      let out: unknown[];
      try {
        // One forward pass for the whole batch.
        out = await this.pipe(inputs);
      } catch (err) {
        throw new BackendError(`${(err as Error).name}: ${(err as Error).message}`);
      }
      this.calls++;
      this.items += inputs.length;
      return inputs.map((text, i) => {
        let r = out[i];
        if (Array.isArray(r)) r = r[0];
        const row: Output = r && typeof r === "object" ? { ...(r as object) } : { result: r };
        row.echo = text.slice(0, 120);
        return row;
      });
    });
  }

  describe() {
    return { backend: this.name, model: this.model, task: this.task, concurrency: this.concurrency, calls: this.calls, items: this.items, fault: null };
  }
}
