/** Shared Transformers.js setup.
 *
 * Models are downloaded from the HuggingFace Hub on first use (public models,
 * no key) and cached on disk; after that they run fully in-process through
 * ONNX Runtime. With HF_HUB_OFFLINE=1 nothing is fetched at runtime: the
 * container bakes the weights in at build time and must start without network.
 */
export async function loadTransformers() {
  const t = await import("@huggingface/transformers");
  if (process.env.HF_HUB_OFFLINE === "1") {
    t.env.allowRemoteModels = false;
    t.env.allowLocalModels = true;
  }
  if (process.env.TRANSFORMERS_CACHE) t.env.cacheDir = process.env.TRANSFORMERS_CACHE;
  return t;
}

type ProgressEvent = { status?: string; file?: string; progress?: number; loaded?: number; total?: number };

/** A progress callback that logs each model file's download in 10% steps, so a
 *  first start on a slow connection is visibly downloading, not hung. Files
 *  already in the cache produce no download lines. */
export function downloadLogger(model: string, log: (msg: string) => void) {
  const lastStep = new Map<string, number>();
  return (e: ProgressEvent) => {
    if (e.status !== "progress" || !e.file || e.progress === undefined) return;
    const step = Math.floor(e.progress / 10) * 10;
    if ((lastStep.get(e.file) ?? -1) >= step) return;
    lastStep.set(e.file, step);
    const mb = e.total ? ` of ${(e.total / 1_048_576).toFixed(1)} MB` : "";
    log(`downloading ${model}/${e.file}: ${step}%${mb}`);
  };
}
