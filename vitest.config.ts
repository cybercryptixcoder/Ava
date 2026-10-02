import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
    // Each server test builds its own in-memory app; keep files isolated.
    pool: "forks",
    // node:sqlite still prints an ExperimentalWarning on Node 22.
    execArgv: ["--no-warnings=ExperimentalWarning"],
    testTimeout: 20_000,
  },
});
