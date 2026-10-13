/** Circuit breaker state machine. The half-open transitions get the most
 *  coverage because that is where implementations usually go wrong. */
import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../src/circuitBreaker.js";
import { FakeClock } from "./helpers.js";

function make(clock: FakeClock, o: Partial<{ failureThreshold: number; latencyThresholdMs: number; cooldownS: number; probeLimit: number; probeSuccessRequired: number }> = {}) {
  return new CircuitBreaker(
    { failureThreshold: 3, latencyThresholdMs: 500, cooldownS: 10, probeLimit: 2, probeSuccessRequired: 2, ...o },
    { clock: clock.fn },
  );
}
const fail = (b: CircuitBreaker, latencyMs = 10) => { const p = b.allow()!; b.record([p], { ok: false, latencyMs }); return p; };
const succeed = (b: CircuitBreaker, latencyMs = 10) => { const p = b.allow()!; b.record([p], { ok: true, latencyMs }); return p; };
const trip = (b: CircuitBreaker) => { for (let i = 0; i < b.config.failureThreshold; i++) fail(b); expect(b.state).toBe("open"); };

describe("closed", () => {
  it("opens after N consecutive failures", () => {
    const b = make(new FakeClock(), { failureThreshold: 3 });
    fail(b); fail(b);
    expect(b.state).toBe("closed");
    fail(b);
    expect(b.state).toBe("open");
    expect(b.stats.trips).toBe(1);
  });

  it("resets the count on one success (consecutive, not cumulative)", () => {
    const b = make(new FakeClock(), { failureThreshold: 3 });
    for (let i = 0; i < 10; i++) { fail(b); fail(b); succeed(b); }
    expect(b.state).toBe("closed");
    expect(b.consecutiveFailures).toBe(0);
  });

  it("trips on slow responses with no error at all", () => {
    const b = make(new FakeClock(), { failureThreshold: 3, latencyThresholdMs: 500 });
    for (let i = 0; i < 3; i++) b.record([b.allow()!], { ok: true, latencyMs: 900 });
    expect(b.state).toBe("open");
    expect(b.history.at(-1)!.reason).toBe("3 consecutive slow calls");
  });

  it("counts a batch as one backend call", () => {
    const b = make(new FakeClock(), { failureThreshold: 3 });
    b.record(Array.from({ length: 16 }, () => b.allow()!), { ok: false, latencyMs: 10 });
    expect(b.state).toBe("closed");
    expect(b.consecutiveFailures).toBe(1);
  });
});

describe("open", () => {
  it("rejects immediately until the cooldown elapses", () => {
    const clock = new FakeClock();
    const b = make(clock, { cooldownS: 10 });
    trip(b);
    expect(b.allow()).toBeNull();
    clock.advance(9.99);
    expect(b.allow()).toBeNull();
    expect(b.peekRejects()).toBe(true);
    expect(b.stats.rejected).toBe(2);
    expect(b.retryAfterS()).toBeGreaterThan(0);
    expect(b.retryAfterS()).toBeLessThanOrEqual(0.02);
  });

  it("peek never changes state", () => {
    const clock = new FakeClock();
    const b = make(clock);
    trip(b);
    clock.advance(11);
    expect(b.peekRejects()).toBe(false);
    expect(b.state).toBe("open");
  });
});

