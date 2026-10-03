import { buildApp } from "../app";
import { loadConfig } from "../config/config";

// Re-embed everything knowledge search depends on for the current embedder.
// The default embedder is the small local model, so memory never leaves the
// server; set EMBEDDINGS_URL to use a hosted endpoint instead.
const cfg = loadConfig();
const app = buildApp({});
console.log(`Re-embedding all memory (profile: ${cfg.profile}). First run downloads the local model; this can take a minute.`);
const n = await app.svc.embeddings.reembedAll();
const c = app.svc.embeddings.count();
console.log(`Done: ${n} new vectors. Now ${c.vectors} vectors for model ${c.model ?? "(none)"} with ${c.dims ?? "?"} dims.`);
app.stop();
