// One command for local development: the API server (restarting on change)
// and the Vite dev server for the web app, with output from both.
//   npm run dev              your real profile
//   npm run dev:test         the test profile: fixture data and a simulated clock
import { spawn } from "node:child_process";

const test = process.argv.includes("--profile=test");
const port = process.env.PORT ?? (test ? "4318" : "4317");
const webPort = process.env.WEB_PORT ?? (test ? "5174" : "5173");
const env = {
  ...process.env,
  PORT: port,
  WEB_PORT: webPort,
  AVA_PROFILE: test ? "test" : (process.env.AVA_PROFILE ?? "real"),
  PUBLIC_URL: process.env.PUBLIC_URL ?? `http://localhost:${webPort}`,
  AVA_API: `http://127.0.0.1:${port}`,
};

const children = [];
function run(name, cmd, args) {
  const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
  const tag = name.padEnd(4);
  const pipe = (stream, out) =>
    stream.on("data", (buf) => {
      for (const line of buf.toString().split("\n")) if (line.trim()) out.write(`${tag} ${line}\n`);
    });
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on("exit", (code) => {
    console.log(`${tag} exited with code ${code}`);
    for (const c of children) if (c !== child) c.kill("SIGTERM");
    process.exit(code ?? 0);
  });
  children.push(child);
}

console.log(`Starting Ava (${env.AVA_PROFILE} profile). Open http://localhost:${webPort}`);
run("api", "npm", ["run", "dev", "-w", "@ava/server"]);
run("web", "npm", ["run", "dev", "-w", "@ava/web", "--", "--port", webPort, "--strictPort"]);

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => children.forEach((c) => c.kill(sig)));
