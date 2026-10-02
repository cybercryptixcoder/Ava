import type { Services } from "../core/services";
import { parseSavedFile } from "./parsers/saved-items";
import type { SourcePlugin } from "./types";

/**
 * Saved and bookmarked items: intentions he declared and never acted on.
 * Imported deterministically (no model sees the raw list) and offered as
 * free-time suggestions by the free-block rule. Off by default.
 */
export class SavedItemsSource implements SourcePlugin {
  readonly id = "saved_items";
  readonly label = "Saved items";
  readonly description = "Bookmarks and saved posts from browser and platform exports, used for free-time suggestions.";
  readonly defaultOn = false;

  constructor(private svc: Services) {}

  configured(): boolean {
    return true;
  }
  needs(): string | null {
    return this.connected() ? null : "Upload a bookmarks file or platform export";
  }
  connected(): boolean {
    return !!this.svc.db.get("SELECT id FROM items WHERE type = 'saved_item' LIMIT 1");
  }

  import(file: Buffer, filename: string): { added: number; skipped: number; warnings: string[] } {
    const { items, log } = this.svc;
    const { entries, warnings } = parseSavedFile(file, filename);
    let added = 0,
      skipped = 0;
    for (const e of entries) {
      const ref = e.url.replace(/[#?].*$/, "").replace(/\/$/, "");
      if (items.getBySourceRef(this.id, ref)) {
        skipped++;
        continue;
      }
      const video = /youtube\.com|youtu\.be|tiktok\.com|vimeo\.com/.test(e.url);
      items.create(
        {
          type: "saved_item",
          title: e.title.slice(0, 280),
          data: { url: e.url, platform: e.platform, saved_at: e.saved_at ?? undefined, estimate_minutes: video ? 15 : 20 },
          tags: [e.platform],
        },
        { source: this.id, source_ref: ref, via: "import" },
      );
      added++;
    }
    log.info("source.saved_items", `Imported ${added} saved items from ${filename} (${skipped} duplicates skipped)`, { warnings });
    return { added, skipped, warnings };
  }

  stats(): Record<string, number> {
    const r = this.svc.db.get<{ n: number; u: number }>("SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'unread' THEN 1 ELSE 0 END) AS u FROM items WHERE type = 'saved_item' AND deleted_at IS NULL");
    return { saved: r?.n ?? 0, unread: r?.u ?? 0 };
  }

  deleteData(): number {
    return this.svc.db.run("DELETE FROM items WHERE type = 'saved_item'").changes;
  }
}
