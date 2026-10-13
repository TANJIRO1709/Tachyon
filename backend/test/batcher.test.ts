/** Dynamic batcher: triggers, per-request correlation, failure propagation,
 *  backpressure, abandonment and shutdown. Real timers, real concurrency. */
import { afterEach, describe, expect, it } from "vitest";
import { sleep } from "../src/async.js";
import {
  BatchSizeMismatchError, BatchTimeoutError, BatcherClosedError, BatcherOptions, DynamicBatcher, QueueFullError, RequestTimeoutError,
} from "../src/batcher.js";
import { StubBackend } from "../src/modelBackend.js";

const running: DynamicBatcher<any, any>[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.stop(2000);
});

function recorder(delayMs = 0, transform = (x: number) => x * 10) {
  const calls: number[][] = [];
  const process = async (items: number[]) => {
    calls.push([...items]);
    if (delayMs) await sleep(delayMs);
    return items.map(transform);
  };
  return { process, calls };
}

function make<T, R>(process: (items: T[]) => Promise<R[]>, o: Partial<BatcherOptions<T>> = {}) {
  const b = new DynamicBatcher<T, R>("t", process, { windowMs: () => 50, maxBatchSize: () => 8, ...o });
  b.start();
  running.push(b);
  return b;
}

describe("correlation", () => {
  it("gives every caller its own result", async () => {
    const { process, calls } = recorder(10);
    const b = make(process, { maxBatchSize: () => 16 });
    const results = await Promise.all(Array.from({ length: 200 }, (_, i) => b.submit(i)));
    expect(results.map(([r]) => r)).toEqual(Array.from({ length: 200 }, (_, i) => i * 10));
    expect(calls.flat().length).toBe(200);
    expect(Math.max(...calls.map((c) => c.length))).toBeGreaterThan(1);
  });

  it("routes correctly with staggered arrivals through the real stub", async () => {
    const stub = new StubBackend({ baseMs: 5, perItemMs: 0.1, jitterMs: 2, seed: 1 });
    const b = make((t: string[]) => stub.inferBatch(t), { maxBatchSize: () => 32 });
    const texts = Array.from({ length: 150 }, (_, i) => `input number ${i}`);
    const rows = await Promise.all(texts.map(async (t, i) => {
      await sleep((i * 7) % 13);
      const [out, info] = await b.submit(t);
      return { t, out, info };
    }));
    for (const { t, out, info } of rows) {
      expect(out.echo).toBe(t);
      expect(out).toEqual(StubBackend.fakeOutput(t));
      expect(info.batchSize).toBeGreaterThanOrEqual(1);
      expect(info.batchSize).toBeLessThanOrEqual(32);
    }
  });
});

describe("triggers", () => {
  it("dispatches a full batch before the window closes", async () => {
    const { process, calls } = recorder();
    const b = make(process, { windowMs: () => 2000, maxBatchSize: () => 4 });
    const t0 = performance.now();
    const results = await Promise.all([0, 1, 2, 3].map((i) => b.submit(i)));
    expect(performance.now() - t0).toBeLessThan(500);
    expect(calls).toEqual([[0, 1, 2, 3]]);
    expect(results[0]![1].dispatchReason).toBe("full");
  });

  it("dispatches a partial batch when the window closes", async () => {
    const { process, calls } = recorder();
    const b = make(process, { windowMs: () => 80, maxBatchSize: () => 64 });
    const t0 = performance.now();
    const [[, info]] = await Promise.all([b.submit(1), b.submit(2)]);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(70);
    expect(elapsed).toBeLessThan(400);
    expect(calls).toEqual([[1, 2]]);
    expect(info.dispatchReason).toBe("window");
    expect(info.queueWaitMs).toBeGreaterThanOrEqual(70);
  });

  it("starts the window at the first item, not when idle", async () => {
    const { process, calls } = recorder();
    const b = make(process, { windowMs: () => 60, maxBatchSize: () => 64 });
    await sleep(200);
    await Promise.all([b.submit(1), sleep(30).then(() => b.submit(2))]);
    expect(calls).toEqual([[1, 2]]);
  });

  it("sends one at a time when batching is off", async () => {
    const { process, calls } = recorder();
    const b = make(process, { enabled: () => false });
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => b.submit(i)));
    expect(calls.every((c) => c.length === 1)).toBe(true);
    expect(new Set(results.map(([, i]) => i.dispatchReason))).toEqual(new Set(["unbatched"]));
  });

  it("forms full batches from the backlog while the device is busy", async () => {
    const { process, calls } = recorder(50);
    const b = make(process, { windowMs: () => 1, maxBatchSize: () => 8, maxInflight: 1 });
    await Promise.all(Array.from({ length: 33 }, (_, i) => b.submit(i)));
    const sizes = calls.map((c) => c.length);
    expect(sizes.slice(1, -1).every((s) => s === 8)).toBe(true);
  });

  it("respects maxInflight", async () => {
    let active = 0;
    let peak = 0;
    const b = make(async (items: number[]) => {
      active++;
      peak = Math.max(peak, active);
      await sleep(20);
      active--;
      return items;
    }, { windowMs: () => 1, maxBatchSize: () => 2, maxInflight: 2 });
    await Promise.all(Array.from({ length: 40 }, (_, i) => b.submit(i)));
    expect(peak).toBe(2);
  });

  it("applies runtime config changes", async () => {
    const size = { v: 2 };
    const { process, calls } = recorder();
    const b = make(process, { windowMs: () => 1000, maxBatchSize: () => size.v });
    await Promise.all([0, 1].map((i) => b.submit(i)));
    size.v = 5;
    await Promise.all([0, 1, 2, 3, 4].map((i) => b.submit(i)));
    expect(calls.map((c) => c.length)).toEqual([2, 5]);
  });
});

