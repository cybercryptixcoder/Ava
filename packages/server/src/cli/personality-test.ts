import { buildApp } from "../app";
import { PersonalityRunner } from "../personality/runner";

// Re-runs the personality test set against the current voice files.
// Usage: npm run voice:test [-- --audio] [-- --label "after edit"]
async function main() {
  const app = buildApp({ config: { profile: process.env.AVA_PROFILE === "real" ? "real" : "test" } });
  if (!app.svc.models.available) {
    console.error("The personality test set needs ANTHROPIC_API_KEY.");
    process.exit(1);
  }
  const audio = process.argv.includes("--audio");
  const li = process.argv.indexOf("--label");
  const run = await new PersonalityRunner(app.svc).run({ audio, label: li > 0 ? process.argv[li + 1] : undefined });
  for (const r of run.results) {
    const failed = r.checks.filter((c) => !c.ok);
    console.log(`\n=== ${r.title} (${r.mode}, ${r.words} words, ${r.ms} ms)${failed.length ? `  FAILED: ${failed.map((f) => f.name).join(", ")}` : ""}`);
    console.log(`> ${r.input.slice(0, 200)}${r.input.length > 200 ? "…" : ""}`);
    console.log(r.reply);
  }
  console.log(`\nSaved run ${run.id}. Compare runs side by side in Settings > Voice and style.`);
  app.stop();
}
void main();
