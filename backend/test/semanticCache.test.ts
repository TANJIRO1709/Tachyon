import { describe, expect, it } from "vitest";
import { SemanticCache } from "../src/semanticCache.js";
import { FakeClock, atSimilarity, seededRandom, unit } from "./helpers.js";

const make = (clock: FakeClock, o: { capacity?: number; ttl?: number; dim?: number } = {}) =>
  new SemanticCache({ capacity: o.capacity ?? 4, dim: o.dim ?? 8, ttlS: o.ttl ?? 60, topK: 5, clock: clock.fn });

describe("similarity", () => {
  it("hits at or above the threshold and misses below, reporting the near miss", () => {
    const clock = new FakeClock();
    const c = make(clock);
    const base = unit([1, 0, 0]);
    c.put(base, "q", "answer");
    const hit = c.lookup(atSimilarity(base, 0.95), 0.92);
    expect(hit.kind).toBe("hit");
    if (hit.kind === "hit") {
      expect(hit.response).toBe("answer");
      expect(hit.similarity).toBeCloseTo(0.95, 4);
    }
    const miss = c.lookup(atSimilarity(base, 0.9), 0.92);
    expect(miss.kind).toBe("miss");
    if (miss.kind === "miss") expect(miss.bestSimilarity).toBeCloseTo(0.9, 4);
  });

  it("matches vectors it has never seen, not only identical ones", () => {
    const c = make(new FakeClock());
    const base = unit([3, 1, 0]);
    c.put(base, "original", "R");
    const probe = atSimilarity(base, 0.97);
    expect(Array.from(probe)).not.toEqual(Array.from(base));
    expect(c.lookup(probe, 0.92).kind).toBe("hit");
  });

  it("returns the most similar entry", () => {
    const c = make(new FakeClock());
    c.put(unit([1, 0, 0]), "a", "A");
    c.put(unit([0, 1, 0]), "b", "B");
    const r = c.lookup(unit([0.2, 1, 0]), 0.5);
    expect(r.kind === "hit" && r.response).toBe("B");
  });

  it("ignores vector magnitude", () => {
    const c = make(new FakeClock());
    c.put(unit([1, 2, 3]).map((x) => x * 50), "q", "R");
    expect(c.lookup(unit([1, 2, 3]).map((x) => x * 0.001), 0.999).kind).toBe("hit");
  });

  it("rejects zero and wrong-sized vectors", () => {
    const c = make(new FakeClock());
    expect(() => c.put(new Float32Array(8), "q", "R")).toThrow(RangeError);
    expect(() => c.put(new Float32Array(5).fill(1), "q", "R")).toThrow(RangeError);
  });

  it("misses on an empty cache", () => {
    const r = make(new FakeClock()).lookup(unit([1]), 0.5);
    expect(r).toMatchObject({ kind: "miss", bestSimilarity: null });
  });
});

describe("TTL", () => {
  it("treats an expired entry as a miss and evicts it", () => {
    const clock = new FakeClock();
    const c = make(clock, { ttl: 10 });
    const v = unit([1]);
    c.put(v, "q", "R");
    clock.advance(9.9);
    expect(c.lookup(v, 0.9).kind).toBe("hit");
    clock.advance(0.2);
    expect(c.lookup(v, 0.9).kind).toBe("miss");
    expect(c.size).toBe(0);
    expect(c.stats.evictionsTtl).toBe(1);
  });

  it("falls through an expired nearest neighbour to a valid one (top-k)", () => {
    const clock = new FakeClock();
    const c = make(clock, { ttl: 10 });
    const base = unit([1, 0, 0]);
    c.put(base, "old", "OLD");
    clock.advance(8);
    c.put(atSimilarity(base, 0.96), "newer", "NEW");
    clock.advance(3); // "old" expired, "newer" has 7 s left
    const r = c.lookup(base, 0.92);
    expect(r.kind === "hit" && r.response).toBe("NEW");
  });

  it("sweeps only expired entries", () => {
    const clock = new FakeClock();
    const c = make(clock, { ttl: 10 });
    c.put(unit([1, 0]), "a", "A");
    clock.advance(6);
    c.put(unit([0, 1]), "b", "B");
    clock.advance(5);
    expect(c.sweepExpired()).toBe(1);
    expect(c.lruOrder()).toEqual(["b"]);
  });
});

describe("LRU", () => {
  it("evicts the least recently USED, not the oldest inserted", () => {
    const c = make(new FakeClock(), { capacity: 3 });
    const [va, vb, vc, vd] = [unit([1]), unit([0, 1]), unit([0, 0, 1]), unit([0, 0, 0, 1])];
    c.put(va, "a", "A");
    c.put(vb, "b", "B");
    c.put(vc, "c", "C");
    expect(c.lookup(va, 0.99).kind).toBe("hit"); // touch a
    c.put(vd, "d", "D");
    expect(c.lruOrder()).toEqual(["c", "a", "d"]); // b evicted
    expect(c.lookup(vb, 0.99).kind).toBe("miss");
    expect(c.stats.evictionsLru).toBe(1);
    expect(c.size).toBe(3);
  });

  it("never exceeds capacity under churn", () => {
    const c = make(new FakeClock(), { capacity: 16, dim: 32 });
    const rnd = seededRandom(0);
    for (let i = 0; i < 500; i++) {
      c.put(Float32Array.from({ length: 32 }, () => rnd() - 0.5), `q${i}`, i);
      expect(c.size).toBeLessThanOrEqual(16);
    }
    expect(c.stats.evictionsLru).toBe(500 - 16);
  });

  it("reuses the lowest freed slot", () => {
    const c = make(new FakeClock(), { capacity: 4 });
    const slots = [0, 1, 2, 3].map((i) => c.put(unit([...Array(i).fill(0), 1]), `q${i}`, i));
    expect([...slots].sort()).toEqual([0, 1, 2, 3]);
    c.clear();
    expect(c.put(unit([1]), "x", "X")).toBe(0);
  });

  it("refreshes a near-duplicate instead of storing a copy", () => {
    const clock = new FakeClock();
    const c = make(clock, { ttl: 10 });
    const v = unit([1, 1]);
    c.put(v, "q", "old answer");
    clock.advance(9);
    c.put(v, "q again", "new answer");
    expect(c.size).toBe(1);
    clock.advance(5); // past the original TTL, inside the refreshed one
    const r = c.lookup(v, 0.9);
    expect(r.kind === "hit" && r.response).toBe("new answer");
  });
});

