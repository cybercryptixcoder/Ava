import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { ConfigReport, FeatureReport } from "@ava/shared";
import { ENV_SPEC, env, envBool, envNum, envPresent, loadEnvFile } from "./env";
import { hashPassword } from "../security/crypto";

export interface AppConfig {
  profile: "real" | "test";
  production: boolean;
  rootDir: string;
  dataDir: string;
  dbFile: string;
  audioDir: string;
  exportDir: string;
  personalityDir: string;
  fixturesDir: string;
  webDistDir: string;
  port: number;
  host: string;
  publicUrl: string;
  ownerName: string;
  passwordHash: string | null;
  sessionSecret: string;
  encryptionKey: string;
  generatedSecrets: boolean;
  anthropicKey: string | null;
  models: {
    planner: string;
    conversation: string;
    live: string;
    liveFast: string;
    fast: string;
    executor: string;
  };
  refusalFallback: boolean;
  budgets: { system: number; interactive: number; usd: number };
  elevenlabs: { key: string | null; voiceId: string | null };
  cartesia: { key: string | null; voiceId: string | null };
  deepgramKey: string | null;
  assemblyaiKey: string | null;
  vapid: { publicKey: string | null; privateKey: string | null; subject: string };
  google: { clientId: string | null; clientSecret: string | null; gmailSend: boolean };
  wisprMcpUrl: string;
  deadmanPingUrl: string | null;
  collectorToken: string | null;
}

function findRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
      try {
        const p = JSON.parse(fs.readFileSync(pkg, "utf8"));
        if (p.workspaces) return dir;
      } catch {
        /* keep looking */
      }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return process.cwd();
}

/**
 * Development convenience: if core secrets are missing outside production, generate them once
 * into the profile's data folder so the app can start. Production refuses to start without them.
 */
function devSecrets(dataDir: string): { sessionSecret: string; encryptionKey: string } {
  const file = path.join(dataDir, "dev-secrets.json");
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  fs.mkdirSync(dataDir, { recursive: true });
  const s = { sessionSecret: randomBytes(32).toString("hex"), encryptionKey: randomBytes(32).toString("hex") };
  fs.writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 });
  return s;
}

export function loadConfig(overrides: Partial<AppConfig> & { rootDir?: string } = {}): AppConfig {
  const rootDir = overrides.rootDir ?? findRoot(process.cwd());
  loadEnvFile(rootDir);
  const profile = (overrides.profile ?? (env("AVA_PROFILE") === "test" ? "test" : "real")) as "real" | "test";
  const production = process.env.NODE_ENV === "production";
  const dataRoot = path.resolve(rootDir, env("AVA_DATA_DIR") ?? "./data");
  const dataDir = overrides.dataDir ?? path.join(dataRoot, profile);

  let sessionSecret = env("AVA_SESSION_SECRET") ?? "";
  let encryptionKey = env("AVA_ENCRYPTION_KEY") ?? "";
  let generatedSecrets = false;
  if (!sessionSecret || !encryptionKey) {
    if (production && profile === "real") {
      throw new Error(
        "AVA_SESSION_SECRET and AVA_ENCRYPTION_KEY are required in production. Generate each with `openssl rand -hex 32`.",
      );
    }
    const s = devSecrets(dataDir);
    sessionSecret ||= s.sessionSecret;
    encryptionKey ||= s.encryptionKey;
    generatedSecrets = true;
  }

  let passwordHash = env("AVA_PASSWORD_HASH") ?? null;
  if (!passwordHash && env("AVA_PASSWORD")) passwordHash = hashPassword(env("AVA_PASSWORD")!);
  if (!passwordHash && production && profile === "real") {
    throw new Error("Set AVA_PASSWORD_HASH (run `npm run hash-password`) before starting in production.");
  }

  const cfg: AppConfig = {
    profile,
    production,
    rootDir,
    dataDir,
    dbFile: path.join(dataDir, "ava.db"),
    audioDir: path.join(dataDir, "audio"),
    exportDir: path.join(dataDir, "exports"),
    personalityDir: path.join(rootDir, "personality"),
    fixturesDir: path.join(rootDir, "fixtures"),
    webDistDir: path.join(rootDir, "packages/web/dist"),
    port: Number(env("PORT")),
    host: env("HOST") ?? "127.0.0.1",
    publicUrl: (env("PUBLIC_URL") ?? "http://localhost:4317").replace(/\/$/, ""),
    ownerName: env("AVA_OWNER_NAME") ?? "Shreyas",
    passwordHash,
    sessionSecret,
    encryptionKey,
    generatedSecrets,
    anthropicKey: env("ANTHROPIC_API_KEY") ?? null,
    models: {
      planner: env("MODEL_PLANNER")!,
      conversation: env("MODEL_CONVERSATION")!,
      live: env("MODEL_LIVE")!,
      liveFast: env("MODEL_LIVE_FAST")!,
      fast: env("MODEL_FAST")!,
      executor: env("MODEL_EXECUTOR")!,
    },
    refusalFallback: envBool("ANTHROPIC_REFUSAL_FALLBACK"),
    budgets: {
      system: envNum("BUDGET_SYSTEM_CALLS_PER_DAY"),
      interactive: envNum("BUDGET_INTERACTIVE_CALLS_PER_DAY"),
      usd: envNum("BUDGET_USD_PER_DAY"),
    },
    elevenlabs: { key: env("ELEVENLABS_API_KEY") ?? null, voiceId: env("ELEVENLABS_VOICE_ID") ?? null },
    cartesia: { key: env("CARTESIA_API_KEY") ?? null, voiceId: env("CARTESIA_VOICE_ID") ?? null },
    deepgramKey: env("DEEPGRAM_API_KEY") ?? null,
    assemblyaiKey: env("ASSEMBLYAI_API_KEY") ?? null,
    vapid: {
      publicKey: env("VAPID_PUBLIC_KEY") ?? null,
      privateKey: env("VAPID_PRIVATE_KEY") ?? null,
      subject: env("VAPID_SUBJECT") ?? "mailto:ava@localhost",
    },
    google: {
      clientId: env("GOOGLE_CLIENT_ID") ?? null,
      clientSecret: env("GOOGLE_CLIENT_SECRET") ?? null,
      gmailSend: envBool("GMAIL_SEND_ENABLED"),
    },
    wisprMcpUrl: env("WISPR_MCP_URL") ?? "https://api.wisprflow.ai/connect/mcp",
    deadmanPingUrl: env("DEADMAN_PING_URL") ?? null,
    collectorToken: env("COLLECTOR_TOKEN") ?? null,
    ...overrides,
  };
  return cfg;
}

