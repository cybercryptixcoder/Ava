// Bundles the server and its command-line tools into dist/ for production.
// Third-party packages stay external (installed with npm ci); the shared
// workspace package is TypeScript source, so it is bundled in.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8"));
const external = Object.keys(pkg.dependencies ?? {}).filter((d) => d !== "@ava/shared");

const cli = fs
  .readdirSync(path.join(here, "src/cli"))
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({ in: `src/cli/${f}`, out: `cli/${f.replace(/\.ts$/, "")}` }));

await build({
  absWorkingDir: here,
  entryPoints: [{ in: "src/main.ts", out: "server" }, ...cli],
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  external: [...external, ...external.map((d) => `${d}/*`)],
  banner: { js: "import { createRequire as __ava_cr } from 'node:module'; const require = __ava_cr(import.meta.url);" },
  logLevel: "info",
});
