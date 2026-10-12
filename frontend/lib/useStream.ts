"use client";

import { useEffect, useRef, useState } from "react";
import { API_URL } from "./api";
import type { LogRecord, Point, Stats } from "./types";

const HISTORY = 120; // points (one per second): two minutes on screen
const LOG_KEEP = 200;

export type StreamState = {
  stats: Stats | null;
  history: Point[];
  logs: LogRecord[];
  connected: boolean;
  lastError: string | null;
};

/** Subscribes to /v1/stream (SSE) and keeps a rolling history for the charts.
 *  Per-source request rates come from differencing cumulative counters between
 *  snapshots, so they are exact rather than sampled. */
export function useStream(): StreamState {
  const [state, setState] = useState<StreamState>({
    stats: null,
    history: [],
    logs: [],
    connected: false,
    lastError: null,
  });
  const prev = useRef<{ t: number; counts: Record<string, number> } | null>(null);

  useEffect(() => {
    let es: EventSource | null = null;

    const open = () => {
      es = new EventSource(`${API_URL}/v1/stream?interval_ms=1000`);
      es.addEventListener("open", () => setState((s) => ({ ...s, connected: true, lastError: null })));
      es.addEventListener("error", () => {
        setState((s) => ({ ...s, connected: false, lastError: `Lost connection to ${API_URL}. Retrying.` }));
        prev.current = null; // do not difference across a gap
      });
      es.addEventListener("snapshot", (ev) => {
        const msg = JSON.parse((ev as MessageEvent).data) as { stats: Stats; logs: LogRecord[] };
        const s = msg.stats;
        const now = Date.now();
        const counts = s.requests_by_source as Record<string, number>;
        const p = prev.current;
        const dt = p ? (now - p.t) / 1000 : 0;
        const rate = (k: string) => (p && dt > 0 ? Math.max(0, ((counts[k] ?? 0) - (p.counts[k] ?? 0)) / dt) : 0);
        prev.current = { t: now, counts: { ...counts } };

        const point: Point = {
          t: now,
          rps: {
            model: rate("model"),
            cache: rate("cache"),
            degraded_cache: rate("degraded_cache"),
            rejected: rate("rejected") + rate("error"),
          },
          total: s.latency_recent.total,
          model: s.latency_recent.model_per_batch,
          cacheHit: s.latency_recent.total_cache_hits,
          queue: s.latency_recent.queue_wait,
          queueDepth: s.batcher.queue_depth,
          state: s.circuit.state,
        };
        setState((st) => ({
          stats: s,
          connected: true,
          lastError: null,
          history: p ? [...st.history, point].slice(-HISTORY) : st.history,
          logs: msg.logs.length ? [...st.logs, ...msg.logs].slice(-LOG_KEEP) : st.logs,
        }));
      });
    };

    // EventSource reconnects on its own after an error (server sends retry: 2000).
    open();
    return () => es?.close();
  }, []);

  return state;
}
