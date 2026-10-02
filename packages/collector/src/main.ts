/**
 * Ava's laptop activity collector.
 *
 * Samples the frontmost app and window title every few seconds, merges the
 * samples into sessions here on the laptop, and sends only sessions to Ava.
 * Raw samples are kept in memory for the length of one session and never
 * written to disk; sessions waiting to be sent are kept in a small file
 * until the server accepts them, then deleted.
 *
 *   ava-collector --server https://ava.example.com --token <COLLECTOR_TOKEN>
 *   ava-collector --once          print one sample and exit (check permissions)
 *   ava-collector --dry-run       merge and print sessions instead of sending
 *   ava-collector service         print a login service definition for this OS
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PRIVATE_APPS, Merger, type Session } from "./merge";
import { createSampler } from "./sampler";

interface Options {
  server: string;
  token: string;
  device: string;
  interval: number;
  flushMinutes: number;
  idleSeconds: number;
  titles: boolean;
  dryRun: boolean;
  once: boolean;
  stateDir: string;
  privateApps: string[];
}

function parseArgs(argv: string[]): { command: string | null; opts: Options } {
  const flags = new Map<string, string | true>();
  let command: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) flags.set(k, v);
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) flags.set(k, argv[++i]);
      else flags.set(k, true);
    } else if (!command) command = a;
  }
  const str = (k: string, env: string, d: string) => (typeof flags.get(k) === "string" ? (flags.get(k) as string) : (process.env[env] ?? d));
  const num = (k: string, env: string, d: number) => {
    const v = Number(str(k, env, String(d)));
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  return {
    command,
    opts: {
      server: str("server", "AVA_SERVER", "").replace(/\/+$/, ""),
      token: str("token", "AVA_COLLECTOR_TOKEN", ""),
      device: str("device", "AVA_DEVICE", os.hostname()),
      interval: num("interval", "AVA_SAMPLE_SECONDS", 10),
      flushMinutes: num("flush", "AVA_FLUSH_MINUTES", 5),
      idleSeconds: num("idle", "AVA_IDLE_SECONDS", 180),
      titles: !flags.has("no-titles"),
      dryRun: flags.has("dry-run"),
      once: flags.has("once"),
      stateDir: str("state-dir", "AVA_COLLECTOR_DIR", path.join(os.homedir(), ".ava-collector")),
      privateApps: [...DEFAULT_PRIVATE_APPS, ...str("private-apps", "AVA_PRIVATE_APPS", "").split(",").map((s) => s.trim()).filter(Boolean)],
    },
  };
}

/** Sessions not yet accepted by the server survive restarts; nothing else is stored. */
class Pending {
  private file: string;
  private list: Session[] = [];
  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, "pending.json");
    try {
      this.list = JSON.parse(fs.readFileSync(this.file, "utf8")) as Session[];
    } catch {
      this.list = [];
    }
  }
  add(s: Session[]): void {
    if (!s.length) return;
    this.list.push(...s);
    if (this.list.length > 5000) this.list = this.list.slice(-5000);
    this.save();
  }
  peek(n: number): Session[] {
    return this.list.slice(0, n);
  }
  drop(n: number): void {
    this.list = this.list.slice(n);
    this.save();
  }
  get size(): number {
    return this.list.length;
  }
  private save(): void {
    if (!this.list.length) {
      fs.rmSync(this.file, { force: true });
      return;
    }
    fs.writeFileSync(this.file, JSON.stringify(this.list), { mode: 0o600 });
  }
}

async function send(o: Options, pending: Pending): Promise<void> {
  while (pending.size) {
    const batch = pending.peek(200);
    const res = await fetch(`${o.server}/api/collector/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${o.token}` },
      body: JSON.stringify({ device: o.device, sessions: batch }),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401) throw new Error("The server rejected the token. Check COLLECTOR_TOKEN on the server and --token here.");
    if (res.status === 409) throw new Error("Laptop activity is switched off in Ava's Settings. Sessions are kept here until it's on.");
    if (!res.ok) throw new Error(`Server answered ${res.status}`);
    const body = (await res.json()) as { accepted: number };
    pending.drop(batch.length);
    log(`sent ${batch.length} session${batch.length === 1 ? "" : "s"} (${body.accepted} new)`);
  }
}

function log(msg: string): void {
  console.log(`${new Date().toLocaleTimeString()}  ${msg}`);
}

