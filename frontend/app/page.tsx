"use client";

import { useEffect, useMemo, useState } from "react";
import { API_URL } from "@/lib/api";
import { useStream } from "@/lib/useStream";
import { Pipeline } from "@/components/Pipeline";
import { TimeChart, type Series } from "@/components/TimeChart";
import { BatchHistogram } from "@/components/BatchHistogram";
import { BreakerPanel, CachePanel } from "@/components/Panels";
import { Playground } from "@/components/Playground";
import { Controls } from "@/components/Controls";
import { LogTail } from "@/components/LogTail";

type Q = "p50" | "p95" | "p99";

const LAT_SERIES: Series[] = [
  { key: "total", label: "End to end", color: "var(--s-total)" },
  { key: "model", label: "Model call", color: "var(--s-model)" },
  { key: "cache", label: "Cache hit", color: "var(--s-cache)" },
];
const RATE_SERIES: Series[] = [
  { key: "model", label: "Model", color: "var(--s-model)" },
  { key: "cache", label: "Cache", color: "var(--s-cache)" },
  { key: "degraded", label: "Degraded", color: "var(--s-degraded)" },
  { key: "rejected", label: "Rejected", color: "var(--s-rejected)" },
];

function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);
  useEffect(() => {
    const t = document.documentElement.dataset.theme;
    setTheme(t === "dark" || t === "light" ? t : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  }, []);
  if (!theme) return null;
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      className="btn" type="button"
      onClick={() => {
        document.documentElement.dataset.theme = next;
        try { localStorage.setItem("tachyon-theme", next); } catch { /* storage unavailable */ }
        setTheme(next);
      }}
    >
      {next === "dark" ? "Dark theme" : "Light theme"}
    </button>
  );
}

export default function Page() {
  const { stats, history, logs, connected, lastError } = useStream();
  const [q, setQ] = useState<Q>("p95");

  const latRows = useMemo(
    () => history.map((p) => ({ t: p.t, values: { total: p.total[q], model: p.model[q], cache: p.cacheHit[q] } })),
    [history, q],
  );
  const rateRows = useMemo(
    () => history.map((p) => ({ t: p.t, values: { model: p.rps.model, cache: p.rps.cache, degraded: p.rps.degraded_cache, rejected: p.rps.rejected } })),
    [history],
  );

  return (
    <main className="page">
      <header className="masthead">
        <div>
          <h1>Tachyon</h1>
          <p className="what">The serving layer in front of the model: batching, a semantic cache and a circuit breaker, live.</p>
        </div>
        <div className="masthead-side">
          <span className="conn" data-on={connected}>
            <i aria-hidden="true" />
            {connected ? `Live from ${API_URL.replace(/^https?:\/\//, "")}` : "Not connected"}
          </span>
          <ThemeToggle />
        </div>
      </header>
      {lastError && (
        <p className="notice" role="status">
          {lastError} Start the backend with <code>docker compose up</code> or <code>uvicorn app.main:app</code>.
        </p>
      )}

      <Pipeline stats={stats} history={history} />

      <section className="section split" aria-label="Latency and throughput">
        <div className="stack-v">
          <div>
            <TimeChart
              actions={
                <div className="seg" role="group" aria-label="Percentile">
                  {(["p50", "p95", "p99"] as Q[]).map((k) => (
                    <button key={k} type="button" aria-pressed={q === k} onClick={() => setQ(k)}>{k}</button>
                  ))}
                </div>
              }
              title={`Latency, ${q}`}
              rows={latRows}
              series={LAT_SERIES}
              unit="ms"
              format={(v) => (v < 10 ? v.toFixed(1) : v.toFixed(0))}
              note="Each point covers the last five seconds. A gap between end to end and model call is time spent queueing, not computing."
            />
          </div>
          <TimeChart
            title="Requests per second, by who answered"
            rows={rateRows}
            series={RATE_SERIES}
            unit="req/s"
            stacked
            format={(v) => (v < 10 ? v.toFixed(1) : v.toFixed(0))}
          />
          <BatchHistogram stats={stats} />
        </div>
        <aside>
          <BreakerPanel stats={stats} />
          <CachePanel stats={stats} />
        </aside>
      </section>

      <section className="section" aria-labelledby="try-h">
        <div className="section-head">
          <h2 id="try-h">Try it</h2>
          <p>Questions go through the same endpoint as any client. Ask one, then ask it again in other words.</p>
        </div>
        <Playground />
      </section>

      <section className="section" aria-labelledby="ctl-h">
        <div className="section-head">
          <h2 id="ctl-h">Break it</h2>
          <p>Make the model fail or slow down and watch the breaker open, the cache take over, and the probes bring it back.</p>
        </div>
        <Controls stats={stats} />
      </section>

      <section className="section" aria-labelledby="log-h">
        <div className="section-head">
          <h2 id="log-h">Request log</h2>
          <p>One structured line per request, the same lines the server writes to stdout.</p>
        </div>
        <LogTail logs={logs} />
      </section>

      <footer className="footer">
        <a href={`${API_URL}/metrics`}>Prometheus metrics</a>
        <a href={`${API_URL}/docs`}>API reference</a>
        <span>{stats ? `Up for ${Math.round(stats.uptime_s)} s` : ""}</span>
      </footer>
    </main>
  );
}
