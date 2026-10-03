import { describe, expect, it } from "vitest";
import { readyPackOrNull } from "../src/voice/live";
import type { ContextPack } from "../src/memory/retriever";

describe("live-mode speculative retrieval", () => {
  it("uses the pack when it is ready in time", async () => {
    const pack: ContextPack = { empty: false, skipped: false, via: "direct", gists: [], facts: [], excerpts: [], entries_used: ["ent_x"], tokens: 10 };
    expect(await readyPackOrNull(Promise.resolve(pack), 50)).toBe(pack);
  });

  it("falls back to core + window when retrieval is slow", async () => {
    const slow = new Promise<null>((resolve) => setTimeout(() => resolve(null), 60));
    const t0 = Date.now();
    expect(await readyPackOrNull(slow, 10)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(55); // returned at the grace mark, not when retrieval finished
  });

  it("treats a failed retrieval as no pack", async () => {
    const failed = Promise.reject(new Error("boom")).catch(() => null);
    expect(await readyPackOrNull(failed, 50)).toBeNull();
  });
});
