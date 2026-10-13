export type State = "closed" | "open" | "half_open";

export type Permit = { generation: number; probe: boolean; settled: boolean };

export type Transition = { at: number; from: State; to: State; reason: string };

export type BreakerConfig = {
  failureThreshold: number;
  latencyThresholdMs: number;
  cooldownS: number;
  probeLimit: number;
  probeSuccessRequired: number;
};

export class CircuitBreaker {
  state: State = "closed";
  generation = 0;
  consecutiveFailures = 0;
  openedAt: number | null = null;
  stateSince: number;
  probesSent = 0;
  probesOk = 0;
  readonly history: Transition[] = [];
  readonly stats = {
    trips: 0, rejected: 0, admitted: 0, probesAdmitted: 0,
    successes: 0, failures: 0, slowCalls: 0, staleResultsIgnored: 0,
  };

  constructor(
    public config: BreakerConfig,
    private readonly opts: {
      clock?: () => number; // seconds
      onTransition?: (t: Transition) => void;
      historySize?: number;
    } = {},
  ) {
    this.stateSince = this.now();
  }

  private now(): number {
    return (this.opts.clock ?? (() => performance.now() / 1000))();
  }

  /** Requiring more successes than probes admitted would make the circuit
   *  impossible to close. Clamp rather than deadlock. */
  get probesNeeded(): number {
    return Math.max(1, Math.min(this.config.probeSuccessRequired, this.config.probeLimit));
  }

  private transition(to: State, reason: string): void {
    const at = this.now();
    const t: Transition = { at, from: this.state, to, reason };
    this.state = to;
    this.stateSince = at;
    this.generation++;
    if (to === "open") {
      this.openedAt = at;
      this.stats.trips++;
    } else if (to === "half_open") {
      this.probesSent = 0;
      this.probesOk = 0;
    } else {
      this.consecutiveFailures = 0;
      this.openedAt = null;
    }
    this.history.push(t);
    if (this.history.length > (this.opts.historySize ?? 50)) this.history.shift();
    this.opts.onTransition?.(t);
  }

  private cooldownElapsed(): boolean {
    return this.openedAt !== null && this.now() - this.openedAt >= this.config.cooldownS;
  }

  /** True if allow() would reject right now. Never changes state. Used to skip
   *  the embedding for a request that will be rejected with no fallback. */
  peekRejects(): boolean {
    if (this.state === "open") return !this.cooldownElapsed();
    if (this.state === "half_open") return this.probesSent >= this.config.probeLimit;
    return false;
  }

  /** Admit a request (returns a Permit) or reject it (returns null). */
  allow(): Permit | null {
    if (this.state === "open") {
      if (this.cooldownElapsed()) this.transition("half_open", "cooldown elapsed");
      else {
        this.stats.rejected++;
        return null;
      }
    }
    if (this.state === "half_open") {
      if (this.probesSent >= this.config.probeLimit) {
        this.stats.rejected++;
        return null;
      }
      this.probesSent++;
      this.stats.admitted++;
      this.stats.probesAdmitted++;
      return { generation: this.generation, probe: true, settled: false };
    }
    this.stats.admitted++;
    return { generation: this.generation, probe: false, settled: false };
  }

  /** Report the outcome of ONE backend call (one batch). `permits` are those of
   *  every request in the call; it counts once if any belongs to the current
   *  generation. */
  record(permits: Permit[], outcome: { ok: boolean; latencyMs: number }): void {
    const fresh = permits.filter((p) => !p.settled);
    for (const p of fresh) p.settled = true;
    const current = fresh.filter((p) => p.generation === this.generation);
    if (!current.length) {
      if (fresh.length) this.stats.staleResultsIgnored++;
      return;
    }

    const slow = outcome.latencyMs > this.config.latencyThresholdMs;
    const failed = !outcome.ok || slow;
    if (slow) this.stats.slowCalls++;
    if (failed) this.stats.failures++;
    else this.stats.successes++;

    if (this.state === "half_open") {
      const probes = current.filter((p) => p.probe);
      if (!probes.length) return;
      if (failed) {
        this.transition("open", outcome.ok && slow ? "probe slow" : "probe failed");
        return;
      }
      this.probesOk += probes.length;
      if (this.probesOk >= this.probesNeeded) this.transition("closed", `${this.probesOk} probes succeeded`);
      return;
    }

    if (this.state === "closed") {
      if (failed) {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.config.failureThreshold) {
          const what = outcome.ok && slow ? "slow calls" : "failures";
          this.transition("open", `${this.consecutiveFailures} consecutive ${what}`);
        }
      } else {
        this.consecutiveFailures = 0; // consecutive, not cumulative
      }
    }
  }

  /** Return a permit whose request never reached the backend (client timed out,
   *  queue full). A leaked probe would leave HALF_OPEN with every slot used and
   *  no verdict ever coming: the breaker would reject forever. */
  release(permit: Permit): void {
    if (permit.settled) return;
    permit.settled = true;
    if (permit.probe && this.state === "half_open" && permit.generation === this.generation && this.probesSent > 0) {
      this.probesSent--;
    }
  }

  reset(reason = "manual reset"): void {
    if (this.state !== "closed") this.transition("closed", reason);
    this.consecutiveFailures = 0;
  }

  retryAfterS(): number {
    if (this.state === "open" && this.openedAt !== null) {
      return Math.max(0, this.config.cooldownS - (this.now() - this.openedAt));
    }
    return this.state === "half_open" ? 1 : 0;
  }

  snapshot() {
    const t = this.now();
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    return {
      state: this.state,
      generation: this.generation,
      consecutive_failures: this.consecutiveFailures,
      failure_threshold: this.config.failureThreshold,
      latency_threshold_ms: this.config.latencyThresholdMs,
      cooldown_s: this.config.cooldownS,
      probe_limit: this.config.probeLimit,
      probe_success_required: this.probesNeeded,
      probes_sent: this.state === "half_open" ? this.probesSent : 0,
      probes_ok: this.state === "half_open" ? this.probesOk : 0,
      time_in_state_s: r3(t - this.stateSince),
      retry_after_s: r3(this.retryAfterS()),
      trips: this.stats.trips,
      rejected: this.stats.rejected,
      admitted: this.stats.admitted,
      successes: this.stats.successes,
      failures: this.stats.failures,
      slow_calls: this.stats.slowCalls,
      stale_results_ignored: this.stats.staleResultsIgnored,
      history: this.history
        .slice(-10)
        .reverse()
        .map((h) => ({ ago_s: Math.round((t - h.at) * 100) / 100, from: h.from, to: h.to, reason: h.reason })),
    };
  }
}
