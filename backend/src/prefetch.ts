/** Download the model weights once, so the server starts offline.
 *  Used at Docker build time: `node dist/src/prefetch.js`. */
import { loadSettings } from "./config.js";
import { loadTransformers } from "./transformers.js";

const { pipeline } = await loadTransformers();

const s = loadSettings();
await pipeline("feature-extraction", s.embedder_model, { dtype: s.embedder_dtype as "fp32" });
console.log(`cached ${s.embedder_model}`);
if (process.env.PREFETCH_HF_MODEL !== "false") {
  await pipeline(s.hf_task as "sentiment-analysis", s.hf_model);
  console.log(`cached ${s.hf_model}`);
}
