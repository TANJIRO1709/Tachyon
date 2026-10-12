"use client";

import type { Point, Stats } from "@/lib/types";
import { ms, num, pct, STATE_WORD } from "./format";
import { StateIcon } from "./StateChip";

/** The request lifecycle, live. Each box is a stage a request passes through,
 *  in order; line thickness is the share of the last five seconds of traffic
 *  that took that path. The cache-hit branch skips everything after the cache. */

const W = 136;
const H = 104;
const ROW = 104;            // top of the main row
const MID = ROW + H / 2;
const X = [16, 184, 352, 520, 688, 856, 1024] as const;
const cx = (i: number) => X[i]! + W / 2;

function recentRates(history: Point[]) {
  const pts = history.slice(-5);
  const sum = { model: 0, cache: 0, degraded_cache: 0, rejected: 0 };
  for (const p of pts) {
    sum.model += p.rps.model;
    sum.cache += p.rps.cache;
    sum.degraded_cache += p.rps.degraded_cache;
    sum.rejected += p.rps.rejected;
  }
  const n = Math.max(1, pts.length);
  const r = {
    model: sum.model / n,
    cache: sum.cache / n,
    degraded: sum.degraded_cache / n,
    rejected: sum.rejected / n,
  };
  return { ...r, total: r.model + r.cache + r.degraded + r.rejected };
}

function width(share: number, total: number) {
  if (total <= 0) return 1.5;
  return 1.5 + 12 * Math.min(1, Math.max(0, share / total));
}

function Node({
  i, name, value, sub1, sub2, tone,
}: {
  i: number; name: string; value: React.ReactNode; sub1?: string; sub2?: string;
  tone?: "closed" | "open" | "half_open";
}) {
  const x = X[i]!;
  const toneVar = tone === "open" ? "--critical" : tone === "half_open" ? "--warning" : tone === "closed" ? "--good" : null;
  return (
    <g>
      <rect
        className="node-box" x={x} y={ROW} width={W} height={H} rx={6}
        style={toneVar ? { stroke: `var(${toneVar})`, strokeWidth: 1.5, fill: `var(${toneVar}-tint)` } : undefined}
      />
      <text className="node-name" x={x + 14} y={ROW + 24}>{name}</text>
      <text className="node-val" x={x + 14} y={ROW + 58}>{value}</text>
      {sub1 && <text className="node-sub" x={x + 14} y={ROW + 78}>{sub1}</text>}
      {sub2 && <text className="node-sub" x={x + 14} y={ROW + 94}>{sub2}</text>}
    </g>
  );
}

