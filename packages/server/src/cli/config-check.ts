import fs from "node:fs";
import path from "node:path";
import { loadConfig, formatConfigReport } from "../config/config";
import { renderEnvExample } from "../config/env";

// Prints which keys are present, which are missing, and which features are off as a result.
// With --write-env-example, regenerates .env.example from the same specification.
const cfg = loadConfig();
if (process.argv.includes("--write-env-example")) {
  const file = path.join(cfg.rootDir, ".env.example");
  fs.writeFileSync(file, renderEnvExample());
  console.log(`Wrote ${file}`);
} else {
  console.log(formatConfigReport(cfg));
}