/** Which features are usable with the keys present. */
export function featureReport(cfg: AppConfig): FeatureReport[] {
  const f = (id: string, label: string, enabled: boolean, reason: string): FeatureReport => ({
    id,
    label,
    enabled,
    reason: enabled ? null : reason,
  });
  const tts = !!(cfg.elevenlabs.key || cfg.cartesia.key);
  const stt = !!(cfg.deepgramKey || cfg.assemblyaiKey);
  const google = !!(cfg.google.clientId && cfg.google.clientSecret);
  return [
    f("login", "Password login", !!cfg.passwordHash, "No AVA_PASSWORD_HASH: only localhost requests are allowed in development"),
    f("model", "Model calls (conversation, planning, executors)", !!cfg.anthropicKey, "No ANTHROPIC_API_KEY: conversation, planning and executors are off; wakes use deterministic templates"),
    f("tts", "Spoken replies", tts, "No ELEVENLABS_API_KEY or CARTESIA_API_KEY: replies are shown on screen only"),
    f("stt.files", "Audio file transcription", !!cfg.deepgramKey, "No DEEPGRAM_API_KEY: upload audio is off (dictation with Wispr Flow still works)"),
    f("live", "Live voice mode", !!cfg.anthropicKey && tts && stt, "Live mode needs ANTHROPIC_API_KEY, a TTS key and DEEPGRAM_API_KEY or ASSEMBLYAI_API_KEY"),
    f("push", "Web push notifications", !!(cfg.vapid.publicKey && cfg.vapid.privateKey), "No VAPID keys: messages appear in the app only (run npm run vapid)"),
    f("source.gcal", "Google Calendar", google, "No GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET"),
    f("source.gmail", "Gmail sent-mail commitments", google, "No GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET"),
    f("email.send", "Sending drafts via Gmail (with confirmation)", google && cfg.google.gmailSend, "GMAIL_SEND_ENABLED is off or Google is not configured"),
    f("source.activity", "Laptop activity collector", !!cfg.collectorToken, "No COLLECTOR_TOKEN"),
    f("source.wispr", "Wispr Flow notes (MCP)", !!cfg.wisprMcpUrl, "No WISPR_MCP_URL"),
    f("deadman.external", "External dead-man ping", !!cfg.deadmanPingUrl, "No DEADMAN_PING_URL: the in-process dead-man's switch still runs"),
  ];
}

export function configReport(cfg: AppConfig): ConfigReport {
  return {
    profile: cfg.profile,
    items: ENV_SPEC.map((s) => ({
      key: s.key,
      present:
        envPresent(s.key) ||
        (s.key === "AVA_PASSWORD_HASH" && !!cfg.passwordHash) ||
        (s.key === "AVA_SESSION_SECRET" && !!cfg.sessionSecret) ||
        (s.key === "AVA_ENCRYPTION_KEY" && !!cfg.encryptionKey),
      required: !!s.required,
      secret: !!s.secret,
      description: s.description,
    })),
    features: featureReport(cfg),
  };
}

export function formatConfigReport(cfg: AppConfig): string {
  const r = configReport(cfg);
  const lines: string[] = [];
  lines.push(`Ava configuration check (profile: ${r.profile})`);
  if (cfg.generatedSecrets) {
    lines.push("  ! Using generated development secrets from the data folder. Set AVA_SESSION_SECRET and AVA_ENCRYPTION_KEY before deploying.");
  }
  lines.push("  Keys:");
  for (const i of r.items) {
    if (!i.secret && !i.required && !/API_KEY|CLIENT|VAPID|TOKEN|URL/.test(i.key)) continue;
    lines.push(`    ${i.present ? "present" : "missing"}  ${i.key}${i.required && !i.present ? "  (required)" : ""}`);
  }
  lines.push("  Features:");
  for (const f of r.features) lines.push(`    ${f.enabled ? "on " : "off"}  ${f.label}${f.reason ? ` — ${f.reason}` : ""}`);
  return lines.join("\n");
}
