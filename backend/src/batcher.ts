import { randomUUID } from "node:crypto";
import { AsyncQueue, Semaphore, TimeoutError, now, withTimeout } from "./async.js";

export class QueueFullError extends Error { override name = "QueueFullError"; }
export class BatcherClosedError extends Error { override name = "BatcherClosedError"; }
export class BatchTimeoutError extends Error { override name = "BatchTimeoutError"; }
export class BatchSizeMismatchError extends Error { override name = "BatchSizeMismatchError"; }
export class RequestTimeoutError extends Error { override name = "RequestTimeoutError"; }

export type DispatchReason = "full" | "window" | "unbatched" | "shutdown";

export type BatchInfo = {
  batchId: string;
  batchSize: number;
  queueWaitMs: number; // this request: enqueue -> dispatch
  processMs: number;   // the one backend call, shared by the whole batch
  dispatchReason: DispatchReason;
};

export type BatchMeta = {
  batchId: string;
  batchSize: number;
  processMs: number;
  dispatchReason: DispatchReason;
  windowMs: number;
  meanQueueWaitMs: number;
  maxQueueWaitMs: number;
};

type Pending<T, R> = {
  item: T;
  enqueuedAt: number;
  resolve: (v: [R, BatchInfo]) => void;
  reject: (e: unknown) => void;
  /** Settled already: answered, failed, or the caller gave up. */
  done: boolean;
};

const SENTINEL = Symbol("shutdown");

export type BatcherOptions<T> = {
  windowMs: () => number;
  maxBatchSize: () => number;
  enabled?: () => boolean;
  adaptive?: () => boolean;
  minWindowMs?: () => number;
  maxInflight?: number;
  queueMax?: number;
  batchTimeoutMs?: number;
  /** Runs once per batch, before any caller is resumed. */
  onBatch?: (items: T[], meta: BatchMeta, error: Error | null) => void;
};

export class DynamicBatcher<T, R> {
  readonly maxInflight: number;
  private queue: AsyncQueue<Pending<T, R> | typeof SENTINEL>;
  private slots: Semaphore;
  private loop: Promise<void> | null = null;
  private tasks = new Set<Promise<void>>();
  private closing = false;

  /** Exponentially weighted mean batch size; drives the adaptive window. */
  private ewmaSize = 1;
  inflight = 0;
  batches = 0;
  items = 0;
  abandoned = 0;
  failedBatches = 0;
  readonly reasons: Record<DispatchReason, number> = { full: 0, window: 0, unbatched: 0, shutdown: 0 };

  constructor(
    readonly name: string,
    private process: (items: T[]) => Promise<R[]>,
    private readonly opts: BatcherOptions<T>,
  ) {
    this.maxInflight = opts.maxInflight ?? 1;
    if (this.maxInflight < 1) throw new RangeError("maxInflight must be >= 1");
    this.queue = new AsyncQueue(opts.queueMax ?? 1000);
    this.slots = new Semaphore(this.maxInflight);
  }

  /** Swap the processing function (tests use this to heal a failing backend). */
  setProcess(fn: (items: T[]) => Promise<R[]>): void {
    this.process = fn;
  }

  // ------------------------------------------------------------ lifecycle
  start(): void {
    if (this.loop) return;
    this.closing = false;
    this.loop = this.run();
  }

  get running(): boolean {
    return this.loop !== null;
  }

  /** Graceful: stop accepting, finish everything already queued, wait for the
   *  in-flight batches, then exit. */
  async stop(timeoutMs = 30_000): Promise<void> {
    if (!this.loop) return;
    this.closing = true;
    // Queued behind every real item, so they all drain first.
    this.queue.forcePut(SENTINEL);
    try {
      await withTimeout(this.loop, timeoutMs, "batcher loop did not stop");
      await withTimeout(Promise.allSettled([...this.tasks]).then(() => undefined), timeoutMs, "batches did not finish");
    } catch {
      // Give up on stragglers: fail anything still waiting.
      let p: Pending<T, R> | typeof SENTINEL | undefined;
      while ((p = this.queue.tryTake()) !== undefined) {
        if (p !== SENTINEL && !p.done) {
          p.done = true;
          p.reject(new BatcherClosedError("batcher stopped"));
        }
      }
    } finally {
      this.loop = null;
    }
  }

  // --------------------------------------------------------------- submit
  get queueDepth(): number {
    return this.queue.size;
  }