describe("half-open", () => {
  it("is entered on the next request after the cooldown", () => {
    const clock = new FakeClock();
    const b = make(clock);
    trip(b);
    clock.advance(10);
    const p = b.allow();
    expect(p?.probe).toBe(true);
    expect(b.state).toBe("half_open");
  });

  it("admits a bounded number of probes, rejecting the rest", () => {
    const clock = new FakeClock();
    const b = make(clock, { probeLimit: 2 });
    trip(b);
    clock.advance(10);
    expect(b.allow()).not.toBeNull();
    expect(b.allow()).not.toBeNull();
    for (let i = 0; i < 50; i++) expect(b.allow()).toBeNull();
    expect(b.stats.probesAdmitted).toBe(2);
  });

  it("closes when enough probes succeed", () => {
    const clock = new FakeClock();
    const b = make(clock, { probeLimit: 2, probeSuccessRequired: 2 });
    trip(b);
    clock.advance(10);
    const [p1, p2] = [b.allow()!, b.allow()!];
    b.record([p1], { ok: true, latencyMs: 10 });
    expect(b.state).toBe("half_open");
    b.record([p2], { ok: true, latencyMs: 10 });
    expect(b.state).toBe("closed");
    for (let i = 0; i < 20; i++) expect(b.allow()).not.toBeNull();
  });

  it("reopens on a probe failure and restarts the cooldown from that moment", () => {
    const clock = new FakeClock();
    const b = make(clock, { cooldownS: 10 });
    trip(b);
    const firstOpen = b.openedAt!;
    clock.advance(10);
    const p = b.allow()!;
    clock.advance(3);
    b.record([p], { ok: false, latencyMs: 10 });
    expect(b.state).toBe("open");
    expect(b.openedAt).toBe(firstOpen + 13);
    expect(b.stats.trips).toBe(2);
    clock.advance(9.9);
    expect(b.allow()).toBeNull();
    clock.advance(0.2);
    expect(b.allow()).not.toBeNull();
    expect(b.state).toBe("half_open");
  });

  it("reopens on a slow probe", () => {
    const clock = new FakeClock();
    const b = make(clock, { latencyThresholdMs: 500 });
    trip(b);
    clock.advance(10);
    b.record([b.allow()!], { ok: true, latencyMs: 800 });
    expect(b.state).toBe("open");
    expect(b.history.at(-1)!.reason).toBe("probe slow");
  });

  it("ignores a stale success from before the trip", () => {
    const clock = new FakeClock();
    const b = make(clock, { failureThreshold: 3, probeLimit: 1, probeSuccessRequired: 1 });
    const straggler = b.allow()!; // admitted while healthy
    trip(b);
    clock.advance(10);
    const probe = b.allow()!;
    b.record([straggler], { ok: true, latencyMs: 10 });
    expect(b.state).toBe("half_open");
    expect(b.stats.staleResultsIgnored).toBe(1);
    b.record([probe], { ok: true, latencyMs: 10 });
    expect(b.state).toBe("closed");
  });

  it("does not let a stale failure reopen a recovered circuit", () => {
    const clock = new FakeClock();
    const b = make(clock, { failureThreshold: 1, probeLimit: 1, probeSuccessRequired: 1 });
    const straggler = b.allow()!;
    fail(b);
    clock.advance(10);
    b.record([b.allow()!], { ok: true, latencyMs: 10 });
    expect(b.state).toBe("closed");
    b.record([straggler], { ok: false, latencyMs: 10 });
    expect(b.state).toBe("closed");
  });

  it("frees a released probe's slot", () => {
    const clock = new FakeClock();
    const b = make(clock, { probeLimit: 1 });
    trip(b);
    clock.advance(10);
    const p = b.allow()!;
    expect(b.allow()).toBeNull();
    b.release(p);
    expect(b.allow()).not.toBeNull();
  });
});

describe("bookkeeping", () => {
  it("counts a permit once", () => {
    const b = make(new FakeClock(), { failureThreshold: 2 });
    const p = b.allow()!;
    b.record([p], { ok: false, latencyMs: 10 });
    b.record([p], { ok: false, latencyMs: 10 });
    expect(b.consecutiveFailures).toBe(1);
    b.release(p); // no-op after record
  });

  it("clamps an impossible success requirement", () => {
    const clock = new FakeClock();
    const b = make(clock, { probeLimit: 2, probeSuccessRequired: 5 });
    trip(b);
    clock.advance(10);
    b.record([b.allow()!, b.allow()!], { ok: true, latencyMs: 10 });
    expect(b.state).toBe("closed");
  });

  it("records the full cycle", () => {
    const clock = new FakeClock();
    const b = make(clock, { probeLimit: 1, probeSuccessRequired: 1 });
    trip(b);
    clock.advance(10);
    b.record([b.allow()!], { ok: false, latencyMs: 10 });
    clock.advance(10);
    b.record([b.allow()!], { ok: true, latencyMs: 10 });
    expect(b.history.map((t) => [t.from, t.to])).toEqual([
      ["closed", "open"], ["open", "half_open"], ["half_open", "open"], ["open", "half_open"], ["half_open", "closed"],
    ]);
    expect(b.generation).toBe(5);
  });
});
