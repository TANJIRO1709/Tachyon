/**
 * Semantic cache: embedding-similarity lookup with TTL and LRU eviction.
 *
 * Design
 * ------
 * Three structures kept in lockstep, indexed by *slot*:
 *
 * - `matrix`  one pre-allocated Float32Array of capacity x dim, holding
 *   L2-normalised embeddings. Rows are unit vectors, so cosine similarity is a
 *   plain dot product and a lookup is one pass over the live rows.
 * - `entries` per-slot metadata (query, response, timestamps, hits).
 * - `lru`     a Map of slot -> true. JS Maps iterate in insertion order, so
 *   delete + re-set moves a slot to the most-recent end, and the first key is
 *   the least recently used. Both are O(1).
 *
 * Freed slots go on a min-heap, so new entries reuse the lowest free row and
 * the scanned region [0, highWater) stays as compact as possible.
 *
 * Why brute force instead of an ANN index: at 10k x 384 a scan is ~4M
 * multiply-adds, measured at 5.5 ms on a 2.1 GHz cloud vCPU. That runs on the
 * event loop, so it is the main CPU cost per request; it grows linearly with
 * capacity (44 ms at 50k). Past ~10k entries, move the scan to a worker thread,
 * WebAssembly SIMD, or an HNSW index.
 *
 * Every method is synchronous and the server runs one event loop, so no method
 * can interleave with another. No locks.
 */

export type Clock = () => number; // seconds

type Entry = {
  query: string;
  response: unknown;
  createdAt: number;
  expiresAt: number;
  hits: number;
  lastHitAt: number | null;
};

export type CacheHit = {
  kind: "hit";
  response: unknown;
  similarity: number;
  matchedQuery: string;
  ageS: number;
  slot: number;
};

export type CacheMiss = {
  kind: "miss";
  /** Best similarity among live entries, even though below the threshold.
   *  Logged so near-misses are visible when tuning the threshold. */
  bestSimilarity: number | null;
  expiredSkipped: number;
  /** Write sequence number at scan time, and the nearest live row then.
   *  Lets `put` dedupe without scanning the whole matrix again. */
  seenAt: number;
  nearest: { slot: number; similarity: number } | null;
};

class MinHeap {
  private a: number[] = [];
  get size() { return this.a.length; }
  push(v: number) {
    const a = this.a;
    a.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p]! <= a[i]!) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  pop(): number | undefined {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l]! < a[m]!) m = l;
        if (r < a.length && a[r]! < a[m]!) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
}

export class SemanticCache {
  readonly capacity: number;
  readonly dim: number;
  ttlS: number;
  readonly topK: number;
  readonly dedupeThreshold: number;
  private readonly clock: Clock;

  private readonly matrix: Float32Array;
  private readonly live: Uint8Array;
  private readonly entries: (Entry | null)[];
  private readonly lru = new Map<number, true>();
  private readonly free = new MinHeap();
  private highWater = 0;

  readonly stats = {
    lookups: 0, hits: 0, misses: 0, degradedHits: 0, expiredOnRead: 0,
    evictionsLru: 0, evictionsTtl: 0, inserts: 0, updates: 0,
    similaritySum: 0, degradedSimilaritySum: 0,
  };

  constructor(opts: {
    capacity: number; dim: number; ttlS: number; topK?: number; dedupeThreshold?: number; clock?: Clock;
  }) {
    if (opts.capacity < 1) throw new RangeError("capacity must be >= 1");
    if (opts.dim < 1) throw new RangeError("dim must be >= 1");
    this.capacity = opts.capacity;
    this.dim = opts.dim;
    this.ttlS = opts.ttlS;
    this.topK = Math.max(1, opts.topK ?? 5);
    this.dedupeThreshold = opts.dedupeThreshold ?? 0.995;
    this.clock = opts.clock ?? (() => performance.now() / 1000);
    this.matrix = new Float32Array(opts.capacity * opts.dim);
    this.live = new Uint8Array(opts.capacity);
    this.slotSeqArr = new Float64Array(opts.capacity);
    this.entries = new Array(opts.capacity).fill(null);
    for (let i = 0; i < opts.capacity; i++) this.free.push(i);
  }

  get size(): number {
    return this.lru.size;
  }