describe("failures", () => {
  it("delivers a batch failure to every caller and keeps serving", async () => {
    const b = make(async () => { throw new Error("model exploded"); }, { windowMs: () => 20 });
    const res = await Promise.allSettled([0, 1, 2, 3, 4].map((i) => b.submit(i)));
    expect(res.every((r) => r.status === "rejected" && (r.reason as Error).message === "model exploded")).toBe(true);
    expect(b.failedBatches).toBeGreaterThanOrEqual(1);
    b.setProcess(recorder().process as any);
    expect((await b.submit(3))[0]).toBe(30);
  });

  it("errors on a result-count mismatch instead of misrouting", async () => {
    const b = make(async (items: number[]) => items.slice(0, -1), { windowMs: () => 20 });
    const res = await Promise.allSettled([0, 1, 2].map((i) => b.submit(i)));
    expect(res.every((r) => r.status === "rejected" && r.reason instanceof BatchSizeMismatchError)).toBe(true);
  });

  it("times out a batch that never returns", async () => {
    const b = make(async (items: number[]) => { await sleep(5000); return items; }, { windowMs: () => 1, batchTimeoutMs: 50 });
    await expect(b.submit(1)).rejects.toBeInstanceOf(BatchTimeoutError);
  });

  it("runs the hook before callers resume", async () => {
    const seen: unknown[] = [];
    const { process } = recorder();
    const b = make(process, { windowMs: () => 10, onBatch: (items, meta, err) => seen.push([items, meta.batchSize, err]) });
    await Promise.all([b.submit(1), b.submit(2)]);
    expect(seen).toEqual([[[1, 2], 2, null]]);
  });
});

describe("backpressure and lifecycle", () => {
  it("sheds load when the queue is full", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const b = make(async (items: number[]) => { await gate; return items; }, { windowMs: () => 1, maxBatchSize: () => 1, queueMax: 3 });
    const first = b.submit(0); // occupies the device
    await sleep(20);
    const queued = [1, 2, 3].map((i) => b.submit(i));
    await expect(b.submit(99)).rejects.toBeInstanceOf(QueueFullError);
    open();
    await Promise.all([first, ...queued]);
  });

  it("skips an abandoned request instead of computing it", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const seen: string[][] = [];
    const b = make(async (items: string[]) => { seen.push([...items]); await gate; return items; }, { windowMs: () => 1, maxBatchSize: () => 8 });
    const first = b.submit("busy");
    await sleep(20);
    const doomed = b.submit("abandoned", { timeoutMs: 10 });
    const kept = b.submit("kept");
    await expect(doomed).rejects.toBeInstanceOf(RequestTimeoutError);
    open();
    expect((await kept)[0]).toBe("kept");
    await first;
    expect(seen.flat()).not.toContain("abandoned");
    expect(b.abandoned).toBe(1);
  });

  it("drains queued work on graceful stop, then refuses new work", async () => {
    const { process } = recorder(20);
    const b = new DynamicBatcher<number, number>("t", process, { windowMs: () => 5, maxBatchSize: () => 4 });
    b.start();
    const pending = Array.from({ length: 20 }, (_, i) => b.submit(i));
    await b.stop();
    const results = await Promise.all(pending);
    expect(results.map(([r]) => r).sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => i * 10));
    await expect(b.submit(1)).rejects.toBeInstanceOf(BatcherClosedError);
  });

  it("shrinks the adaptive window at low load", async () => {
    const { process } = recorder();
    const b = make(process, { windowMs: () => 50, maxBatchSize: () => 16, adaptive: () => true, minWindowMs: () => 5 });
    for (let i = 0; i < 10; i++) await b.submit(i);
    expect(b.effectiveWindowMs()).toBeLessThan(10);
  });
});