describe("metrics", () => {
  it("reports hit rate, mean hit similarity and calls saved", () => {
    const c = make(new FakeClock());
    const base = unit([1, 0, 0]);
    c.put(base, "q", "R");
    c.lookup(atSimilarity(base, 0.98), 0.9);
    c.lookup(atSimilarity(base, 0.94), 0.9);
    c.lookup(unit([0, 1, 0]), 0.9);
    const s = c.snapshot();
    expect([s.hits, s.misses]).toEqual([2, 1]);
    expect(s.hit_rate).toBeCloseTo(2 / 3);
    expect(s.avg_hit_similarity).toBeCloseTo(0.96, 3);
    expect(s.inference_calls_saved).toBe(2);
  });

  it("counts a degraded serve once, not as an extra lookup", () => {
    const c = make(new FakeClock());
    const base = unit([1, 0, 0]);
    c.put(base, "q", "R");
    const q = atSimilarity(base, 0.85);
    expect(c.lookup(q, 0.92).kind).toBe("miss");
    const hit = c.lookup(q, 0.8, { record: false });
    expect(hit.kind).toBe("hit");
    if (hit.kind === "hit") c.noteDegradedHit(hit.similarity);
    const s = c.snapshot();
    expect([s.lookups, s.misses, s.hits, s.degraded_hits, s.inference_calls_saved]).toEqual([1, 1, 0, 1, 1]);
    expect(s.avg_degraded_hit_similarity).toBeCloseTo(0.85, 3);
  });
});

describe("incremental dedupe on insert", () => {
  it("catches a concurrent insert of the same question made after the lookup", () => {
    const c = make(new FakeClock(), { capacity: 8 });
    const v = unit([1, 2]);
    const missA = c.lookup(v, 0.9);
    const missB = c.lookup(v, 0.9); // two concurrent misses for one question
    expect(missA.kind).toBe("miss");
    c.put(v, "first", "A", missA as any);
    c.put(v, "second", "B", missB as any); // must see the row written after its lookup
    expect(c.size).toBe(1);
    expect(c.stats.updates).toBe(1);
  });

  it("uses the hinted nearest row when nothing changed since the lookup", () => {
    const c = make(new FakeClock(), { capacity: 8 });
    const v = unit([1, 0, 1]);
    c.put(v, "q", "old");
    const miss = c.lookup(v, 1.01); // threshold above 1: always a miss, but it saw the row
    expect(miss.kind).toBe("miss");
    c.put(v, "q", "new", miss as any);
    expect(c.size).toBe(1);
    const r = c.lookup(v, 0.9);
    expect(r.kind === "hit" && r.response).toBe("new");
  });

  it("ignores a hinted row that was evicted and reused for something else", () => {
    const c = make(new FakeClock(), { capacity: 1 });
    const a = unit([1, 0]);
    const b = unit([0, 1]);
    c.put(a, "a", "A");
    const missForA = c.lookup(a, 1.01); // nearest = slot 0, holding "a"
    c.put(b, "b", "B"); // evicts "a", reuses slot 0 for "b"
    c.put(a, "a again", "A2", missForA as any);
    expect(c.lruOrder()).toEqual(["a again"]); // inserted fresh, did not overwrite "b" as a duplicate of "a"
    expect(c.stats.updates).toBe(0);
  });

  it("falls back to a full scan when the write log has rolled past the lookup", () => {
    // Big enough that nothing is evicted, so "target" stays live throughout.
    const c = make(new FakeClock(), { capacity: 10_000, dim: 4 });
    const target = unit([0, 0, 0, 1], 4);
    const miss = c.lookup(target, 0.9);
    c.put(target, "target", "T"); // written after that lookup...
    const rnd = seededRandom(3);
    // ...then pushed out of the write log by 9,000 writes that are orthogonal
    // to it (last component 0), so none of them can dedupe onto it.
    for (let i = 0; i < 9000; i++) c.put(Float32Array.from([rnd() + 0.01, rnd(), rnd(), 0]), `noise${i}`, i);
    const sizeBefore = c.size;
    const updatesBefore = c.stats.updates;
    c.put(target, "target again", "T2", miss as any);
    // Only a full scan can find "target" now: it must be refreshed, not duplicated.
    expect(c.stats.updates).toBe(updatesBefore + 1);
    expect(c.size).toBe(sizeBefore);
    const r = c.lookup(target, 0.99);
    expect(r.kind === "hit" && r.response).toBe("T2");
  });
});
