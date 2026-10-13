/** Process entry point: one Node process, one event loop. The batch queue and
 *  the cache must be shared by every request, so this is NOT clustered.
 *  Scale with replicas, not workers. */
import { buildApp } from "./app.js";
import { loadSettings } from "./config.js";
import { InferenceService } from "./service.js";

const settings = loadSettings();
const service = new InferenceService(settings);
const app = await buildApp(settings, service);

// Listen first, then load models: a first start downloads the weights, and
// the process should be reachable (healthz, readyz = warming) meanwhile.
await app.listen({ host: settings.host, port: settings.port });
service.telemetry.log("listening", { url: `http://${settings.host}:${settings.port}`, embedder: settings.embedder, backend: settings.model_backend });

service.start().catch((err: Error) => {
  service.telemetry.log("startup_failed", {
    error: `${err.name}: ${err.message}`,
    hint: settings.embedder === "minilm"
      ? "Could not load the MiniLM model. Check your connection and run again (weights are cached once downloaded), or start without it: EMBEDDER=hash npm run dev"
      : "See the error above.",
  }, "error");
  process.exit(1);
});

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  service.telemetry.log("shutdown_requested", { signal });
  // Stop accepting, let in-flight requests finish, drain the batchers.
  const force = setTimeout(() => process.exit(1), 35_000);
  force.unref();
  await app.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
