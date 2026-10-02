import { unzipSync, strFromU8 } from "fflate";

/**
 * Parsers for saved and bookmarked items from platform data exports and
 * browser bookmarks. Each yields what was saved, where, and when. Formats:
 *  - Chrome/Edge/Brave "Bookmarks" JSON file
 *  - Netscape bookmark HTML (exports from Chrome, Firefox, Safari, Pocket)
 *  - Reddit export saved_posts.csv / saved_comments.csv
 *  - Google Takeout YouTube playlist CSVs (e.g. "Watch later")
 *  - Instagram export saved_posts.json / saved_collections.json
 *  - TikTok user_data.json (Favorite Videos)
 *  - Pocket CSV export
 *  - Any CSV with a url column (generic fallback)
 */
export interface SavedEntry {
  url: string;
  title: string;
  platform: string;
  saved_at: string | null;
}

function iso(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isNaN(n) && n > 0) {
    // Chrome uses microseconds since 1601; Unix seconds/millis otherwise.
    if (n > 1e16) return new Date((n / 1000 - 11644473600000)).toISOString();
    return new Date(n < 1e12 ? n * 1000 : n).toISOString();
  }
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    if (row.some((x) => x !== "")) rows.push(row);
  }
  const [head, ...rest] = rows;
  if (!head) return [];
  const keys = head.map((h) => h.trim().toLowerCase());
  return rest.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

function chromeBookmarks(data: Record<string, unknown>): SavedEntry[] {
  const out: SavedEntry[] = [];
  const walk = (node: Record<string, unknown>) => {
    if (node.type === "url" && typeof node.url === "string") out.push({ url: node.url, title: String(node.name ?? node.url), platform: "browser", saved_at: iso(node.date_added) });
    for (const c of (node.children as Record<string, unknown>[]) ?? []) walk(c);
  };
  for (const root of Object.values((data.roots as Record<string, Record<string, unknown>>) ?? {})) if (root && typeof root === "object") walk(root);
  return out;
}

function netscapeHtml(html: string, platform: string): SavedEntry[] {
  const out: SavedEntry[] = [];
  for (const m of html.matchAll(/<A\s+([^>]*?)>([\s\S]*?)<\/A>/gi)) {
    const attrs = m[1];
    const href = /HREF="([^"]+)"/i.exec(attrs)?.[1];
    if (!href || !/^https?:/i.test(href)) continue;
    const added = /(?:ADD_DATE|TIME_ADDED)="(\d+)"/i.exec(attrs)?.[1];
    const title = m[2].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
    out.push({ url: href, title: title || href, platform, saved_at: iso(added) });
  }
  return out;
}

function fromCsv(rows: Record<string, string>[], name: string): SavedEntry[] {
  const lower = name.toLowerCase();
  const platform = lower.includes("reddit") || "permalink" in (rows[0] ?? {}) ? "reddit" : lower.includes("youtube") || "video id" in (rows[0] ?? {}) || "video id " in (rows[0] ?? {}) ? "youtube" : lower.includes("pocket") ? "pocket" : "csv";
  return rows
    .map((r): SavedEntry | null => {
      let url = r.url ?? r.link ?? r.permalink ?? r.href ?? "";
      const vid = r["video id"] ?? r["video id "];
      if (!url && vid) url = `https://www.youtube.com/watch?v=${vid}`;
      if (url && url.startsWith("/r/")) url = `https://www.reddit.com${url}`;
      if (!/^https?:/i.test(url)) return null;
      return {
        url,
        title: r.title ?? r.name ?? (vid ? `YouTube video ${vid}` : url),
        platform,
        saved_at: iso(r["playlist video creation timestamp"] ?? r.time_added ?? r.date ?? r.created ?? r.saved_at ?? null),
      };
    })
    .filter((x): x is SavedEntry => !!x);
}

function instagram(data: unknown): SavedEntry[] {
  const out: SavedEntry[] = [];
  const list = ((data as Record<string, unknown>)?.saved_saved_media ?? (data as Record<string, unknown>)?.saved_media ?? data) as unknown;
  if (!Array.isArray(list)) return out;
  for (const e of list as Record<string, unknown>[]) {
    const smd = (e.string_map_data ?? {}) as Record<string, { href?: string; timestamp?: number }>;
    const first = Object.values(smd)[0];
    if (first?.href) out.push({ url: first.href, title: String(e.title ?? "Instagram post"), platform: "instagram", saved_at: iso(first.timestamp) });
  }
  return out;
}

function tiktok(data: Record<string, unknown>): SavedEntry[] {
  const fav = (((data.Activity ?? data["Your Activity"]) as Record<string, unknown>)?.["Favorite Videos"] as Record<string, unknown>)?.FavoriteVideoList as { Link?: string; Date?: string }[] | undefined;
  return (fav ?? []).filter((f) => f.Link).map((f) => ({ url: f.Link!, title: "TikTok video", platform: "tiktok", saved_at: iso(f.Date) }));
}

export function parseSavedFile(file: Buffer, filename: string): { entries: SavedEntry[]; warnings: string[] } {
  const warnings: string[] = [];
  const name = filename.toLowerCase();
  if (name.endsWith(".zip") || (file[0] === 0x50 && file[1] === 0x4b)) {
    const files = unzipSync(new Uint8Array(file), { filter: (f) => /\.(json|csv|html?)$/i.test(f.name) && !/\/\._/.test(f.name) });
    const entries: SavedEntry[] = [];
    for (const [n, data] of Object.entries(files)) {
      if (!/saved|bookmark|watch later|favorite|user_data|pocket|later/i.test(n)) continue;
      const r = parseSavedFile(Buffer.from(data), n);
      entries.push(...r.entries);
      warnings.push(...r.warnings);
    }
    if (!entries.length) warnings.push("No saved-item files recognized in the zip");
    return { entries, warnings };
  }
  const text = file.toString("utf8");
  try {
    if (name.endsWith(".html") || name.endsWith(".htm") || /<!DOCTYPE NETSCAPE-Bookmark/i.test(text)) return { entries: netscapeHtml(text, name.includes("pocket") ? "pocket" : "browser"), warnings };
    if (name.endsWith(".csv")) return { entries: fromCsv(parseCsv(text), name), warnings };
    const data = JSON.parse(text);
    if (data && typeof data === "object" && "roots" in data) return { entries: chromeBookmarks(data), warnings };
    if (name.includes("user_data") || (data && typeof data === "object" && ("Activity" in data || "Your Activity" in data))) return { entries: tiktok(data), warnings };
    const ig = instagram(data);
    if (ig.length) return { entries: ig, warnings };
    warnings.push(`${filename}: format not recognized`);
  } catch (e) {
    // Bookmarks files from Chrome have no extension.
    if (name.endsWith("bookmarks")) warnings.push(`${filename}: ${(e as Error).message}`);
    else warnings.push(`${filename}: format not recognized`);
  }
  return { entries: [], warnings };
}
