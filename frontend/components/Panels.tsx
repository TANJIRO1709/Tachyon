"use client";

import type { Stats } from "@/lib/types";
import { duration, ms, num, pct } from "./format";
import { StateChip } from "./StateChip";

export function BreakerPanel({ stats }: { stats: Stats | null }) {
  const c = stats?.circuit;
  if (!c) return null;
  const fill = c.failure_threshold ? Math.min(1, c.consecutive_failures / c.failure_threshold) : 0;
  return (
    <section className="panel" aria-labelledby="breaker-h">
      <h3 id="breaker-h">
        Circuit breaker <StateChip state={c.state} />
      </h3>
      <dl className="facts">
        <dt>Consecutive failures</dt>
        <dd>
          {c.consecutive_failures} of {c.failure_threshold}
        </dd>
      </dl>
      <div className="meter" aria-hidden="true"><span style={{ width: `${fill * 100}%` }} /></div>
      <dl className="facts" style={{ marginTop: 14 }}>
        <dt>{c.state === "closed" ? "Closed for" : c.state === "open" ? "Open for" : "Probing for"}</dt>
        <dd>{duration(c.time_in_state_s)}</dd>
        {c.state === "open" && (<><dt>Next probe in</dt><dd>{num(c.retry_after_s, 1)} s</dd></>)}
        {c.state === "half_open" && (<><dt>Probes passed</dt><dd>{c.probes_ok} of {c.probe_success_required}</dd></>)}
        <dt>Times tripped</dt><dd>{num(c.trips)}</dd>
        <dt>Requests rejected fast</dt><dd>{num(c.rejected)}</dd>
        <dt>Counts as failure when slower than</dt><dd>{ms(c.latency_threshold_ms)} ms</dd>
      </dl>
      {c.history.length > 0 && (
        <ul className="history" aria-label="Recent transitions">
          {c.history.slice(0, 5).map((h, i) => (
            <li key={i}>
              <span>{duration(h.ago_s)} ago</span>
              <span>
                <b>{h.from.replace("_", "-")}</b> to <b>{h.to.replace("_", "-")}</b>: {h.reason}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function CachePanel({ stats }: { stats: Stats | null }) {
  const c = stats?.cache;
  if (!c || !stats) return null;
  const saved = stats.estimated_model_ms_saved;
  return (
    <section className="panel" aria-labelledby="cache-h">
      <h3 id="cache-h">Semantic cache</h3>
      <dl className="facts">
        <dt>Hit rate since start</dt><dd>{pct(c.hit_rate, 1)}</dd>
        <dt>Average similarity of hits</dt><dd>{num(c.avg_hit_similarity, 3)}</dd>
        <dt>Model calls avoided</dt><dd>{num(c.inference_calls_saved)}</dd>
        <dt>Waiting time avoided</dt><dd>{saved == null ? "–" : duration(saved / 1000)}</dd>
        <dt>Served degraded in outages</dt><dd>{num(c.degraded_hits)}</dd>
        <dt>Entries kept</dt><dd>{num(c.entries)} of {num(c.capacity)}</dd>
        <dt>Evicted, least recently used</dt><dd>{num(c.evictions_lru)}</dd>
        <dt>Evicted, expired</dt><dd>{num(c.evictions_ttl)}</dd>
      </dl>
      <p className="small faint" style={{ marginTop: 12 }}>
        Answers are reused at similarity {num(stats.config.cache_threshold, 2)} or above and kept {duration(c.ttl_s)}.
        During an outage the bar drops to {num(stats.config.cache_degraded_threshold, 2)} and the answer is marked degraded.
      </p>
    </section>
  );
}
