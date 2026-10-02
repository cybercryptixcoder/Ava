import fs from "node:fs";
import { buildApp } from "../app";
import { loadConfig } from "../config/config";
import { seedTestProfile } from "../fixtures/seed";

// Rebuilds the test profile from fixtures. Never touches the real profile's data.
const cfg = loadConfig({ profile: "test" });
for (const f of [cfg.dbFile, `${cfg.dbFile}-wal`, `${cfg.dbFile}-shm`]) fs.rmSync(f, { force: true });
const app = buildApp({ config: { profile: "test" } });
void seedTestProfile(app.svc).then((at) => {
  console.log(`Test profile seeded at ${cfg.dbFile}; simulated clock ${at}`);
  app.stop();
});
