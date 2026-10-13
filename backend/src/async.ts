/** Small concurrency primitives Node does not ship with. Everything here runs
 *  on the single event loop, so there are no data races, only interleavings
 *  at `await` points. */

export const now = (): number => performance.now(); // ms, monotonic
export const monotonicS = (): number => performance.now() / 1000;
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class TimeoutError extends Error {
  override name = "TimeoutError";
}

/** Reject if `p` has not settled within `ms`. Does not cancel `p`. */
export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export class Semaphore {
  private waiters: (() => void)[] = [];
  constructor(private permits: number) {
    if (permits < 1) throw new RangeError("permits must be >= 1");
  }
  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    await new Promise<void>((r) => this.waiters.push(r));
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) next(); // hand the permit straight to a waiter
    else this.permits++;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/** Bounded FIFO with awaitable, optionally time-limited takes.
 *  A timed-out take is removed from the waiter list before it can be handed
 *  an item, so no item is ever lost to a waiter that gave up. */
export class AsyncQueue<T> {
  private items: T[] = [];
  private head = 0;
  private waiters: { resolve: (v: T | undefined) => void; timer?: NodeJS.Timeout }[] = [];

  constructor(readonly maxSize: number) {}

  get size(): number {
    return this.items.length - this.head;
  }

  /** Returns false when full: the caller sheds load instead of waiting. */
  tryPut(item: T): boolean {
    const w = this.waiters.shift();
    if (w) {
      if (w.timer) clearTimeout(w.timer);
      w.resolve(item);
      return true;
    }
    if (this.size >= this.maxSize) return false;
    this.items.push(item);
    return true;
  }

  /** Always enqueues, even past maxSize. Used for the shutdown sentinel. */
  forcePut(item: T): void {
    if (!this.tryPut(item)) this.items.push(item);
  }

  tryTake(): T | undefined {
    if (this.size === 0) return undefined;
    const item = this.items[this.head]!;
    this.items[this.head] = undefined as T;
    this.head++;
    if (this.head > 1024 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head); // compact occasionally: O(1) amortised
      this.head = 0;
    }
    return item;
  }

  /** Resolve with the next item, or undefined if `timeoutMs` passes first. */
  take(timeoutMs?: number): Promise<T | undefined> {
    const ready = this.tryTake();
    if (ready !== undefined) return Promise.resolve(ready);
    if (timeoutMs !== undefined && timeoutMs <= 0) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const w: { resolve: (v: T | undefined) => void; timer?: NodeJS.Timeout } = { resolve };
      if (timeoutMs !== undefined) {
        w.timer = setTimeout(() => {
          const i = this.waiters.indexOf(w);
          if (i >= 0) this.waiters.splice(i, 1);
          resolve(undefined);
        }, timeoutMs);
      }
      this.waiters.push(w);
    });
  }
}