  submit(item: T, opts: { timeoutMs?: number } = {}): Promise<[R, BatchInfo]> {
    if (this.closing || !this.loop) {
      return Promise.reject(new BatcherClosedError(`batcher '${this.name}' is not accepting work`));
    }
    return new Promise<[R, BatchInfo]>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const p: Pending<T, R> = {
        item,
        enqueuedAt: now(),
        done: false,
        resolve: (v) => { if (timer) clearTimeout(timer); resolve(v); },
        reject: (e) => { if (timer) clearTimeout(timer); reject(e); },
      };
      if (!this.queue.tryPut(p)) {
        reject(new QueueFullError(`batcher '${this.name}' queue is full (${this.queue.maxSize})`));
        return;
      }
      if (opts.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          if (p.done) return;
          p.done = true;
          reject(new RequestTimeoutError(`no result within ${opts.timeoutMs} ms`));
        }, opts.timeoutMs);
      }
    });
  }

  // ----------------------------------------------------------------- core
  effectiveWindowMs(): number {
    const window = this.opts.windowMs();
    if (!(this.opts.adaptive?.() ?? false)) return window;
    // Scale by how full recent batches were. Light load (batches of ~1) waits
    // near the minimum; under load batches fill and the window opens back up.
    const fill = Math.min(1, this.ewmaSize / Math.max(1, this.opts.maxBatchSize()));
    return Math.max(this.opts.minWindowMs?.() ?? 0, Math.min(window, window * fill * 2));
  }

  private async run(): Promise<void> {
    let stop = false;
    while (!stop) {
      await this.slots.acquire();
      let dispatched = false;
      const batch: Pending<T, R>[] = [];
      try {
        const first = await this.queue.take();
        if (first === SENTINEL || first === undefined) {
          stop = true;
          continue; // finally releases the slot
        }
        const enabled = this.opts.enabled?.() ?? true;
        const maxSize = enabled ? Math.max(1, Math.floor(this.opts.maxBatchSize())) : 1;
        const windowMs = enabled ? this.effectiveWindowMs() : 0;

        if (first.done) this.abandoned++;
        else batch.push(first);

        // The window opens when the first request is in hand.
        const deadline = now() + windowMs;
        let reason: DispatchReason = enabled ? "full" : "unbatched";
        while (batch.length < maxSize) {
          // Take what is already queued without waiting: under load the
          // backlog fills the batch at zero extra latency.
          let next = this.queue.tryTake();
          if (next === undefined) {
            const remaining = deadline - now();
            if (remaining <= 0) { reason = "window"; break; }
            next = await this.queue.take(remaining);
            if (next === undefined) { reason = "window"; break; }
          }
          if (next === SENTINEL) { stop = true; reason = "shutdown"; break; }
          if (next.done) { this.abandoned++; continue; }
          batch.push(next);
        }
        if (!batch.length) continue;
        this.dispatch(batch, reason, windowMs);
        dispatched = true;
      } catch (err) {
        // A bug in batch formation must not strand callers or kill the loop.
        for (const p of batch) if (!p.done) { p.done = true; p.reject(err); }
      } finally {
        if (!dispatched) this.slots.release();
      }
    }
  }

  private dispatch(batch: Pending<T, R>[], reason: DispatchReason, windowMs: number): void {
    const dispatchedAt = now();
    const batchId = randomUUID().replaceAll("-", "").slice(0, 12);
    this.batches++;
    this.items += batch.length;
    this.reasons[reason]++;
    this.ewmaSize = 0.8 * this.ewmaSize + 0.2 * batch.length;
    this.inflight++;
    const task = this.execute(batch, batchId, reason, windowMs, dispatchedAt);
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task));
  }

  private async execute(
    batch: Pending<T, R>[], batchId: string, reason: DispatchReason, windowMs: number, dispatchedAt: number,
  ): Promise<void> {
    const items = batch.map((p) => p.item);
    const waits = batch.map((p) => dispatchedAt - p.enqueuedAt);
    let results: R[] | null = null;
    let error: Error | null = null;
    const t0 = now();
    try {
      const call = this.process(items);
      results = this.opts.batchTimeoutMs
        ? await withTimeout(call, this.opts.batchTimeoutMs, `batch ${batchId} exceeded ${this.opts.batchTimeoutMs} ms`)
        : await call;
      if (!Array.isArray(results) || results.length !== batch.length) {
        throw new BatchSizeMismatchError(
          `backend returned ${Array.isArray(results) ? results.length : 0} results for ${batch.length} inputs`,
        );
      }
    } catch (err) {
      error = err instanceof TimeoutError
        ? new BatchTimeoutError(err.message)
        : err instanceof Error ? err : new Error(String(err));
    }
    const processMs = now() - t0;
    if (error) this.failedBatches++;
    try {
      this.opts.onBatch?.(items, {
        batchId, batchSize: batch.length, processMs, dispatchReason: reason, windowMs,
        meanQueueWaitMs: waits.reduce((a, b) => a + b, 0) / waits.length,
        maxQueueWaitMs: Math.max(...waits),
      }, error);
    } catch {
      // Instrumentation must never fail a batch.
    }
    batch.forEach((p, i) => {
      if (p.done) return; // caller already gave up
      p.done = true;
      if (error) p.reject(error);
      else p.resolve([results![i]!, { batchId, batchSize: batch.length, queueWaitMs: waits[i]!, processMs, dispatchReason: reason }]);
    });
    this.inflight--;
    this.slots.release();
  }

  snapshot() {
    const enabled = this.opts.enabled?.() ?? true;
    return {
      name: this.name,
      enabled,
      window_ms: this.opts.windowMs(),
      effective_window_ms: Math.round(this.effectiveWindowMs() * 1000) / 1000,
      max_batch_size: this.opts.maxBatchSize(),
      queue_depth: this.queueDepth,
      queue_max: this.queue.maxSize,
      inflight: this.inflight,
      max_inflight: this.maxInflight,
      batches: this.batches,
      items: this.items,
      mean_batch_size: this.batches ? this.items / this.batches : 0,
      recent_mean_batch_size: Math.round(this.ewmaSize * 1000) / 1000,
      abandoned: this.abandoned,
      failed_batches: this.failedBatches,
      dispatch_reasons: { ...this.reasons },
    };
  }
}
