import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/**
 * Ava's personality lives in editable files under /personality. They are
 * read fresh (with a short cache) so edits take effect without a restart.
 *
 *   voice.md        who Ava is and how she talks
 *   examples.md     good and bad example exchanges
 *   operational.md  how proactive messages, briefs and confirmations read
 *   spoken.md       how spoken replies differ from written ones
 *   testset/*.json  conversations re-run whenever the voice files change
 */
export class Personality {
  private cache = new Map<string, { at: number; text: string }>();

  constructor(readonly dir: string) {}

  read(name: string): string {
    const hit = this.cache.get(name);
    if (hit && Date.now() - hit.at < 5_000) return hit.text;
    const p = path.join(this.dir, name);
    const text = fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim() : "";
    this.cache.set(name, { at: Date.now(), text });
    return text;
  }

  voice(): string {
    return this.read("voice.md");
  }
  examples(): string {
    return this.read("examples.md");
  }
  operational(): string {
    return this.read("operational.md");
  }
  spoken(): string {
    return this.read("spoken.md");
  }

  /** Hash of the voice files; a change means the test set should be re-run. */
  hash(): string {
    const h = createHash("sha256");
    for (const f of ["voice.md", "examples.md", "operational.md", "spoken.md"]) h.update(f).update(this.read(f));
    return h.digest("hex").slice(0, 16);
  }

  testset(): { id: string; title: string; mode: "async" | "live"; context?: string; turns: { role: "user" | "ava"; text: string }[]; expect?: string[] }[] {
    const dir = path.join(this.dir, "testset");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => ({ id: f.replace(/\.json$/, ""), ...JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) }));
  }
}
