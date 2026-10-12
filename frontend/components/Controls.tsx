"use client";

import { useEffect, useRef, useState } from "react";
import { admin } from "@/lib/api";
import type { Config, Stats } from "@/lib/types";

type Fault = "none" | "error" | "slow" | "flaky";
const FAULTS: { mode: Fault; label: string; extra?: { failure_rate?: number; extra_latency_ms?: number } }[] = [
  { mode: "none", label: "Healthy" },
  { mode: "error", label: "Failing" },
  { mode: "slow", label: "Slow, +2.5 s", extra: { extra_latency_ms: 2500 } },
  { mode: "flaky", label: "Flaky, half fail", extra: { failure_rate: 0.5 } },
];

/** A slider that commits to the server 300 ms after the last change, so
 *  dragging does not send a request per pixel. */
function Slider({
  id, label, value, min, max, step, format, onCommit,
}: {
  id: string; label: string; value: number; min: number; max: number; step: number;
  format: (v: number) => string; onCommit: (v: number) => void;
}) {
  const [local, setLocal] = useState(value);
  const dirty = useRef(false);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!dirty.current) setLocal(value);
  }, [value]);
  return (
    <div className="field">
      <label htmlFor={id}>{label} <b>{format(local)}</b></label>
      <input
        id={id} type="range" min={min} max={max} step={step} value={local}
        onChange={(e) => {
          const v = Number(e.target.value);
          setLocal(v);
          dirty.current = true;
          if (t.current) clearTimeout(t.current);
          t.current = setTimeout(() => {
            onCommit(v);
            dirty.current = false;
          }, 300);
        }}
      />
    </div>
  );
}

export function Controls({ stats }: { stats: Stats | null }) {
  const [error, setError] = useState<string | null>(null);
  const cfg = stats?.config;
  const fault = (stats?.backend?.fault?.mode ?? "none") as Fault;
  const isStub = stats?.backend?.backend === "stub";

  const run = async (fn: () => Promise<unknown>) => {
    try {
      setError(null);
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const patch = (p: Partial<Config>) => run(() => admin.patchConfig(p));

  if (!cfg) return null;
  return (
    <>
      <div className="controls">
        <div className="field">
          <span className="lbl">Model backend</span>
          <div className="seg" role="group" aria-label="Model backend behaviour">
            {FAULTS.map((f) => (
              <button
                key={f.mode} type="button" aria-pressed={fault === f.mode} disabled={!isStub}
                onClick={() => run(() => admin.setFault(f.mode, f.extra))}
              >
                {f.label}
              </button>
            ))}
          </div>
          {!isStub && <span className="small faint">Fault injection works with the stub backend only.</span>}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn" type="button" onClick={() => run(admin.resetCircuit)}>Close the breaker now</button>
            <button className="btn" type="button" onClick={() => run(admin.flushCache)}>Empty the cache</button>
          </div>
        </div>

        <div className="stack-v" style={{ display: "grid", gap: 14 }}>
          <label className="toggle">
            <input type="checkbox" checked={cfg.batching_enabled} onChange={(e) => patch({ batching_enabled: e.target.checked })} />
            Batch requests
          </label>
          <Slider id="win" label="Batch window" value={cfg.batch_window_ms} min={1} max={200} step={1} format={(v) => `${v} ms`} onCommit={(v) => patch({ batch_window_ms: v })} />
          <Slider id="size" label="Largest batch" value={cfg.max_batch_size} min={1} max={64} step={1} format={(v) => `${v}`} onCommit={(v) => patch({ max_batch_size: v })} />
        </div>

        <div style={{ display: "grid", gap: 14 }}>
          <label className="toggle">
            <input type="checkbox" checked={cfg.cache_enabled} onChange={(e) => patch({ cache_enabled: e.target.checked })} />
            Use the semantic cache
          </label>
          <Slider id="thr" label="Reuse an answer at similarity" value={cfg.cache_threshold} min={0.5} max={0.99} step={0.01} format={(v) => v.toFixed(2)} onCommit={(v) => patch({ cache_threshold: v })} />
          <Slider id="ttl" label="Keep answers for" value={cfg.cache_ttl_s} min={5} max={3600} step={5} format={(v) => (v >= 60 ? `${Math.round(v / 60)} min` : `${v} s`)} onCommit={(v) => patch({ cache_ttl_s: v })} />
        </div>

        <div style={{ display: "grid", gap: 14 }}>
          <Slider id="ft" label="Failures before the breaker opens" value={cfg.breaker_failure_threshold} min={1} max={20} step={1} format={(v) => `${v}`} onCommit={(v) => patch({ breaker_failure_threshold: v })} />
          <Slider id="cd" label="Wait before probing" value={cfg.breaker_cooldown_s} min={1} max={60} step={1} format={(v) => `${v} s`} onCommit={(v) => patch({ breaker_cooldown_s: v })} />
          <Slider id="lt" label="Slower than this counts as failed" value={cfg.breaker_latency_threshold_ms} min={100} max={5000} step={50} format={(v) => `${v} ms`} onCommit={(v) => patch({ breaker_latency_threshold_ms: v })} />
        </div>
      </div>
      {error && <p className="notice">The server rejected that change: {error}</p>}
    </>
  );
}