  // ---------------------------------------------------------------- utils
  private normalise(vec: ArrayLike<number>): Float32Array {
    if (vec.length !== this.dim) throw new RangeError(`expected dim ${this.dim}, got ${vec.length}`);
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i]! * vec[i]!;
    norm = Math.sqrt(norm);
    if (norm === 0 || !Number.isFinite(norm)) throw new RangeError("cannot cache a zero or non-finite vector");
    const out = new Float32Array(this.dim);
    for (let i = 0; i < vec.length; i++) out[i] = vec[i]! / norm;
    return out;
  }

  private freeSlot(slot: number): void {
    this.live[slot] = 0;
    this.entries[slot] = null;
    this.lru.delete(slot);
    this.free.push(slot);
    while (this.highWater > 0 && !this.live[this.highWater - 1]) this.highWater--;
  }

  private touch(slot: number): void {
    this.lru.delete(slot);
    this.lru.set(slot, true);
  }

  /** Dot product of q with one row. Four independent accumulators let the CPU
   *  overlap the multiply-adds instead of waiting on one running sum. Measured
   *  about 10% faster than the naive loop in V8; JavaScript has no SIMD, so a
   *  10,000 x 384 scan has a floor of roughly 4-5 ms on a 2 GHz core. */
  private rowDot(row: number, q: Float32Array): number {
    const m = this.matrix;
    const d = this.dim;
    const base = row * d;
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
    let j = 0;
    for (; j + 3 < d; j += 4) {
      s0 += m[base + j]! * q[j]!;
      s1 += m[base + j + 1]! * q[j + 1]!;
      s2 += m[base + j + 2]! * q[j + 2]!;
      s3 += m[base + j + 3]! * q[j + 3]!;
    }
    for (; j < d; j++) s0 += m[base + j]! * q[j]!;
    return s0 + s1 + s2 + s3;
  }

  /** One pass over the live rows below the high-water mark, keeping the k best
   *  (slot, similarity) pairs in a small sorted array. No per-row allocation.
   *  Returned best first. */
  private scanTopK(q: Float32Array, k: number): { slots: number[]; sims: number[] } {
    const slots: number[] = [];
    const sims: number[] = [];
    const live = this.live;
    for (let r = 0, n = this.highWater; r < n; r++) {
      if (!live[r]) continue;
      const s = this.rowDot(r, q);
      if (slots.length === k && s <= sims[k - 1]!) continue;
      let i = slots.length < k ? slots.length : k - 1;
      while (i > 0 && sims[i - 1]! < s) {
        if (i < k) {
          sims[i] = sims[i - 1]!;
          slots[i] = slots[i - 1]!;
        }
        i--;
      }
      sims[i] = s;
      slots[i] = r;
      if (slots.length > k) {
        slots.length = k;
        sims.length = k;
      }
    }
    return { slots, sims };
  }

  /** Every write bumps `seq` and is remembered here, newest last, so an insert
   *  can check only the rows written since its own lookup (see `put`). */
  private seq = 0;
  private slotSeqArr: Float64Array;
  private writes: { seq: number; slot: number }[] = [];
  private static readonly WRITE_LOG = 4096;

  private noteWrite(slot: number): number {
    const s = ++this.seq;
    this.slotSeqArr[slot] = s;
    this.writes.push({ seq: s, slot });
    // Keep the newest WRITE_LOG entries; trim in bulk so it is O(1) amortised.
    if (this.writes.length > SemanticCache.WRITE_LOG * 2) this.writes = this.writes.slice(-SemanticCache.WRITE_LOG);
    return s;
  }

  // --------------------------------------------------------------- lookup
  /**
   * Most similar live, unexpired entry at or above `threshold`.
   *
   * Takes the top-k candidates rather than the single nearest, so an expired
   * nearest neighbour does not force a model call when a valid near-match sits
   * right behind it. Expired candidates are evicted on the way (lazy TTL).
   *
   * `record: false` is used for the relaxed fallback during an outage: that
   * request already counted as a miss, and counting it again would distort the
   * hit rate. The caller reports it through `noteDegradedHit`.
   */
  lookup(vec: ArrayLike<number>, threshold: number, opts: { record?: boolean } = {}): CacheHit | CacheMiss {
    const record = opts.record ?? true;
    const q = this.normalise(vec);
    const t = this.clock();
    const seenAt = this.seq;
    const { slots, sims } = this.scanTopK(q, this.topK);
    const nearest = slots.length ? { slot: slots[0]!, similarity: sims[0]! } : null;

    let bestLive: number | null = null;
    let expired = 0;
    for (let c = 0; c < slots.length; c++) {
      const slot = slots[c]!;
      const sim = sims[c]!;
      if (sim < threshold) {
        // Sorted best-first: nothing after this can qualify.
        if (bestLive === null) bestLive = sim;
        break;
      }
      const entry = this.entries[slot]!;
      if (t >= entry.expiresAt) {
        this.freeSlot(slot);
        expired++;
        if (record) {
          this.stats.evictionsTtl++;
          this.stats.expiredOnRead++;
        }
        continue;
      }
      this.touch(slot);
      entry.hits++;
      entry.lastHitAt = t;
      if (record) {
        this.stats.lookups++;
        this.stats.hits++;
        this.stats.similaritySum += sim;
      }
      return { kind: "hit", response: entry.response, similarity: sim, matchedQuery: entry.query, ageS: t - entry.createdAt, slot };
    }
    if (record) {
      this.stats.lookups++;
      this.stats.misses++;
    }
    return { kind: "miss", bestSimilarity: bestLive, expiredSkipped: expired, seenAt, nearest };
  }

  noteDegradedHit(similarity: number): void {
    this.stats.degradedHits++;
    this.stats.degradedSimilaritySum += similarity;
  }

  // --------------------------------------------------------------- insert
  /** The most similar live row, for the dedupe check in `put`.
   *
   *  Without a hint this is a full scan. With the miss from this request's own
   *  lookup it is incremental: the lookup already knows the nearest row as of
   *  `seenAt`, so only rows written since then need checking. Usually that is a
   *  handful, which turns the second full scan per miss into almost nothing.
   *  Those recent writes are exactly the concurrent misses for the same
   *  question that dedupe exists to catch. If the write log has rolled past
   *  `seenAt`, fall back to a full scan. */
  private nearestLive(q: Float32Array, hint?: CacheMiss): { slot: number; similarity: number } | null {
    const oldestLogged = this.writes.length ? this.writes[0]!.seq : this.seq + 1;
    if (!hint || hint.seenAt + 1 < oldestLogged) {
      const { slots, sims } = this.scanTopK(q, 1);
      return slots.length ? { slot: slots[0]!, similarity: sims[0]! } : null;
    }
    let best: { slot: number; similarity: number } | null = null;
    const h = hint.nearest;
    // The hinted row still counts if it is live and untouched since the scan.
    if (h && this.live[h.slot] && this.slotSeqArr[h.slot]! <= hint.seenAt) best = h;
    for (let i = this.writes.length - 1; i >= 0; i--) {
      const w = this.writes[i]!;
      if (w.seq <= hint.seenAt) break;
      if (!this.live[w.slot] || this.slotSeqArr[w.slot] !== w.seq) continue; // stale log entry
      const s = this.rowDot(w.slot, q);
      if (!best || s > best.similarity) best = { slot: w.slot, similarity: s };
    }
    return best;
  }

  /** Insert or refresh. Returns the slot used. A near-identical query that is
   *  already cached is refreshed in place rather than duplicated: concurrent
   *  misses for one question would otherwise fill the cache with copies.
   *  Pass the CacheMiss from this request's lookup to make the check cheap. */
  put(vec: ArrayLike<number>, query: string, response: unknown, hint?: CacheMiss): number {
    const q = this.normalise(vec);
    const t = this.clock();
    const near = this.nearestLive(q, hint);
    if (near && near.similarity >= this.dedupeThreshold) {
      const best = near.slot;
      const e = this.entries[best]!;
      this.matrix.set(q, best * this.dim);
      e.query = query;
      e.response = response;
      e.createdAt = t;
      e.expiresAt = t + this.ttlS;
      this.touch(best);
      this.noteWrite(best);
      this.stats.updates++;
      return best;
    }

    if (this.free.size === 0) {
      const victim = this.lru.keys().next().value as number; // least recently used
      this.freeSlot(victim);
      this.stats.evictionsLru++;
    }
    const slot = this.free.pop()!;
    this.matrix.set(q, slot * this.dim);
    this.live[slot] = 1;
    this.entries[slot] = { query, response, createdAt: t, expiresAt: t + this.ttlS, hits: 0, lastHitAt: null };
    this.touch(slot);
    this.noteWrite(slot);
    this.highWater = Math.max(this.highWater, slot + 1);
    this.stats.inserts++;
    return slot;
  }

  // ---------------------------------------------------------- maintenance
  sweepExpired(): number {
    const t = this.clock();
    let removed = 0;
    for (const slot of [...this.lru.keys()]) {
      const e = this.entries[slot];
      if (e && t >= e.expiresAt) {
        this.freeSlot(slot);
        removed++;
      }
    }
    this.stats.evictionsTtl += removed;
    return removed;
  }

  clear(): number {
    const n = this.lru.size;
    for (const slot of [...this.lru.keys()]) this.freeSlot(slot);
    return n;
  }

  /** Least to most recently used. For tests and debugging. */
  lruOrder(): string[] {
    return [...this.lru.keys()].map((s) => this.entries[s]!.query);
  }

  snapshot() {
    const s = this.stats;
    const decided = s.hits + s.misses;
    return {
      entries: this.lru.size,
      capacity: this.capacity,
      fill_ratio: this.lru.size / this.capacity,
      ttl_s: this.ttlS,
      lookups: s.lookups,
      hits: s.hits,
      misses: s.misses,
      degraded_hits: s.degradedHits,
      hit_rate: decided ? s.hits / decided : 0,
      avg_hit_similarity: s.hits ? s.similaritySum / s.hits : null,
      avg_degraded_hit_similarity: s.degradedHits ? s.degradedSimilaritySum / s.degradedHits : null,
      // Every request answered from cache is one the model did not run,
      // whether a normal hit or a relaxed hit during an outage.
      inference_calls_saved: s.hits + s.degradedHits,
      evictions_lru: s.evictionsLru,
      evictions_ttl: s.evictionsTtl,
      inserts: s.inserts,
      updates: s.updates,
      matrix_bytes: this.matrix.byteLength,
    };
  }

  recentEntries(limit = 20) {
    const t = this.clock();
    return [...this.lru.keys()].reverse().slice(0, limit).map((slot) => {
      const e = this.entries[slot]!;
      return {
        query: e.query,
        hits: e.hits,
        age_s: Math.round((t - e.createdAt) * 100) / 100,
        ttl_remaining_s: Math.round(Math.max(0, e.expiresAt - t) * 100) / 100,
      };
    });
  }
}
