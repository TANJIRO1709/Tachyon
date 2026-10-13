# Deploying Tachyon

**Backend on Render, dashboard on Vercel.** Deploy the backend first: the dashboard needs its URL at build time.

---

## Why the backend cannot go on Vercel

Worth understanding, because it is a fact about your own architecture and a good interview answer.

Vercel runs **serverless functions**: each request may land in a fresh, short-lived instance, and Vercel scales by starting more of them. Tachyon is built on the opposite assumption — **one long-lived process holding state in memory**:

| What Tachyon does | What serverless does to it |
| --- | --- |
| Holds requests in a queue for up to 50 ms so they can share one model call | Two concurrent requests may land in two different instances, so there is nothing to batch with. **Batching stops working entirely.** |
| Keeps a background loop watching that queue | Functions are frozen between invocations; a timer waiting 50 ms has no process to wake up in |
| Keeps 10,000 cached answers in memory | Each instance gets its own cache, and loses it when recycled. The hit rate collapses |
| Counts consecutive failures to trip the breaker | Each instance counts separately, so five failures spread over five instances never trip anything |
| Holds an SSE connection open for the dashboard | Function duration limits cut it |
| Loads a ~90 MB model plus the ONNX native runtime | Far past the practical bundle size for a function |

So: **Vercel for the dashboard** (which is exactly what it is for) and **Render for the backend** (which runs an ordinary container that stays up).

Being able to say *"my serving layer is stateful by design, so it needs a container, not a function"* is worth more in an interview than having deployed it anywhere.

---

## Step 1 — Put the project on GitHub

```bash
cd tachyon
git init
git add .
git commit -m "Tachyon: real-time inference serving layer"
git branch -M main
git remote add origin https://github.com/<your-username>/tachyon.git
git push -u origin main
```

`.gitignore` already excludes `node_modules/`, `dist/` and `.next/`.

---

## Step 2 — Backend on Render

### Through the dashboard

1. Go to [dashboard.render.com](https://dashboard.render.com) and sign in with GitHub.
2. **New → Web Service**, then pick your `tachyon` repository.
3. Set:

| Field | Value |
| --- | --- |
| Name | `tachyon-backend` |
| Language / Runtime | **Docker** |
| Root Directory | `backend` |
| Dockerfile Path | `./Dockerfile` (relative to the root directory) |
| Region | Singapore is closest to India |
| Instance Type | Free to start |
| Health Check Path | `/readyz` |

4. Add these **environment variables**:

| Key | Value | Why |
| --- | --- | --- |
| `EMBEDDER` | `minilm` | real semantic matching, not the lexical fallback |
| `MODEL_BACKEND` | `stub` | the simulated accelerator the benchmarks use |
| `CACHE_THRESHOLD` | `0.92` | tune later with `npm run bench:sweep` |
| `CORS_ORIGINS` | `*` | so your Vercel URL and its preview deployments can reach it |
| `ADMIN_TOKEN` | *(leave empty)* | keeps the demo controls usable by visitors |

Do **not** set `PORT`. Render injects it, and the server reads it.

5. Add these **Docker build arguments** (under Advanced, if your plan exposes them):

| Key | Value | Why |
| --- | --- | --- |
| `WITH_MODELS` | `true` | bakes the embedder into the image so startup needs no network |
| `PREFETCH_HF_MODEL` | `false` | skips DistilBERT's ~260 MB, unused with the stub |

If you cannot set build args on your plan, the defaults in the Dockerfile already match these values.

6. **Create Web Service.** The first build takes several minutes, mostly downloading the model and the ONNX runtime.

### Or through the blueprint

`render.yaml` at the repo root holds all of the above. **New → Blueprint**, point it at the repo, and Render reads it. If Render rejects a key, its blueprint schema has moved on; use the dashboard route instead.

### Check it

```bash
curl https://tachyon-backend.onrender.com/healthz
curl https://tachyon-backend.onrender.com/readyz
curl -s https://tachyon-backend.onrender.com/v1/infer \
  -H 'content-type: application/json' -d '{"input":"What is the capital of France?"}'
```

`/readyz` returns `warming` while the model loads and `ready` once it is serving. **Copy the service URL**; the dashboard needs it.

---

## Step 3 — Dashboard on Vercel

1. Go to [vercel.com/new](https://vercel.com/new) and import the same repository.
2. Set **Root Directory** to `frontend`. Vercel detects Next.js by itself; leave the build and output settings alone.
3. Add one **environment variable**:

| Key | Value |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | `https://tachyon-backend.onrender.com` |

No trailing slash. Use your real Render URL.

4. **Deploy.**

> **`NEXT_PUBLIC_*` variables are baked in at build time**, not read when the page loads. If you change this value later, you must **redeploy** for it to take effect. This is the single most common reason a deployed dashboard shows "Not connected".

---

## Step 4 — Lock CORS down (optional, after it works)

While `CORS_ORIGINS=*`, any website can call your API. For a stub-backed demo that is harmless, and it keeps Vercel's preview URLs working. To restrict it to your own site, set on Render:

```
CORS_ORIGINS = https://tachyon-yourname.vercel.app
```

Preview deployments get different URLs, so they will stop working. Comma-separate to allow several.

---

## The free-tier trade-off, stated honestly

Render's free instances **sleep after about 15 minutes of inactivity**, and the next request takes roughly a minute to wake them. For a project whose entire point is latency, an interviewer clicking your link and waiting a minute is a bad first impression.

Three ways to handle it:

1. **Warm it before a demo.** Open the backend URL a minute before you share your screen.
2. **Pay for the smallest always-on instance** (a few dollars a month) while you are interviewing.
3. **Treat the deploy as a bonus, not the main demo.** Run `docker compose up` locally when screen-sharing, where it is genuinely fast, and keep the live URL for people browsing your resume on their own.

Say the quiet part out loud on your README: *"hosted on a free tier that sleeps; the latency numbers in this README were measured locally."* That is more credible than letting someone think 60 seconds is your p99.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Dashboard says "Not connected" | `NEXT_PUBLIC_API_URL` wrong, or set after the build | Fix it on Vercel, then **redeploy** |
| Browser console: blocked mixed content | Backend URL is `http://` | Use the `https://` Render URL |
| Browser console: CORS error | `CORS_ORIGINS` does not include your site | Set it to `*`, or to your exact Vercel domain |
| First request takes a minute | Free instance was asleep | Expected; see above |
| Render deploy fails: out of memory | fp32 model on a 512 MB instance | Set build arg `EMBEDDER_DTYPE=q8` and env `EMBEDDER_DTYPE=q8`, then re-run `npm run bench:sweep` because similarity scores shift |
| Render build times out | Model download during build | Set `WITH_MODELS=false` and env `EMBEDDER=hash` to get it running, then revisit |
| `/readyz` stays `warming` | Model still loading, or it failed | Check Render logs for `model_download` and `startup_failed` lines |
| Everything 503s with `NOT_READY` | Same as above | Wait for `/readyz` to return `ready` |

---

## What to put on your resume

> **Tachyon — real-time AI inference serving layer** · [live](https://tachyon-yourname.vercel.app) · [code](https://github.com/you/tachyon)
> Node/TypeScript serving layer with hand-written dynamic batching, a semantic cache, and a circuit breaker with graceful degradation. **10.5× throughput** at 64 concurrent clients; p99 **59 s → 320 ms** under 100 req/s of offered load; 0.085 ms cached responses. Prometheus metrics and structured logs; 72 tests.

Link both. The code is what gets read; the live URL is what gets clicked.
