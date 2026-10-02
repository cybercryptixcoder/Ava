import { unzipSync, strFromU8 } from "fflate";

/**
 * Tolerant parsers for ChatGPT and Claude data exports. Both have changed
 * shape over time, so we look for the fields we need wherever they are and
 * skip what we don't understand instead of failing the whole import.
 */
export interface ParsedConversation {
  id: string;
  platform: "chatgpt" | "claude" | "unknown";
  title: string;
  created_at: string;
  updated_at: string;
  messages: { role: "user" | "assistant"; text: string; at: string | null }[];
}

function toIso(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function textOf(content: unknown): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(textOf).filter(Boolean).join("\n");
  if (typeof content === "object") {
    const o = content as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    if (o.parts) return textOf(o.parts);
    if (typeof o.result === "string") return o.result;
    if (o.content) return textOf(o.content);
  }
  return "";
}

function parseChatGPT(conv: Record<string, unknown>, idx: number): ParsedConversation | null {
  const mapping = conv.mapping as Record<string, { message?: Record<string, unknown> | null; parent?: string | null; children?: string[] }> | undefined;
  if (!mapping) return null;
  // Follow the current branch from current_node back to the root; fall back to all nodes by time.
  const nodes: Record<string, unknown>[] = [];
  let cursor = conv.current_node as string | undefined;
  const seen = new Set<string>();
  while (cursor && mapping[cursor] && !seen.has(cursor)) {
    seen.add(cursor);
    const m = mapping[cursor].message;
    if (m) nodes.unshift(m);
    cursor = mapping[cursor].parent ?? undefined;
  }
  if (!nodes.length) {
    for (const n of Object.values(mapping)) if (n.message) nodes.push(n.message);
    nodes.sort((a, b) => Number(a.create_time ?? 0) - Number(b.create_time ?? 0));
  }
  const messages: ParsedConversation["messages"] = [];
  for (const m of nodes) {
    const role = (m.author as { role?: string } | undefined)?.role;
    if (role !== "user" && role !== "assistant") continue;
    const content = m.content as { content_type?: string } | undefined;
    if (content?.content_type && !["text", "multimodal_text", "code"].includes(content.content_type)) continue;
    const text = textOf(content).trim();
    if (text) messages.push({ role, text, at: toIso(m.create_time) });
  }
  return {
    id: String(conv.conversation_id ?? conv.id ?? `chatgpt-${idx}`),
    platform: "chatgpt",
    title: String(conv.title ?? "Untitled"),
    created_at: toIso(conv.create_time) ?? messages[0]?.at ?? new Date(0).toISOString(),
    updated_at: toIso(conv.update_time) ?? messages[messages.length - 1]?.at ?? new Date(0).toISOString(),
    messages,
  };
}

function parseClaude(conv: Record<string, unknown>, idx: number): ParsedConversation | null {
  const msgs = (conv.chat_messages ?? conv.messages) as Record<string, unknown>[] | undefined;
  if (!Array.isArray(msgs)) return null;
  const messages: ParsedConversation["messages"] = [];
  for (const m of msgs) {
    const sender = String(m.sender ?? m.role ?? "");
    const role = sender === "human" || sender === "user" ? "user" : sender === "assistant" ? "assistant" : null;
    if (!role) continue;
    const text = (typeof m.text === "string" && m.text.trim() ? m.text : textOf(m.content)).trim();
    if (text) messages.push({ role, text, at: toIso(m.created_at) });
  }
  return {
    id: String(conv.uuid ?? conv.id ?? `claude-${idx}`),
    platform: "claude",
    title: String(conv.name ?? conv.title ?? "Untitled"),
    created_at: toIso(conv.created_at) ?? messages[0]?.at ?? new Date(0).toISOString(),
    updated_at: toIso(conv.updated_at) ?? messages[messages.length - 1]?.at ?? new Date(0).toISOString(),
    messages,
  };
}

function parseAny(data: unknown): ParsedConversation[] {
  const list: unknown[] = Array.isArray(data)
    ? data
    : data && typeof data === "object"
      ? (((data as Record<string, unknown>).conversations as unknown[]) ?? ((data as Record<string, unknown>).data as unknown[]) ?? [data])
      : [];
  const out: ParsedConversation[] = [];
  list.forEach((c, i) => {
    if (!c || typeof c !== "object") return;
    const o = c as Record<string, unknown>;
    const p = o.mapping ? parseChatGPT(o, i) : o.chat_messages || o.messages ? parseClaude(o, i) : null;
    if (p && p.messages.length) out.push(p);
  });
  return out;
}

/** Accepts a .zip export, a conversations.json, or JSON Lines. */
export function parseChatExport(file: Buffer, filename: string): { conversations: ParsedConversation[]; warnings: string[] } {
  const warnings: string[] = [];
  const texts: { name: string; text: string }[] = [];
  if (filename.toLowerCase().endsWith(".zip") || (file[0] === 0x50 && file[1] === 0x4b)) {
    const entries = unzipSync(new Uint8Array(file), { filter: (f) => /conversations[^/]*\.json$|\.jsonl$/i.test(f.name) });
    for (const [name, data] of Object.entries(entries)) texts.push({ name, text: strFromU8(data) });
    if (!texts.length) warnings.push("No conversations.json found in the zip");
  } else {
    texts.push({ name: filename, text: file.toString("utf8") });
  }
  const conversations: ParsedConversation[] = [];
  for (const t of texts) {
    try {
      conversations.push(...parseAny(JSON.parse(t.text)));
    } catch {
      // JSON Lines fallback
      let ok = 0;
      for (const line of t.text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          conversations.push(...parseAny([JSON.parse(line)]));
          ok++;
        } catch {
          /* skip */
        }
      }
      if (!ok) warnings.push(`${t.name}: not JSON we recognize`);
    }
  }
  return { conversations, warnings };
}

/**
 * Stage 1 of compression (deterministic): keep only Shreyas's own words,
 * strip code and long pastes, and drop near-empty conversations.
 */
export function userTextOf(c: ParsedConversation, maxChars = 4000): string {
  const parts: string[] = [];
  let total = 0;
  for (const m of c.messages) {
    if (m.role !== "user") continue;
    let t = m.text.replace(/```[\s\S]*?```/g, "[code]").replace(/\n{3,}/g, "\n\n");
    if (t.length > 1500) t = `${t.slice(0, 400)} […pasted text trimmed]`;
    if (total + t.length > maxChars) {
      parts.push(t.slice(0, Math.max(0, maxChars - total)));
      break;
    }
    parts.push(t);
    total += t.length;
  }
  return parts.join("\n---\n").trim();
}
