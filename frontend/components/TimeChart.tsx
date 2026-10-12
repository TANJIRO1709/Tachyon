"use client";

import { useMemo, useRef, useState } from "react";

export type Series = { key: string; label: string; color: string };
export type Row = { t: number; values: Record<string, number | null> };

const VW = 720;
const M = { l: 44, r: 92, t: 22, b: 26 };
const WINDOW_MS = 120_000;

/** Round tick step so the four gridlines land on readable values. */
function niceStep(v: number): number {
  if (v <= 0 || !Number.isFinite(v)) return 0.25;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

/** Time-series chart: lines, or stacked areas when the series are parts of a
 *  whole. Hover (or focus + arrow keys) shows a crosshair and every value at
 *  that moment. End labels carry identity so colour is never the only cue. */
export function TimeChart({
  title, rows, series, height = 220, unit, stacked = false, format = (v) => v.toFixed(0), note, actions,
}: {
  title: string;
  rows: Row[];
  series: Series[];
  height?: number;
  unit: string;
  stacked?: boolean;
  format?: (v: number) => string;
  note?: string;
  actions?: React.ReactNode;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const VH = height;
  const iw = VW - M.l - M.r;
  const ih = VH - M.t - M.b;

  const now = rows.length ? rows[rows.length - 1]!.t : Date.now();
  const t0 = now - WINDOW_MS;
  const x = (t: number) => M.l + ((t - t0) / WINDOW_MS) * iw;

  const { yMax, layers } = useMemo(() => {
    // For stacked charts, layers[i][j] = [base, top] of series i at row j.
    const layers: [number, number][][] = series.map(() => []);
    let max = 0;
    rows.forEach((r, j) => {
      let acc = 0;
      series.forEach((s, i) => {
        const v = r.values[s.key] ?? 0;
        const base = stacked ? acc : 0;
        const top = stacked ? acc + v : v;
        layers[i]![j] = [base, top];
        acc = top;
        if (r.values[s.key] != null) max = Math.max(max, top);
      });
    });
    return { yMax: niceStep((max * 1.05) / 4) * 4, layers };
  }, [rows, series, stacked]);

  const y = (v: number) => M.t + ih - (v / yMax) * ih;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);

  const linePath = (i: number) => {
    let d = "";
    let pen = false;
    rows.forEach((r, j) => {
      const v = r.values[series[i]!.key];
      if (v == null) { pen = false; return; }
      const top = layers[i]![j]![1];
      d += `${pen ? "L" : "M"}${x(r.t).toFixed(1)} ${y(top).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  const areaPath = (i: number) => {
    if (!rows.length) return "";
    const top = rows.map((r, j) => `${x(r.t).toFixed(1)} ${y(layers[i]![j]![1]).toFixed(1)}`);
    const bot = rows.map((r, j) => `${x(r.t).toFixed(1)} ${y(layers[i]![j]![0]).toFixed(1)}`).reverse();
    return `M${top.join("L")}L${bot.join("L")}Z`;
  };

  // End labels: the latest value of each series, nudged apart so they never collide.
  const ends = useMemo(() => {
    if (!rows.length) return [];
    const j = rows.length - 1;
    const items = series
      .map((s, i) => ({ s, v: rows[j]!.values[s.key], top: layers[i]![j]?.[1] ?? 0, base: layers[i]![j]?.[0] ?? 0 }))
      .filter((e) => e.v != null && (!stacked || (e.v as number) > 0))
      .map((e) => ({ ...e, py: y(stacked ? (e.base + e.top) / 2 : e.top) }))
      .sort((a, b) => a.py - b.py);
    for (let k = 1; k < items.length; k++) {
      if (items[k]!.py - items[k - 1]!.py < 15) items[k]!.py = items[k - 1]!.py + 15;
    }
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, series, layers, yMax, stacked]);

  const pick = (clientX: number) => {
    const svg = ref.current;
    if (!svg || !rows.length) return;
    const box = svg.getBoundingClientRect();
    const vx = ((clientX - box.left) / box.width) * VW;
    let best = 0;
    let bd = Infinity;
    rows.forEach((r, j) => {
      const d = Math.abs(x(r.t) - vx);
      if (d < bd) { bd = d; best = j; }
    });
    setHover(best);
  };

  const h = hover != null ? rows[hover] : undefined;
  const xTicks = [0, 30, 60, 90, 120].map((sAgo) => ({ t: now - sAgo * 1000, label: sAgo === 0 ? "now" : `${sAgo}s ago` }));

  return (
    <figure className="chart" style={{ margin: 0 }}>
      <div className="chart-head">
        <h3>{title}</h3>
        {actions}
      </div>
      <div className="chart-head">
        <ul className="legend" aria-label="Series">
          {series.map((s) => (
            <li key={s.key}>
              <span className={`sw${stacked ? " block" : ""}`} style={{ background: s.color }} />
              {s.label}
            </li>
          ))}
        </ul>
      </div>
      {rows.length < 2 ? (
        <div className="chart-empty">Waiting for data. Send some requests from the playground below.</div>
      ) : (
        <>
          <svg
            ref={ref}
            className="chart-svg"
            viewBox={`0 0 ${VW} ${VH}`}
            role="img"
            aria-label={`${title}. Latest: ${ends.map((e) => `${e.s.label} ${format(e.v as number)} ${unit}`).join(", ")}.`}
            tabIndex={0}
            onMouseMove={(e) => pick(e.clientX)}
            onMouseLeave={() => setHover(null)}
            onBlur={() => setHover(null)}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") setHover((v) => Math.max(0, (v ?? rows.length - 1) - 1));
              if (e.key === "ArrowRight") setHover((v) => Math.min(rows.length - 1, (v ?? rows.length - 2) + 1));
              if (e.key === "Escape") setHover(null);
            }}
          >
            <g className="grid">
              {ticks.map((t) => <line key={t} x1={M.l} x2={M.l + iw} y1={y(t)} y2={y(t)} />)}
            </g>
            <g className="axis">
              {ticks.map((t) => (
                <text key={t} x={M.l - 8} y={y(t) + 4} textAnchor="end">{format(t)}</text>
              ))}
              {xTicks.map((t) => (
                <text key={t.label} x={x(t.t)} y={VH - 6} textAnchor={t.label === "now" ? "end" : "middle"}>{t.label}</text>
              ))}
              <text x={M.l - 8} y={10} textAnchor="end" style={{ fontSize: 10.5 }}>{unit}</text>
            </g>

            {stacked
              ? series.map((s, i) => (
                  <path key={s.key} d={areaPath(i)} fill={s.color} fillOpacity={0.85} stroke="var(--surface)" strokeWidth={2} strokeLinejoin="round" />
                ))
              : series.map((s, i) => <path key={s.key} className="series" d={linePath(i)} stroke={s.color} />)}

            {ends.map((e) => (
              <text key={e.s.key} className="end-label" x={M.l + iw + 8} y={e.py + 4}>
                {e.s.label.split(" ")[0]} {format(e.v as number)}
              </text>
            ))}

            {h && (
              <g>
                <line className="crosshair" x1={x(h.t)} x2={x(h.t)} y1={M.t} y2={M.t + ih} />
                {series.map((s, i) => {
                  const v = h.values[s.key];
                  if (v == null) return null;
                  const top = layers[i]![hover!]![1];
                  return <circle key={s.key} cx={x(h.t)} cy={y(top)} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />;
                })}
              </g>
            )}
            <rect x={M.l} y={M.t} width={iw} height={ih} fill="transparent" />
          </svg>
          {h && (
            <div
              className="tooltip"
              style={{
                left: `${Math.min(78, Math.max(4, (x(h.t) / VW) * 100))}%`,
                top: 36,
                transform: x(h.t) > VW * 0.6 ? "translateX(-105%)" : "translateX(8px)",
              }}
            >
              <div className="t">{Math.round((now - h.t) / 1000)} s ago</div>
              {[...series].reverse().map((s) => (
                <div className="row" key={s.key}>
                  <span><i className="sw block" style={{ background: s.color, width: 8, height: 8, borderRadius: 2, display: "inline-block" }} />{s.label}</span>
                  <b>{h.values[s.key] == null ? "–" : `${format(h.values[s.key] as number)} ${unit}`}</b>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {note && <figcaption className="small faint" style={{ marginTop: 6 }}>{note}</figcaption>}
    </figure>
  );
}
