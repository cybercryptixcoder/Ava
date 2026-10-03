import { afterEach, describe, expect, it } from "vitest";
import { atLocal } from "@ava/shared";
import { makeApp, type TestApp } from "./helpers";
import { LexicalEmbedder, type Embedder } from "../src/memory/embeddings";

const NY = "America/New_York";
let t: TestApp;
afterEach(() => t?.close());

class FakeEmbedder implements Embedder {
  constructor(
    readonly id: string,
    readonly dims: number,
    private map: Record<string, number[]>,
  ) {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((x) => Float32Array.from(this.map[x] ?? new Array(this.dims).fill(0)));
  }
}

const cos = (x: Float32Array, y: Float32Array) => x.reduce((s, v, i) => s + v * y[i], 0);

describe("embeddings", () => {
  it("the lexical fallback separates related text from unrelated text, deterministically", async () => {
    const em = new LexicalEmbedder();
    const [a, b, c] = await em.embed(["the I-20 office closes at four on weekdays", "the I-20 office is near the library", "I bought a new keyboard today"]);
    expect(cos(a, a)).toBeCloseTo(1, 5);
    expect(cos(a, b)).toBeGreaterThan(cos(a, c));
    const [a2] = await em.embed(["the I-20 office closes at four on weekdays"]);
    expect(cos(a, a2)).toBeCloseTo(1, 5);
  });

  it("semantic neighbors reach the pack with zero keyword overlap; forgetting removes them", async () => {
    t = makeApp({ at: atLocal("2026-10-05", "10:00", NY).toISOString() });
    const a = t.svc.memory.append({ kind: "turn", source: "conversation", role: "user", text: "the office closes at four on weekdays" });
    const b = t.svc.memory.append({ kind: "turn", source: "conversation", role: "user", text: "I ordered new running shoes" });
    const q = "when does the window shut?";

    // Nothing stored yet: keyword search honestly finds nothing.
    expect((await t.svc.retriever.retrieve(q, { budgetTokens: 6000 })).empty).toBe(true);

    t.svc.embeddings.useEmbedder(
      new FakeEmbedder("fake-v1", 4, {
        "the office closes at four on weekdays": [1, 0, 0, 0],
        "I ordered new running shoes": [0, 1, 0, 0],
        "when does the window shut?": [1, 0, 0, 0],
      }),
    );
    expect(await t.svc.embeddings.ensure("entry", [a, b])).toBe(2);
    expect(await t.svc.embeddings.ensure("entry", [a, b])).toBe(0); // idempotent

    const pack = await t.svc.retriever.retrieve(q, { budgetTokens: 6000 });
    expect(pack.empty).toBe(false);
    expect(pack.entries_used).toContain(a);
    expect(pack.entries_used).not.toContain(b);

    // Vectors are stored encrypted and read back exactly.
    const row = t.svc.db.get<{ vec_enc: string }>("SELECT vec_enc FROM memory_embeddings WHERE ref_id = ?", [a])!;
    expect(row.vec_enc).not.toContain(Buffer.from(Float32Array.from([1, 0, 0, 0]).buffer).toString("base64"));
    expect([...t.svc.embeddings.decode("entry", a)!]).toEqual([1, 0, 0, 0]);

    // Forgetting the entry removes its vector — the read path stops seeing it.
    t.svc.memory.forget([a], "test cleanup");
    expect(t.svc.embeddings.decode("entry", a)).toBeNull();
    expect((await t.svc.retriever.retrieve(q, { budgetTokens: 6000 })).empty).toBe(true);
  });

  it("re-embedding switches models and clears the old vectors", async () => {
    t = makeApp({ at: atLocal("2026-10-05", "10:00", NY).toISOString() });
    const a = t.svc.memory.append({ kind: "turn", source: "conversation", role: "user", text: "hello there" });
    t.svc.embeddings.useEmbedder(new FakeEmbedder("fake-v1", 4, { "hello there": [1, 0, 0, 0] }));
    expect(await t.svc.embeddings.reembedAll()).toBe(1);
    expect(t.svc.embeddings.count().model).toBe("fake-v1");

    t.svc.embeddings.useEmbedder(new FakeEmbedder("fake-v2", 2, { "hello there": [0, 1] }));
    expect(await t.svc.embeddings.reembedAll()).toBe(1);
    const c = t.svc.embeddings.count();
    expect(c.model).toBe("fake-v2");
    expect(c.vectors).toBe(1);
    expect(c.dims).toBe(2);
    expect(t.svc.db.get("SELECT 1 FROM memory_embeddings WHERE model = 'fake-v1'")).toBeUndefined();
    expect(t.svc.embeddings.decode("entry", a)!.length).toBe(2);
  });
});
