"use client";

import { useState } from "react";
import type { LogRecord } from "@/lib/types";
import { clock, ms } from "./format";

type Filter = "all" | "errors" | "breaker";

const SOURCE_COLOR: Record<string, string> = {
  model: "var(--s-model)",
  cache: "var(--s-cache)",
  degraded_cache: "var(--s-degraded)",
  rejected: "var(--s-rejected)",
  error: "var(--s-rejected)",
};
const SOURCE_WORD: Record<string, string> = {
  model: "model", cache: "cache hit", degraded_cache: "degraded", rejected: "rejected", error: "error",
};

/** The structured request log, newest first. Click a batch id to see every
 *  request that shared that model call; click a row for the raw JSON line. */
export function LogTail({ logs }: { logs: LogRecord[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [batch, setBatch] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  const rows = logs
    .filter((l) => ["request", "circuit_transition", "fault_injected", "config_change", "cache_flush"].includes(l.event))
    .filter((l) => {
      if (batch) return l.batch_id === batch;
      if (filter === "errors") return l.event === "request" && l.status !== 200;
      if (filter === "breaker") return l.event === "circuit_transition" || l.event === "fault_injected";
      return true;
    })
    .slice(-40)
    .reverse();

  return (
    <div>
      <div className="row" style={{ marginBottom: 10, justifyContent: "space-between" }}>
        <div className="seg" role="group" aria-label="Filter log lines">
          {(["all", "errors", "breaker"] as Filter[]).map((f) => (
            <button key={f} type="button" aria-pressed={!batch && filter === f} onClick={() => { setBatch(null); setFilter(f); }}>
              {f === "all" ? "Everything" : f === "errors" ? "Failed requests" : "Breaker and faults"}
            </button>
          ))}
        </div>
        {batch && (
          <span className="small">
            Showing batch <b>{batch}</b>.{" "}
            <button className="btn" type="button" onClick={() => setBatch(null)}>Show all</button>
          </span>
        )}
      </div>
      <div className="table-scroll">
        <table className="logs">
          <thead>
            <tr>
              <th>Time</th>
              <th>Served by</th>
              <th>Cache</th>
              <th>Batch</th>
              <th className="num">Queue ms</th>
              <th className="num">Model ms</th>
              <th className="num">Total ms</th>
              <th>Input</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={8} className="faint">Nothing logged yet for this filter.</td></tr>
            )}
            {rows.map((l) => {
              const isReq = l.event === "request";
              const expanded = open === l.seq;
              const src = String(l.source ?? "");
              return [
                <tr key={l.seq} className={isReq ? "" : "event"} data-open={expanded}>
                  <td>
                    <button className="linkish" type="button" onClick={() => setOpen(expanded ? null : l.seq)} aria-expanded={expanded}>
                      {clock(l.ts)}
                    </button>
                  </td>
                  {isReq ? (
                    <>
                      <td>
                        <span className="tag" style={{ fontWeight: 500 }}>
                          <i style={{ background: SOURCE_COLOR[src] ?? "var(--ink-3)" }} />
                          {SOURCE_WORD[src] ?? src}
                          {l.error ? `, ${String(l.error).toLowerCase().replaceAll("_", " ")}` : ""}
                        </span>
                      </td>
                      <td>
                        {String(l.cache)}
                        {l.similarity != null ? ` ${Number(l.similarity).toFixed(3)}` : l.best_miss_similarity != null ? `, best ${Number(l.best_miss_similarity).toFixed(2)}` : ""}
                      </td>
                      <td>
                        {l.batch_id ? (
                          <button className="linkish" type="button" onClick={() => setBatch(String(l.batch_id))} title="Show every request in this batch">
                            {String(l.batch_id).slice(0, 7)} <span className="faint">of {String(l.batch_size)}</span>
                          </button>
                        ) : "–"}
                      </td>
                      <td className="num">{ms(l.queue_wait_ms as number | null)}</td>
                      <td className="num">{ms(l.model_latency_ms as number | null)}</td>
                      <td className="num"><b>{ms(l.total_latency_ms as number | null)}</b></td>
                      <td className="wrap muted">{String(l.input_preview ?? l.input_sha256 ?? "")}</td>
                    </>
                  ) : (
                    <td colSpan={7}>
                      <b>{l.event.replaceAll("_", " ")}</b>{" "}
                      {l.event === "circuit_transition" && `${String(l.from_state)} to ${String(l.to_state)}: ${String(l.reason)}`}
                      {l.event === "fault_injected" && `backend set to ${String(l.mode)}`}
                      {l.event === "config_change" && JSON.stringify(l.changed)}
                      {l.event === "cache_flush" && `${String(l.removed)} entries removed`}
                    </td>
                  )}
                </tr>,
                expanded && (
                  <tr key={`${l.seq}-json`}>
                    <td colSpan={8}><pre>{JSON.stringify(l, null, 2)}</pre></td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
