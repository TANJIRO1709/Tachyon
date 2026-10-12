import type { Config, InferError, InferResponse } from "./types";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000").replace(/\/$/, "");

export type InferResult =
  | { ok: true; status: number; body: InferResponse; clientMs: number; input: string }
  | { ok: false; status: number; body: InferError; clientMs: number; input: string };

export async function infer(input: string, options?: { cache?: boolean }): Promise<InferResult> {
  const t0 = performance.now();
  try {
    const r = await fetch(`${API_URL}/v1/infer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input, options: options ?? {} }),
    });
    const body = await r.json();
    const clientMs = performance.now() - t0;
    return r.ok
      ? { ok: true, status: r.status, body: body as InferResponse, clientMs, input }
      : { ok: false, status: r.status, body: body as InferError, clientMs, input };
  } catch {
    return {
      ok: false,
      status: 0,
      clientMs: performance.now() - t0,
      input,
      body: {
        request_id: "",
        error: { code: "UNREACHABLE", message: `Could not reach ${API_URL}.`, retry_after_ms: null, circuit_state: null },
      },
    };
  }
}

/** Many inputs in one HTTP request. Each still goes through the full pipeline
 *  on the server, so they reach the batcher together. (A browser opens at most
 *  six connections per host, so 64 separate fetches would arrive six at a time
 *  and the batches would reflect the browser, not the server.) */
export async function inferMany(inputs: string[]): Promise<{ ok: boolean; batch_id?: string | null; source?: string; total_latency_ms?: number }[]> {
  const r = await fetch(`${API_URL}/v1/infer/batch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inputs }),
  });
  if (!r.ok) throw new Error(`${r.status}`);
  return (await r.json()).results;
}

async function call(path: string, init: RequestInit): Promise<Response> {
  const r = await fetch(`${API_URL}${path}`, init);
  if (!r.ok && r.status !== 204) {
    const text = await r.text();
    throw new Error(text || `${r.status}`);
  }
  return r;
}

export const admin = {
  patchConfig: (patch: Partial<Config>) =>
    call("/v1/admin/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }),
  setFault: (mode: "none" | "error" | "slow" | "flaky", extra?: { failure_rate?: number; extra_latency_ms?: number }) =>
    call("/v1/admin/backend/fault", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode, ...extra }),
    }),
  flushCache: () => call("/v1/admin/cache", { method: "DELETE" }),
  resetCircuit: () => call("/v1/admin/circuit/reset", { method: "POST" }),
};
