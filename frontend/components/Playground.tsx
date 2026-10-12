"use client";

import { useEffect, useRef, useState } from "react";
import { infer, inferMany, type InferResult } from "@/lib/api";
import { ms, num } from "./format";

const PRESETS = [
  "What is the capital of France?",
  "Which city is the capital of France?",
  "What is the capital of Germany?",
  "How do I reset my password?",
  "I forgot my password, how can I recover it?",
  "How tall is Mount Everest?",
];

const SUBJECTS = [
  "capital of France", "boiling point of water", "speed of light", "height of Mount Everest",
  "author of Pride and Prejudice", "time zone of Tokyo", "population of India", "largest planet",
  "inventor of the telephone", "distance to the Moon", "founder of Microsoft", "fastest land animal",
];
const TEMPLATES = ["What is the {s}?", "Tell me the {s}", "{s}?", "What's the {s}", "Give me the {s}"];

function trafficQuery(repeatShare: number): string {
  if (Math.random() < repeatShare) {
    const s = SUBJECTS[Math.floor(Math.random() ** 1.6 * SUBJECTS.length)]!;
    const t = TEMPLATES[Math.floor(Math.random() * TEMPLATES.length)]!;
    return t.replace("{s}", s);
  }
  const w = () => Array.from({ length: 3 }, () => "bcdfghjklmnprstvz"[Math.floor(Math.random() * 17)]! + "aeiou"[Math.floor(Math.random() * 5)]!).join("");
  return `How does the ${w()} ${w()} work?`;
}

function Answer({ r }: { r: InferResult }) {
  if (!r.ok) {
    const e = r.body.error;
    return (
      <li>
        <span className="q">{r.input}</span>
        <span className="ms" style={{ color: "var(--critical)" }}>{r.status || "–"}</span>
        <span className="path">
          <span className="tag"><i style={{ background: "var(--s-rejected)" }} />{e.code.replaceAll("_", " ").toLowerCase()}</span>{" "}
          {e.message}
          {e.retry_after_ms != null && ` Retry in ${(e.retry_after_ms / 1000).toFixed(1)} s.`}
        </span>
      </li>
    );
  }
  const b = r.body;
  const sim = b.similarity != null ? b.similarity.toFixed(3) : null;
  return (
    <li>
      <span className="q">{r.input}</span>
      <span className="ms">{ms(b.total_latency_ms)}<span className="small muted"> ms</span></span>
      <span className="path">
        {b.source === "cache" && (
          <>
            <span className="tag"><i style={{ background: "var(--s-cache)" }} />Cache hit</span> at similarity {sim}, reusing the answer to “{b.matched_query}”. The model was not called.
          </>
        )}
        {b.source === "degraded_cache" && (
          <>
            <span className="tag"><i style={{ background: "var(--s-degraded)" }} />Degraded</span> The model was unavailable ({b.degraded_reason?.replaceAll("_", " ")}), so the closest cached answer was returned: “{b.matched_query}”, similarity {sim}.
          </>
        )}
        {b.source === "model" && (
          <>
            <span className="tag"><i style={{ background: "var(--s-model)" }} />Model</span> in batch {b.batch_id} with {num((b.batch_size ?? 1) - 1)} other request{b.batch_size === 2 ? "" : "s"}. Model call {ms(b.model_latency_ms)} ms.
          </>
        )}
      </span>
    </li>
  );
}

export function Playground() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [bypass, setBypass] = useState(false);
  const [answers, setAnswers] = useState<InferResult[]>([]);
  const [rate, setRate] = useState(20);
  const [repeat, setRepeat] = useState(0.7);
  const [traffic, setTraffic] = useState(false);
  const [burstNote, setBurstNote] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const ask = async (q: string) => {
    if (!q.trim()) return;
    setBusy(true);
    const r = await infer(q.trim(), bypass ? { cache: false } : undefined);
    setAnswers((a) => [r, ...a].slice(0, 8));
    setBusy(false);
  };

  // Background traffic with Poisson arrivals, so the charts have something to show.
  useEffect(() => {
    if (!traffic) return;
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      void infer(trafficQuery(repeat));
      timer.current = setTimeout(tick, (-Math.log(1 - Math.random()) / Math.max(0.5, rate)) * 1000);
    };
    tick();
    return () => {
      stopped = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [traffic, rate, repeat]);

  const burst = async () => {
    setBurstNote("Sending 64 new questions at once…");
    try {
      const rs = await inferMany(Array.from({ length: 64 }, () => trafficQuery(0)));
      const ok = rs.filter((r) => r.ok && r.source === "model");
      const ids = new Set(ok.map((r) => r.batch_id));
      const slowest = Math.max(...ok.map((r) => r.total_latency_ms ?? 0));
      setBurstNote(
        ok.length
          ? `${ok.length} questions reached the model in ${ids.size} batch${ids.size === 1 ? "" : "es"}. The slowest answer took ${ms(slowest)} ms on the server.`
          : "None reached the model. Check the breaker.",
      );
    } catch {
      setBurstNote("The burst failed to send. Check the connection.");
    }
  };

  return (
    <div className="split">
      <div>
        <form
          className="ask"
          onSubmit={(e) => {
            e.preventDefault();
            void ask(text);
          }}
        >
          <label htmlFor="ask" className="visually-hidden">Question to send</label>
          <input id="ask" value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask anything, then ask it again in other words" />
          <button className="btn primary" type="submit" disabled={busy || !text.trim()}>Send</button>
        </form>
        <div className="presets" aria-label="Example questions">
          {PRESETS.map((p) => (
            <button key={p} type="button" onClick={() => { setText(p); void ask(p); }}>{p}</button>
          ))}
        </div>
        <label className="toggle" style={{ marginTop: 12 }}>
          <input type="checkbox" checked={bypass} onChange={(e) => setBypass(e.target.checked)} />
          Skip the cache for my questions (asks for a fresh answer, which then refreshes the cache)
        </label>
        {answers.length === 0 ? (
          <p className="small faint" style={{ marginTop: 18 }}>
            Try a preset, then its rewording. The second answer should come from the cache in about a millisecond.
          </p>
        ) : (
          <ul className="answers" aria-live="polite">
            {answers.map((r, i) => <Answer key={`${r.body.request_id}-${i}`} r={r} />)}
          </ul>
        )}
      </div>

      <div>
        <div className="panel">
          <h3>Background traffic</h3>
          <div className="field">
            <label htmlFor="rate">Requests per second <b>{rate}</b></label>
            <input id="rate" type="range" min={1} max={120} value={rate} onChange={(e) => setRate(Number(e.target.value))} />
          </div>
          <div className="field" style={{ marginTop: 12 }}>
            <label htmlFor="repeat">Share that repeat a popular question <b>{Math.round(repeat * 100)}%</b></label>
            <input id="repeat" type="range" min={0} max={1} step={0.05} value={repeat} onChange={(e) => setRepeat(Number(e.target.value))} />
          </div>
          <div className="row" style={{ marginTop: 14 }}>
            <button className={`btn${traffic ? "" : " primary"}`} type="button" onClick={() => setTraffic((v) => !v)} aria-pressed={traffic}>
              {traffic ? "Stop traffic" : "Start traffic"}
            </button>
            <button className="btn" type="button" onClick={() => void burst()}>Send a burst of 64</button>
          </div>
          {burstNote && <p className="small muted" style={{ marginTop: 10 }} aria-live="polite">{burstNote}</p>}
        </div>
      </div>
    </div>
  );
}