function serviceDefinition(): string {
  const node = process.execPath;
  const script = fs.realpathSync(process.argv[1]);
  const args = process.argv.slice(3).filter((a) => a !== "service");
  const cmd = [node, script, ...args];
  if (process.platform === "darwin") {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Save as ~/Library/LaunchAgents/com.ava.collector.plist, then: launchctl load ~/Library/LaunchAgents/com.ava.collector.plist -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.ava.collector</string>
  <key>ProgramArguments</key>
  <array>
${cmd.map((c) => `    <string>${c.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AVA_SERVER</key><string>${process.env.AVA_SERVER ?? "https://ava.example.com"}</string>
    <key>AVA_COLLECTOR_TOKEN</key><string>paste-your-COLLECTOR_TOKEN</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/tmp/ava-collector.log</string>
</dict>
</plist>`;
  }
  if (process.platform === "linux") {
    return `# Save as ~/.config/systemd/user/ava-collector.service, then:
#   systemctl --user daemon-reload && systemctl --user enable --now ava-collector
[Unit]
Description=Ava activity collector
After=graphical-session.target

[Service]
ExecStart=${cmd.map((c) => (/\s/.test(c) ? `"${c}"` : c)).join(" ")}
Environment=AVA_SERVER=${process.env.AVA_SERVER ?? "https://ava.example.com"}
Environment=AVA_COLLECTOR_TOKEN=paste-your-COLLECTOR_TOKEN
Environment=DISPLAY=${process.env.DISPLAY ?? ":0"}
Restart=on-failure

[Install]
WantedBy=default.target`;
  }
  return `REM Run once in a terminal to start the collector at every login:
schtasks /Create /TN "Ava collector" /SC ONLOGON /RL LIMITED /TR "\\"${node}\\" \\"${script}\\" ${args.join(" ")}"
REM Set the server and token for your user first:
setx AVA_SERVER https://ava.example.com
setx AVA_COLLECTOR_TOKEN paste-your-COLLECTOR_TOKEN`;
}

async function main(): Promise<void> {
  const { command, opts: o } = parseArgs(process.argv.slice(2));
  if (command === "service") {
    console.log(serviceDefinition());
    return;
  }
  if (command === "help" || process.argv.includes("--help")) {
    console.log(`ava-collector [--server URL] [--token TOKEN] [--device NAME] [--interval 10] [--flush 5] [--idle 180] [--no-titles] [--private-apps "App1,App2"] [--dry-run] [--once]
ava-collector service      print a login service definition for this OS
Environment: AVA_SERVER, AVA_COLLECTOR_TOKEN, AVA_DEVICE, AVA_COLLECTOR_DIR`);
    return;
  }

  const sampler = await createSampler();
  if (o.once) {
    console.log(sampler.name);
    console.log(await sampler.sample());
    sampler.stop();
    return;
  }
  if (!o.dryRun && (!o.server || !o.token)) throw new Error("Pass --server and --token (or set AVA_SERVER and AVA_COLLECTOR_TOKEN). Use --dry-run to try it without a server.");

  const merger = new Merger({
    intervalSeconds: o.interval,
    maxGapSeconds: Math.max(o.interval * 3, 60),
    minActiveSeconds: Math.max(o.interval * 3, 30),
    maxSessionMinutes: 30,
    sendTitles: o.titles,
    privateApps: o.privateApps,
  });
  const pending = new Pending(o.stateDir);
  log(`collecting with ${sampler.name} every ${o.interval} s as "${o.device}"${o.titles ? "" : " (app names only)"}${o.dryRun ? ", dry run" : ` to ${o.server}`}`);
  if (pending.size) log(`${pending.size} sessions from last time are waiting to be sent`);

  let failures = 0;
  let nextFlush = Date.now() + o.flushMinutes * 60_000;
  const flush = async () => {
    const closed = merger.take();
    if (o.dryRun) {
      for (const s of closed) console.log(JSON.stringify(s));
      return;
    }
    pending.add(closed);
    try {
      await send(o, pending);
      failures = 0;
    } catch (e) {
      failures++;
      log(`couldn't send (${(e as Error).message}); ${pending.size} sessions kept for later`);
    }
  };

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    merger.close();
    await flush();
    sampler.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());

  for (;;) {
    const t0 = Date.now();
    try {
      const s = await sampler.sample();
      if (s && s.app) merger.add({ at: t0, app: s.app, title: s.title, idle: s.idleSeconds !== null && s.idleSeconds >= o.idleSeconds });
    } catch (e) {
      // Locked screen, permission prompts and the like: treat as no activity.
      merger.close();
      if (process.env.AVA_DEBUG) log(`sample failed: ${(e as Error).message}`);
    }
    if (Date.now() >= nextFlush) {
      // Back off when the server is unreachable: 5, 10, 20 ... up to 60 minutes.
      nextFlush = Date.now() + Math.min(60, o.flushMinutes * 2 ** Math.min(failures, 4)) * 60_000;
      await flush();
    }
    await new Promise((r) => setTimeout(r, Math.max(1000, o.interval * 1000 - (Date.now() - t0))));
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
