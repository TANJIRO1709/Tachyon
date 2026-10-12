"use client";

import { useState } from "react";
import type { Stats } from "@/lib/types";
import { num } from "./format";

/** How full batches were over the last minute. All in the "1" bucket means
 *  batching is not batching; all at the max means the window could be wider. */
export function BatchHistogram({ stats }: { stats: Stats | null }) {
  const [hover, setHover] = useState<number | null>(null);
  const dist = stats?.batch_size_distribution ?? [];
  const VW = 720;
  const VH = 170;
  const M = { l: 44, r: 92, t: 22, b: 26 };
  const iw = VW - M.l - M.r;
  const ih = VH - M.t - M.b;
  const max = Math.max(1, ...dist.map((d) => d.batches));
  const band = dist.length ? iw / dist.length : iw;
  const bw = Math.min(24, band * 0.6);
  const total = dist.reduce((a, d) => a + d.batches, 0);
  const reasons = stats?.batcher.dispatch_reasons ?? {};

  // Bar with a 4px rounded data end, square at the baseline.
  const bar = (x: number, top: number, w: number, base: number) => {
    const r = Math.min(4, w / 2, base - top);
    return `M${x} ${base}V${top + r}Q${x} ${top} ${x + r} ${top}H${x + w - r}Q${x + w} ${top} ${x + w} ${top + r}V${base}Z`;
  };

  return (
    <figure className="chart" style={{ margin: 0 }}>
      <div className="chart-head">
        <h3>Batch sizes, last minute</h3>
        <span className="small muted">{num(total)} batches</span>
      </div>
      {total === 0 ? (
        <div className="chart-empty">No batches yet.</div>
      ) : (
        <svg className="chart-svg" viewBox={`0 0 ${VW} ${VH}`} role="img" aria-label={`Batch sizes: ${dist.map((d) => `${d.bucket}: ${d.batches}`).join(", ")}`}>
          <g className="grid">
            {[0, 0.5, 1].map((f) => (
              <line key={f} x1={M.l} x2={M.l + iw} y1={M.t + ih - f * ih} y2={M.t + ih - f * ih} />
            ))}
          </g>
          <g className="axis">
            {[0, 0.5, 1].map((f) => (
              <text key={f} x={M.l - 6} y={M.t + ih - f * ih + 4} textAnchor="end">{Math.round(f * max)}</text>
            ))}
            {dist.map((d, i) => (
              <text key={d.bucket} x={M.l + band * i + band / 2} y={VH - 8} textAnchor="middle">{d.bucket}</text>
            ))}
          </g>
          {dist.map((d, i) => {
            const x = M.l + band * i + (band - bw) / 2;
            const top = M.t + ih - (d.batches / max) * ih;
            return (
              <g key={d.bucket}>
                {d.batches > 0 && <path d={bar(x, top, bw, M.t + ih)} fill="var(--s-model)" opacity={hover == null || hover === i ? 1 : 0.45} />}
                {d.batches > 0 && hover !== i && (
                  <text x={x + bw / 2} y={top - 5} textAnchor="middle" className="end-label" style={{ fontSize: 11 }}>{d.batches}</text>
                )}
                <rect
                  x={M.l + band * i} y={M.t} width={band} height={ih} fill="transparent"
                  onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
                />
              </g>
            );
          })}
          {hover != null && dist[hover] && (
            <text x={M.l + band * hover + band / 2} y={12} textAnchor="middle" className="end-label">
              {dist[hover]!.batches} batches of {dist[hover]!.bucket} ({Math.round((dist[hover]!.batches / total) * 100)}%)
            </text>
          )}
        </svg>
      )}
      <figcaption className="small faint" style={{ marginTop: 6 }}>
        Dispatched because the batch filled: {num(reasons.full ?? 0)}. Because the window closed: {num(reasons.window ?? 0)}.
        {reasons.unbatched ? ` Unbatched: ${num(reasons.unbatched)}.` : ""}
      </figcaption>
    </figure>
  );
}
