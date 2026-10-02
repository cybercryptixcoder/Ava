import { defineConfig, devices } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The UI tests run the production build against a fresh test profile in a temp folder.
// Build first: npm run build. Then: npm run test:e2e
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ava-e2e-"));
const port = 4319;
const chromium = process.env.CHROMIUM_PATH || (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    launchOptions: chromium ? { executablePath: chromium } : {},
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "node --no-warnings=ExperimentalWarning packages/server/dist/server.mjs",
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
    url: `http://127.0.0.1:${port}/api/health`,
    env: { AVA_PROFILE: "test", AVA_DATA_DIR: dataDir, PORT: String(port), HOST: "127.0.0.1", PUBLIC_URL: `http://127.0.0.1:${port}` },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
