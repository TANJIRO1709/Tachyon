/** HTTP surface. Thin on purpose: validation, request IDs, error shaping.
 *  All serving logic lives in service.ts. */
import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import cors from "@fastify/cors";
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Settings, applyPatch, mutableView } from "./config.js";
import { StubBackend } from "./modelBackend.js";
import { InferOptions, InferOutcome, InferenceService, ServiceError } from "./service.js";

const VERSION = "1.0.0";

const optionsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    cache: { type: "boolean" },
    cache_threshold: { type: "number", minimum: 0, maximum: 1 },
    max_wait_ms: { type: "number", exclusiveMinimum: 0, maximum: 600_000 },
  },
} as const;

type OptionsIn = { cache?: boolean; cache_threshold?: number; max_wait_ms?: number };

function toOptions(o: OptionsIn | undefined): InferOptions {
  return { cache: o?.cache ?? true, cacheThreshold: o?.cache_threshold, maxWaitMs: o?.max_wait_ms };
}

function outcomeJson(o: InferOutcome) {
  return {
    request_id: o.requestId,
    output: o.output,
    cached: o.cached,
    degraded: o.degraded,
    degraded_reason: o.degradedReason,
    source: o.source,
    similarity: o.similarity,
    matched_query: o.matchedQuery,
    cache_age_s: o.cacheAgeS,
    batch_id: o.batchId,
    batch_size: o.batchSize,
    circuit_state: o.circuitState,
    model_latency_ms: o.timings.model_latency_ms,
    total_latency_ms: o.timings.total_latency_ms,
    timings_ms: o.timings,
  };
}

function requestId(req: FastifyRequest): string {
  const h = req.headers["x-request-id"];
  const v = (Array.isArray(h) ? h[0] : h)?.trim();
  return v ? v.slice(0, 128) : randomUUID();
}

function sendError(
  reply: FastifyReply, rid: string, code: string, status: number, message: string,
  extra: { retryAfterS?: number | null; circuitState?: string | null; details?: unknown; timings?: unknown } = {},
) {
  const body: Record<string, unknown> = {
    request_id: rid,
    error: {
      code, message,
      retry_after_ms: extra.retryAfterS == null ? null : Math.round(extra.retryAfterS * 1000),
      circuit_state: extra.circuitState ?? null,
      ...(extra.details !== undefined ? { details: extra.details } : {}),
    },
  };
  if (extra.timings) body.timings_ms = extra.timings;
  reply.header("X-Request-ID", rid);
  // Whole seconds per RFC 9110; round up so clients never retry early.
  if (extra.retryAfterS != null) reply.header("Retry-After", String(Math.max(1, Math.ceil(extra.retryAfterS))));
  return reply.code(status).send(body);
}

