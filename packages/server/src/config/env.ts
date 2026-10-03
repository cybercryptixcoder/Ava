import fs from "node:fs";
import path from "node:path";
import { parse as parseDotenv } from "dotenv";

/**
 * Every environment variable Ava reads, with its purpose. This list is the
 * single source of truth for `.env.example` and the startup config check.
 *
 * Precedence: real environment variables > .env file > defaults.
 */
export interface EnvVarSpec {
  key: string;
  description: string;
  where?: string;
  secret?: boolean;
  required?: boolean;
  default?: string;
  group: string;
  /** Feature ids this key enables. */
  enables?: string[];
}

export const ENV_SPEC: EnvVarSpec[] = [
  // Core
  { group: "Core", key: "AVA_PROFILE", description: "Which data profile to run: real (your data) or test (fixture data, time simulation allowed).", default: "real" },
  { group: "Core", key: "AVA_DATA_DIR", description: "Directory for the database, audio and exports. Each profile gets its own subfolder.", default: "./data" },
  { group: "Core", key: "PORT", description: "HTTP port the server listens on.", default: "4317" },
  { group: "Core", key: "HOST", description: "Interface to bind. Use 127.0.0.1 behind a tunnel.", default: "127.0.0.1" },
  { group: "Core", key: "PUBLIC_URL", description: "The public https URL you reach Ava at (your tunnel hostname). Used for OAuth redirects, push and calendar webhooks.", where: "Your tunnel, e.g. https://ava.example.com", default: "http://localhost:4317" },
  { group: "Core", key: "AVA_PASSWORD_HASH", description: "scrypt hash of your login password.", where: "npm run hash-password", secret: true, required: true },
  { group: "Core", key: "AVA_PASSWORD", description: "Plain login password (alternative to AVA_PASSWORD_HASH; hashed in memory at startup). Prefer the hash.", secret: true },
  { group: "Core", key: "AVA_SESSION_SECRET", description: "Random secret (32+ chars) used to sign session cookies.", where: "openssl rand -hex 32", secret: true, required: true },
  { group: "Core", key: "AVA_ENCRYPTION_KEY", description: "32-byte key (64 hex chars) that encrypts sensitive data at rest. Losing it makes encrypted data unreadable.", where: "openssl rand -hex 32", secret: true, required: true },
  { group: "Core", key: "AVA_OWNER_NAME", description: "Your first name, used in prompts.", default: "Shreyas" },

  // Anthropic
  { group: "Models", key: "ANTHROPIC_API_KEY", description: "Anthropic API key. Powers planning, conversation, extraction, executors and live mode.", where: "https://platform.claude.com/settings/keys", secret: true, enables: ["model", "conversation", "planning", "executors", "extraction", "live"] },
  { group: "Models", key: "MODEL_PLANNER", description: "Model for planning sessions and the weekly review.", default: "claude-opus-5-5" },
  { group: "Models", key: "MODEL_CONVERSATION", description: "Model for async conversation and the morning brief.", default: "claude-sonnet-5-5" },
  { group: "Models", key: "MODEL_LIVE", description: "Model for live voice mode (claude-sonnet-5-5 or claude-haiku-4-5-20251001).", default: "claude-sonnet-5-5" },
  { group: "Models", key: "MODEL_LIVE_FAST", description: "The faster live-mode option offered in settings.", default: "claude-haiku-4-5-20251001" },
  { group: "Models", key: "MODEL_FAST", description: "Model for extraction, session labeling, candidate ranking and the affirmation check.", default: "claude-haiku-4-5-20251001" },
  { group: "Models", key: "MODEL_EXECUTOR", description: "Model for executor sessions that produce artifacts.", default: "claude-sonnet-5-5" },
  { group: "Models", key: "ANTHROPIC_REFUSAL_FALLBACK", description: "Opt in to server-side refusal fallbacks on Opus/Sonnet requests (true/false).", default: "true" },
  { group: "Models", key: "BUDGET_SYSTEM_CALLS_PER_DAY", description: "Max model calls per day that Ava starts on her own (wakes, planning, executors).", default: "120" },
  { group: "Models", key: "BUDGET_INTERACTIVE_CALLS_PER_DAY", description: "Max model calls per day you start (conversation, live turns, imports).", default: "600" },
  { group: "Models", key: "BUDGET_USD_PER_DAY", description: "Hard daily spend ceiling across all model calls, in US dollars.", default: "8" },

  // Voice
  { group: "Voice", key: "ELEVENLABS_API_KEY", description: "ElevenLabs key: expressive and low-latency text-to-speech with the same voice.", where: "https://elevenlabs.io/app/settings/api-keys", secret: true, enables: ["tts.elevenlabs"] },
  { group: "Voice", key: "ELEVENLABS_VOICE_ID", description: "Default ElevenLabs voice id (change it in the voice audition).", where: "ElevenLabs Voice Library" },
  { group: "Voice", key: "CARTESIA_API_KEY", description: "Cartesia key: Sonic text-to-speech with native word timestamps.", where: "https://play.cartesia.ai/keys", secret: true, enables: ["tts.cartesia"] },
  { group: "Voice", key: "CARTESIA_VOICE_ID", description: "Default Cartesia voice id.", where: "Cartesia playground" },
  { group: "Voice", key: "DEEPGRAM_API_KEY", description: "Deepgram key: Flux streaming speech-to-text with semantic end-of-turn, and audio file transcription.", where: "https://console.deepgram.com", secret: true, enables: ["stt.deepgram"] },
  { group: "Voice", key: "ASSEMBLYAI_API_KEY", description: "AssemblyAI key: alternative streaming speech-to-text with semantic turn detection.", where: "https://www.assemblyai.com/app/api-keys", secret: true, enables: ["stt.assemblyai"] },

  // Push
  { group: "Push", key: "VAPID_PUBLIC_KEY", description: "Web push public key. Generate both with `npm run vapid`.", where: "npm run vapid", enables: ["push"] },
  { group: "Push", key: "VAPID_PRIVATE_KEY", description: "Web push private key.", where: "npm run vapid", secret: true, enables: ["push"] },
  { group: "Push", key: "VAPID_SUBJECT", description: "Contact for push services, mailto: or https: URL.", default: "mailto:ava@localhost" },

  // Google
  { group: "Google", key: "GOOGLE_CLIENT_ID", description: "OAuth client id for Google Calendar and Gmail (Web application type).", where: "Google Cloud Console > APIs & Services > Credentials", enables: ["source.gcal", "source.gmail"] },
  { group: "Google", key: "GOOGLE_CLIENT_SECRET", description: "OAuth client secret for the same client.", where: "Google Cloud Console", secret: true, enables: ["source.gcal", "source.gmail"] },
  { group: "Google", key: "GMAIL_SEND_ENABLED", description: "Allow sending drafts via Gmail after explicit confirmation each time (adds the gmail.send scope).", default: "false" },

  // Wispr Flow
  { group: "Sources", key: "WISPR_MCP_URL", description: "Wispr Flow's official remote MCP endpoint. You sign in through OAuth from Settings.", default: "https://api.wisprflow.ai/connect/mcp" },

  // Monitoring
  { group: "Monitoring", key: "DEADMAN_PING_URL", description: "Optional external heartbeat URL (e.g. healthchecks.io) pinged after each successful wake, so you hear about it even if the server is down.", where: "https://healthchecks.io" },
  { group: "Monitoring", key: "COLLECTOR_TOKEN", description: "Shared token the activity collector uses to post sessions. Generate any long random string.", where: "openssl rand -hex 24", secret: true, enables: ["source.activity"] },

  // Memory
  { group: "Memory", key: "EMBEDDINGS_URL", description: "Optional hosted embeddings endpoint (OpenAI-compatible /v1/embeddings). Left unset, memory embeds locally on this machine so nothing leaves the server.", where: "e.g. https://api.openai.com/v1/embeddings" },
  { group: "Memory", key: "EMBEDDINGS_API_KEY", description: "Key for the hosted embeddings endpoint, if one is configured.", secret: true },
  { group: "Memory", key: "EMBEDDINGS_MODEL", description: "Model name for the hosted embeddings endpoint.", default: "text-embedding-3-small" },
];