export function Pipeline({ stats, history }: { stats: Stats | null; history: Point[] }) {
  const r = recentRates(history);
  const s = stats;
  const lat = s?.latency_recent;
  const state = s?.circuit.state ?? "closed";
  const decided = r.cache + r.model + r.degraded + r.rejected;
  const hitShare = decided > 0 ? r.cache / decided : null;

  const breakerSub =
    state === "open"
      ? `probing in ${num(s?.circuit.retry_after_s, 1)} s`
      : state === "half_open"
        ? `probes ${s?.circuit.probes_ok ?? 0} of ${s?.circuit.probe_success_required ?? 0} passed`
        : `${s?.circuit.consecutive_failures ?? 0} of ${s?.circuit.failure_threshold ?? 0} failures`;

  const fault = s?.backend?.fault?.mode && s.backend.fault.mode !== "none" ? s.backend.fault.mode : null;
  const ink = "var(--ink-3)";

  const rows: { name: string; value: string; note: string }[] = [
    { name: "Incoming", value: `${num(r.total, 1)}/s`, note: "requests per second" },
    { name: "Embed", value: `${ms(lat?.embed.p50)} ms`, note: `${s?.embedder ?? "–"} embedder, p50` },
    { name: "Semantic cache", value: hitShare == null ? "–" : pct(hitShare), note: `hit share, similarity ${num(s?.cache.avg_hit_similarity, 3)}` },
    { name: "Circuit breaker", value: STATE_WORD[state], note: breakerSub },
    { name: "Batch queue", value: num(s?.batcher.queue_depth), note: `waiting, p50 wait ${ms(lat?.queue_wait.p50)} ms` },
    { name: "Model", value: `${ms(lat?.model_per_batch.p50)} ms`, note: `per batch of ${num(s?.batcher.recent_mean_batch_size, 1)}` },
    { name: "Response", value: `${ms(lat?.total.p50)} ms`, note: "end to end, p50" },
  ];

  return (
    <section className="pipeline" aria-labelledby="pipeline-title">
      <div className="pipeline-lead">
        <h2 id="pipeline-title" className="visually-hidden">Request path, live</h2>
        <p className="lead-text">
          Every request is embedded and checked against the semantic cache. Only misses reach the breaker,
          the batch queue and the model. Line weight shows where the last five seconds of traffic went.
        </p>
      </div>

      <svg className="pipeline-svg" viewBox="0 0 1176 300" role="img" aria-label={`Request path. ${rows.map((x) => `${x.name} ${x.value}`).join(". ")}.`}>
        <defs>
          <marker id="pl-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" fill="var(--ink-3)" />
          </marker>
        </defs>

        {/* main row connectors */}
        <path className="flow" d={`M${X[0] + W} ${MID}H${X[1]}`} stroke={ink} strokeWidth={width(r.total, r.total)} />
        <path className="flow" d={`M${X[1] + W} ${MID}H${X[2]}`} stroke={ink} strokeWidth={width(r.total, r.total)} />
        <path className="flow" d={`M${X[2] + W} ${MID}H${X[3]}`} stroke={ink} strokeWidth={width(r.total - r.cache, r.total)} />
        <path className="flow" d={`M${X[3] + W} ${MID}H${X[4]}`} stroke="var(--s-model)" strokeWidth={width(r.model, r.total)} />
        <path className="flow" d={`M${X[4] + W} ${MID}H${X[5]}`} stroke="var(--s-model)" strokeWidth={width(r.model, r.total)} />
        <path className="flow" d={`M${X[5] + W} ${MID}H${X[6]}`} stroke="var(--s-model)" strokeWidth={width(r.model, r.total)} />

        {/* cache hit: straight to the response */}
        <path
          className="flow"
          d={`M${cx(2)} ${ROW + H}V${ROW + H + 56}H${cx(6)}V${ROW + H}`}
          stroke="var(--s-cache)"
          strokeWidth={width(r.cache, r.total)}
        />
        <text className="edge-label" x={cx(2) + 12} y={ROW + H + 48}>
          Cache hit: {num(r.cache, 1)}/s, answered in {ms(lat?.total_cache_hits.p50)} ms
        </text>

        {/* breaker open or model failing: degrade or fail fast */}
        <path
          className="flow"
          d={`M${cx(3)} ${ROW}V36H${X[4]}`}
          stroke="var(--s-degraded)"
          strokeWidth={width(r.degraded + r.rejected, r.total)}
        />
        <rect className="node-box" x={X[4]} y={12} width={X[5] + W - X[4]} height={48} rx={6} />
        <text className="node-name" x={X[4] + 14} y={32}>Fallback when the model cannot answer</text>
        <text className="node-sub" x={X[4] + 14} y={50}>
          {num(r.degraded, 1)}/s degraded from cache, {num(r.rejected, 1)}/s rejected fast
        </text>
        <path className="flow" d={`M${X[5] + W} 36H${cx(6)}V${ROW}`} stroke="var(--s-degraded)" strokeWidth={width(r.degraded, r.total)} />

        <Node i={0} name="Incoming" value={`${num(r.total, 1)}/s`} sub1="requests per second" />
        <Node i={1} name="Embed" value={`${ms(lat?.embed.p50)} ms`} sub1={`${s?.embedder ?? "–"}, p50`} />
        <Node
          i={2}
          name="Semantic cache"
          value={hitShare == null ? "–" : pct(hitShare)}
          sub1={`similarity ${num(s?.cache.avg_hit_similarity, 3)}`}
          sub2={`${num(s?.cache.entries)} of ${num(s?.cache.capacity)} kept`}
        />
        <g>
          <Node i={3} name="Circuit breaker" value="" sub1={breakerSub} sub2={`${s?.circuit.trips ?? 0} trips so far`} tone={state} />
          <g transform={`translate(${X[3] + 14}, ${ROW + 36})`} style={{ color: `var(${state === "open" ? "--critical" : state === "half_open" ? "--warning" : "--good"})` }}>
            <StateIcon state={state} size={22} />
          </g>
          <text className="node-val" x={X[3] + 44} y={ROW + 58}>{STATE_WORD[state]}</text>
        </g>
        <Node
          i={4}
          name="Batch queue"
          value={`${num(s?.batcher.queue_depth)} waiting`}
          sub1={`p50 wait ${ms(lat?.queue_wait.p50)} ms`}
          sub2={s?.batcher.enabled ? `window ${ms(s?.batcher.effective_window_ms, 1)} ms` : "batching off"}
        />
        <Node
          i={5}
          name="Model"
          value={`${ms(lat?.model_per_batch.p50)} ms`}
          sub1={`batches of ${num(s?.batcher.recent_mean_batch_size, 1)}`}
          sub2={fault ? `fault injected: ${fault}` : s?.backend?.backend === "stub" ? "stub backend" : s?.backend?.model ?? ""}
        />
        <Node
          i={6}
          name="Response"
          value={`${ms(lat?.total.p50)} ms`}
          sub1="end to end, p50"
          sub2={`p99 ${ms(lat?.total.p99)} ms`}
        />
      </svg>

      <ol className="pipeline-list">
        {rows.map((x) => (
          <li key={x.name}>
            <span>
              <b>{x.name}</b>
              <br />
              <span className="small muted">{x.note}</span>
            </span>
            <span className="figure">{x.value}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