export async function buildApp(settings: Settings, service: InferenceService): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });
  // CORS_ORIGINS is a comma-separated allow-list, or "*" for any origin.
  // A deployed demo usually wants "*": Vercel mints a new preview URL for every
  // deployment, and this API serves no private data. Pin it to real domains the
  // moment the server sits in front of anything that costs money.
  const origins = settings.cors_origins.split(",").map((o) => o.trim()).filter(Boolean);
  const anyOrigin = origins.includes("*");
  const allowOrigin = (origin: string | undefined): boolean => !!origin && (anyOrigin || origins.includes(origin));
  await app.register(cors, {
    origin: anyOrigin ? true : origins,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    exposedHeaders: ["X-Request-ID", "Retry-After"],
  });

  const streams = new Set<ServerResponse>();
  // The service is NOT started in a Fastify hook: loading a model can take
  // minutes on a first start (it downloads the weights), far past Fastify's
  // 10 s hook timeout. The caller starts it after listen(); until then
  // /healthz answers, /readyz says "warming" and inference returns 503.
  // SSE responses never end on their own; close them so shutdown can finish.
  app.addHook("preClose", async () => { for (const s of streams) s.end(); });
  app.addHook("onClose", async () => { await service.stop(); });

  app.setErrorHandler((err: any, req, reply) => {
    const rid = requestId(req);
    if (err.validation) {
      return sendError(reply, rid, "INVALID_REQUEST", 400, "Request body failed validation.", {
        details: err.validation.map((v: any) => ({ loc: v.instancePath || v.params?.missingProperty || "", msg: v.message })),
      });
    }
    if (err.statusCode && err.statusCode < 500) {
      return sendError(reply, rid, "INVALID_REQUEST", err.statusCode, err.message);
    }
    service.telemetry.log("unhandled_error", { request_id: rid, error: String(err?.stack ?? err) }, "error");
    return sendError(reply, rid, "INTERNAL", 500, "Unexpected server error.");
  });

  // ------------------------------------------------------------ inference
  app.post<{ Body: { input: string; options?: OptionsIn } }>("/v1/infer", {
    schema: {
      body: {
        type: "object", required: ["input"], additionalProperties: false,
        properties: { input: { type: "string", minLength: 1 }, options: optionsSchema },
      },
    },
  }, async (req, reply) => {
    const rid = requestId(req);
    const input = req.body.input;
    if (!input.trim()) return sendError(reply, rid, "INVALID_REQUEST", 400, "input must not be blank");
    if (input.length > settings.max_input_chars) {
      return sendError(reply, rid, "INPUT_TOO_LARGE", 400, `input is ${input.length} characters; the limit is ${settings.max_input_chars}.`);
    }
    try {
      const out = await service.handle(input, toOptions(req.body.options), rid);
      reply.header("X-Request-ID", rid);
      return outcomeJson(out);
    } catch (e) {
      if (e instanceof ServiceError) {
        return sendError(reply, rid, e.code, e.status, e.message, { retryAfterS: e.retryAfterS, circuitState: e.circuitState, timings: e.timings });
      }
      throw e;
    }
  });

  /** Client-side batch. Each input still goes through the full pipeline, so
   *  cache hits return at once and only misses reach the batcher. */
  app.post<{ Body: { inputs: string[]; options?: OptionsIn } }>("/v1/infer/batch", {
    schema: {
      body: {
        type: "object", required: ["inputs"], additionalProperties: false,
        properties: { inputs: { type: "array", minItems: 1, maxItems: 256, items: { type: "string" } }, options: optionsSchema },
      },
    },
  }, async (req, reply) => {
    const base = requestId(req);
    const bad = req.body.inputs.flatMap((t, i) => (!t.trim() || t.length > settings.max_input_chars ? [i] : []));
    if (bad.length) return sendError(reply, base, "INVALID_REQUEST", 400, `inputs at positions [${bad.join(", ")}] are blank or too long.`);
    const opts = toOptions(req.body.options);
    const results = await Promise.all(req.body.inputs.map(async (text, i) => {
      const rid = `${base}-${i}`;
      try {
        return { ok: true, ...outcomeJson(await service.handle(text, opts, rid)) };
      } catch (e) {
        if (e instanceof ServiceError) return { ok: false, request_id: rid, error: { code: e.code, message: e.message, status: e.status } };
        throw e;
      }
    }));
    reply.header("X-Request-ID", base);
    return { request_id: base, results };
  });

  // -------------------------------------------------------- observability
  app.get("/metrics", async (_req, reply) => {
    reply.header("content-type", service.telemetry.registry.contentType);
    return service.telemetry.registry.metrics();
  });
  app.get("/healthz", async () => ({ status: "ok", version: VERSION }));
  app.get("/readyz", async (_req, reply) =>
    service.ready ? { status: "ready", embedder: service.embedder?.name ?? null } : reply.code(503).send({ status: "warming" }));
  app.get("/v1/stats", async () => service.stats());

  app.get<{ Querystring: { after_seq?: string; limit?: string; event?: string; request_id?: string; batch_id?: string } }>(
    "/v1/logs/recent",
    async (req) => {
      const q = req.query;
      let logs = service.telemetry.recentLogs({ afterSeq: Number(q.after_seq ?? 0) || 0, limit: 1000, event: q.event });
      if (q.request_id) logs = logs.filter((l) => String(l.request_id ?? "").startsWith(q.request_id!));
      if (q.batch_id) logs = logs.filter((l) => l.batch_id === q.batch_id);
      const limit = Math.min(1000, Math.max(1, Number(q.limit ?? 200) || 200));
      return { logs: logs.slice(-limit), log_seq: service.telemetry.logSeq };
    },
  );

  /** Server-sent events: a stats snapshot plus new log lines, every interval.
   *  The dashboard renders entirely from this stream. */
  app.get<{ Querystring: { interval_ms?: string } }>("/v1/stream", (req, reply) => {
    const interval = Math.min(10_000, Math.max(200, Number(req.query.interval_ms ?? 1000) || 1000));
    const origin = req.headers.origin;
    reply.hijack(); // we write the raw response ourselves, so add CORS by hand
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      ...(allowOrigin(origin) ? { "access-control-allow-origin": origin!, vary: "Origin" } : {}),
    });
    res.write("retry: 2000\n\n");
    streams.add(res);
    let lastSeq = Math.max(0, service.telemetry.logSeq - 50);
    const tick = () => {
      const logs = service.telemetry.recentLogs({ afterSeq: lastSeq, limit: 100 });
      if (logs.length) lastSeq = logs[logs.length - 1]!.seq;
      res.write(`event: snapshot\ndata: ${JSON.stringify({ stats: service.stats(), logs })}\n\n`);
    };
    tick();
    const timer = setInterval(tick, interval);
    const cleanup = () => {
      clearInterval(timer);
      streams.delete(res);
    };
    req.raw.on("close", cleanup);
    res.on("close", cleanup);
  });

  // ---------------------------------------------------------------- admin
  // Open by default (that is what makes the public demo interactive). Set
  // ADMIN_TOKEN to require a header on every /v1/admin/* route.
  app.addHook("onRequest", async (req, reply) => {
    if (!settings.admin_token || !req.url.startsWith("/v1/admin")) return;
    const sent = req.headers["x-admin-token"];
    if ((Array.isArray(sent) ? sent[0] : sent) !== settings.admin_token) {
      return sendError(reply, requestId(req), "UNAUTHORIZED", 401, "This endpoint requires a valid X-Admin-Token header.");
    }
  });

  app.get("/v1/admin/config", async () => {
    // Never echo the token back, even to a caller who just proved they have it.
    const { admin_token, ...safe } = settings;
    return { mutable: mutableView(settings), all: { ...safe, admin_token: admin_token ? "set" : "" } };
  });
  app.patch<{ Body: Record<string, unknown> }>("/v1/admin/config", { schema: { body: { type: "object" } } }, async (req, reply) => {
    let changed;
    try {
      changed = applyPatch(settings, req.body);
    } catch (e) {
      return sendError(reply, requestId(req), "INVALID_CONFIG", 400, (e as Error).message);
    }
    service.syncConfig();
    if (Object.keys(changed).length) service.telemetry.log("config_change", { changed });
    return { changed, mutable: mutableView(settings) };
  });

  const notReady = (req: FastifyRequest, reply: FastifyReply) =>
    sendError(reply, requestId(req), "NOT_READY", 503, "Service is still loading its models.", { retryAfterS: 2 });

  app.get<{ Querystring: { limit?: string } }>("/v1/admin/cache", async (req, reply) => {
    if (!service.cache) return notReady(req, reply);
    return {
      ...service.cache.snapshot(),
      recent: service.cache.recentEntries(Math.min(200, Math.max(1, Number(req.query.limit ?? 20) || 20))),
    };
  });
  app.delete("/v1/admin/cache", async (req, reply) => {
    if (!service.cache) return notReady(req, reply);
    const removed = service.cache.clear();
    service.telemetry.log("cache_flush", { removed });
    return reply.code(204).send();
  });
  app.get("/v1/admin/circuit", async () => service.breaker.snapshot());
  app.post("/v1/admin/circuit/reset", async (_req, reply) => {
    service.breaker.reset("manual reset via admin API");
    return reply.code(204).send();
  });
  app.get("/v1/admin/backend", async () => service.backend?.describe() ?? {});
  app.post<{ Body: { mode: "none" | "error" | "slow" | "flaky"; failure_rate?: number; extra_latency_ms?: number; duration_s?: number } }>(
    "/v1/admin/backend/fault",
    {
      schema: {
        body: {
          type: "object", required: ["mode"], additionalProperties: false,
          properties: {
            mode: { type: "string", enum: ["none", "error", "slow", "flaky"] },
            failure_rate: { type: "number", minimum: 0, maximum: 1 },
            extra_latency_ms: { type: "number", minimum: 0, maximum: 600_000 },
            duration_s: { type: "number", exclusiveMinimum: 0, maximum: 3600 },
          },
        },
      },
    },
    async (req, reply) => {
      if (!(service.backend instanceof StubBackend)) {
        return sendError(reply, requestId(req), "FAULTS_UNSUPPORTED", 409, "Fault injection is only available on the stub backend.");
      }
      const b = req.body;
      service.backend.setFault(b.mode, { failureRate: b.failure_rate, extraLatencyMs: b.extra_latency_ms, durationS: b.duration_s ?? null });
      service.telemetry.log("fault_injected", {
        mode: b.mode, failure_rate: b.failure_rate ?? 0, extra_latency_ms: b.extra_latency_ms ?? 0, duration_s: b.duration_s ?? null,
      }, "warn");
      return reply.code(204).send();
    },
  );

  return app;
}