let loaded = false;
const fileValues: Record<string, string> = {};

/** Load .env (without overriding real environment variables). */
export function loadEnvFile(rootDir: string): void {
  if (loaded) return;
  loaded = true;
  for (const name of [".env", ".env.local"]) {
    const p = path.join(rootDir, name);
    if (fs.existsSync(p)) Object.assign(fileValues, parseDotenv(fs.readFileSync(p)));
  }
}

export function env(key: string): string | undefined {
  const v = process.env[key];
  if (v !== undefined && v !== "") return v;
  const f = fileValues[key];
  if (f !== undefined && f !== "") return f;
  return ENV_SPEC.find((s) => s.key === key)?.default;
}

export function envPresent(key: string): boolean {
  return (process.env[key] ?? "") !== "" || (fileValues[key] ?? "") !== "";
}

export function envBool(key: string): boolean {
  return /^(1|true|yes|on)$/i.test(env(key) ?? "");
}

export function envNum(key: string): number {
  const v = Number(env(key));
  if (Number.isNaN(v)) throw new Error(`${key} must be a number`);
  return v;
}

/** Render .env.example from ENV_SPEC. */
export function renderEnvExample(): string {
  const lines: string[] = [
    "# Ava configuration. Copy to .env and fill in what you have.",
    "# Real environment variables take precedence over this file, so you can also export these in your shell.",
    "# Missing optional keys only disable their feature; `npm run config:check` shows what is on and off.",
    "",
  ];
  let group = "";
  for (const s of ENV_SPEC) {
    if (s.group !== group) {
      if (group) lines.push("");
      lines.push(`# --- ${s.group} ---`);
      group = s.group;
    }
    const where = s.where ? ` Get it: ${s.where}.` : "";
    const req = s.required ? " Required in production." : "";
    lines.push(`# ${s.description}${where}${req}`);
    lines.push(`${s.key}=${s.default ?? ""}`);
  }
  return lines.join("\n") + "\n";
}
