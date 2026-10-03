import { buildApp } from "../app";

// Runs the graded memory evaluation now: replay + questions + grading against
// the real system, with cleanup through the real forget path afterwards.
// npm run memory:eval
const app = buildApp({});
try {
  const r = await app.svc.memoryEval.run({ via: "cli" });
  for (const x of r.results) console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.scenario}: ${x.why}`);
  console.log("");
  console.log(`${r.passed}/${r.total} passed in ${(r.duration_ms / 1000).toFixed(1)}s (results recorded for the developer panel).`);
  app.stop();
  process.exit(r.passed === r.total ? 0 : 1);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  app.stop();
  process.exit(1);
}
