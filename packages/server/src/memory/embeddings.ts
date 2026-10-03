import type { Services } from "../core/services";
import type { RefKind } from "./search";

/**
 * Embeddings behind an adapter, for semantic memory search. The default is a
 * small local model (all-MiniLM-L6-v2 through transformers.js) so memory
 * never leaves the server and needs no extra API key. A hosted endpoint can
 * be configured instead (EMBEDDINGS_URL), and a built-in lexical fallback
 * keeps everything deterministic when neither is available (CI, offline
 * machines). Vectors are stored field-encrypted; re-embedding everything is
 * a single command (npm run memory:reembed).
 */

export interface Embedder {
  readonly id: string;
  readonly dims: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

const fnv = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

/** Deterministic, dependency-free fallback: a hashed token bag, L2-normalized. Real but weak. */
export class LexicalEmbedder implements Embedder {
  readonly id = "lexical-256";
  readonly dims = 256;
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = new Float32Array(this.dims);
      for (const tok of t.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
        if (tok.length < 2) continue;
        v[fnv(tok) % this.dims] += 1;
        v[fnv(`${tok}#2`) % this.dims] += 0.5;
      }
      let n = 0;
      for (const x of v) n += x * x;
      n = Math.sqrt(n) || 1;
      for (let i = 0; i < v.length; i++) v[i] /= n;
      return v;
    });
  }
}

/** The small local model. Loaded lazily on first use; the model files cache after the first download. */
export class LocalEmbedder implements Embedder {
  readonly id = "Xenova/all-MiniLM-L6-v2";
  readonly dims = 384;
  private pipe: ((input: string[], opts: Record<string, unknown>) => Promise<{ tolist(): number[][] }>) | null = null;
  private loading: Promise<unknown> | null = null;

  private async ready(): Promise<(input: string[], opts: Record<string, unknown>) => Promise<{ tolist(): number[][] }>> {
    if (this.pipe) return this.pipe;
    this.loading ??= (async () => {
      const m = await import("@huggingface/transformers");
      this.pipe = (await m.pipeline("feature-extraction", this.id, { dtype: "q8" })) as unknown as (input: string[], opts: Record<string, unknown>) => Promise<{ tolist(): number[][] }>;
    })();
    await this.loading;
    return this.pipe!;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const pipe = await this.ready();
    const out = await pipe(texts, { pooling: "mean", normalize: true });
    return out.tolist().map((row) => Float32Array.from(row));
  }
}

/** An OpenAI-compatible hosted embeddings endpoint (optional). */
export class HostedEmbedder implements Embedder {
  readonly dims = 0;
  constructor(
    private opts: { url: string; key: string | null; model: string },
    readonly id: string = `hosted:${opts.model}`,
  ) {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    const res = await fetch(this.opts.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.opts.key ? { authorization: `Bearer ${this.opts.key}` } : {}) },
      body: JSON.stringify({ model: this.opts.model, input: texts }),
    });
    if (!res.ok) throw new Error(`The embeddings endpoint answered ${res.status}`);
    const body = (await res.json()) as { data?: { embedding: number[] }[] };
    return (body.data ?? []).map((d) => Float32Array.from(d.embedding));
  }
}

async function localAvailable(): Promise<boolean> {
  try {
    await import("@huggingface/transformers");
    return true;
  } catch {
    return false;
  }
}

export async function pickEmbedder(svc: Services): Promise<Embedder> {
  const provider = svc.settings.get().memory.embeddings.provider;
  const hosted = svc.cfg.embeddings.url ? new HostedEmbedder({ url: svc.cfg.embeddings.url, key: svc.cfg.embeddings.key, model: svc.cfg.embeddings.model }) : null;
  // The test profile is offline by design: deterministic lexical vectors only.
  if (svc.cfg.profile === "test" || provider === "lexical") return new LexicalEmbedder();
  if (provider === "hosted") return hosted ?? new LexicalEmbedder();
  if (provider === "local") return (await localAvailable()) ? new LocalEmbedder() : new LexicalEmbedder();
  if (await localAvailable()) return new LocalEmbedder();
  return hosted ?? new LexicalEmbedder();
}

const b64 = (v: Float32Array): string => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
const unb64 = (s: string): Float32Array => {
  const buf = Buffer.from(s, "base64");
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
};

export class Embeddings {
  private embedder: Embedder | null = null;

  constructor(private svc: Services) {}

  /** Test seam: pin an embedder without detection. */
  useEmbedder(e: Embedder): void {
    this.embedder = e;
  }

  async current(): Promise<Embedder> {
    this.embedder ??= await pickEmbedder(this.svc);
    return this.embedder;
  }

  /** The model id the stored vectors belong to (null when nothing is stored yet). */
  modelId(): string | null {
    return this.svc.memory.getState<string>("embeddings.model");
  }

  count(): { model: string | null; vectors: number; dims: number | null } {
    const model = this.modelId();
    if (!model) return { model: null, vectors: 0, dims: null };
    const r = this.svc.db.get<{ n: number; dims: number }>("SELECT COUNT(*) AS n, MAX(dims) AS dims FROM memory_embeddings WHERE model = ?", [model]);
    return { model, vectors: r?.n ?? 0, dims: r?.dims ?? null };
  }

  private stored(kind: RefKind, id: string, model: string): boolean {
    return !!this.svc.db.get("SELECT 1 FROM memory_embeddings WHERE ref_kind = ? AND ref_id = ? AND model = ?", [kind, id, model]);
  }

  private textOf(kind: RefKind, id: string): string | null {
    const { db, cipher } = this.svc;
    if (kind === "entry") {
      const r = db.get<{ text_enc: string; deleted_at: string | null }>("SELECT text_enc, deleted_at FROM entries WHERE id = ?", [id]);
      return r && !r.deleted_at ? (cipher.decOpt(r.text_enc) ?? "") : null;
    }
    if (kind === "episode") {
      const r = db.get<{ gist_enc: string | null }>("SELECT gist_enc FROM episodes WHERE id = ?", [id]);
      return r?.gist_enc ? (cipher.decOpt(r.gist_enc) ?? "") : null;
    }
    const r = db.get<{ statement_enc: string }>("SELECT statement_enc FROM facts WHERE id = ? AND status != 'removed'", [id]);
    return r ? (cipher.decOpt(r.statement_enc) ?? "") : null;
  }

  /** Embed and store (encrypted) any of these refs not yet embedded for the current model. */
  async ensure(kind: RefKind, ids: string[]): Promise<number> {
    const wanted = [...new Set(ids)];
    if (!wanted.length) return 0;
    const em = await this.current();
    const missing = wanted.filter((id) => !this.stored(kind, id, em.id));
    if (!missing.length) return 0;
    const texts: { id: string; text: string }[] = [];
    for (const id of missing) {
      const text = this.textOf(kind, id);
      if (text && text.trim()) texts.push({ id, text: text.slice(0, 8000) });
    }
    if (!texts.length) return 0;
    const vecs = await em.embed(texts.map((t) => t.text));
    const now = this.svc.clock.now().toISOString();
    for (let i = 0; i < texts.length; i++) {
      this.svc.db.run("INSERT OR REPLACE INTO memory_embeddings (ref_kind, ref_id, model, dims, vec_enc, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
        kind,
        texts[i].id,
        em.id,
        vecs[i].length,
        this.svc.cipher.encrypt(b64(vecs[i])),
        now,
      ]);
    }
    this.svc.memory.setState("embeddings.model", em.id);
    return texts.length;
  }

  /** The stored vector for a ref under the current model, decrypted. */
  decode(kind: RefKind, id: string): Float32Array | null {
    const model = this.modelId();
    if (!model) return null;
    const r = this.svc.db.get<{ vec_enc: string }>("SELECT vec_enc FROM memory_embeddings WHERE ref_kind = ? AND ref_id = ? AND model = ?", [kind, id, model]);
    if (!r) return null;
    return unb64(this.svc.cipher.decOpt(r.vec_enc) ?? "");
  }

  remove(kind: RefKind, id: string): void {
    this.svc.db.run("DELETE FROM memory_embeddings WHERE ref_kind = ? AND ref_id = ?", [kind, id]);
  }

  /** Embed the query and return the nearest stored refs by cosine similarity. */
  async nearest(query: string, opts: { k?: number; minCos?: number } = {}): Promise<{ ref_kind: RefKind; ref_id: string; cos: number }[]> {
    const model = this.modelId();
    if (!model) return [];
    let qv: Float32Array | null = null;
    try {
      const [v] = await (await this.current()).embed([query.slice(0, 2000)]);
      qv = v;
    } catch (e) {
      this.svc.log.warn("memory.embed", `Query embedding failed, keyword search only: ${(e as Error).message}`);
      return [];
    }
    if (!qv) return [];
    const rows = this.svc.db.all<{ ref_kind: RefKind; ref_id: string; vec_enc: string }>("SELECT ref_kind, ref_id, vec_enc FROM memory_embeddings WHERE model = ?", [model]);
    const minCos = opts.minCos ?? 0.25;
    const out: { ref_kind: RefKind; ref_id: string; cos: number }[] = [];
    for (const r of rows) {
      const v = unb64(this.svc.cipher.decOpt(r.vec_enc) ?? "");
      if (v.length !== qv.length) continue;
      let dot = 0;
      for (let i = 0; i < v.length; i++) dot += v[i] * qv[i];
      if (dot >= minCos) out.push({ ref_kind: r.ref_kind, ref_id: r.ref_id, cos: dot });
    }
    out.sort((a, b) => b.cos - a.cos);
    return out.slice(0, opts.k ?? 30);
  }

  /** Re-embed everything for the current embedder: one command, idempotent. */
  async reembedAll(): Promise<number> {
    const em = await this.current();
    this.svc.db.run("DELETE FROM memory_embeddings WHERE model != ?", [em.id]);
    const entries = this.svc.db.all<{ id: string }>("SELECT id FROM entries WHERE deleted_at IS NULL").map((r) => r.id);
    const episodes = this.svc.db.all<{ id: string }>("SELECT id FROM episodes WHERE gist_enc IS NOT NULL").map((r) => r.id);
    const facts = this.svc.db.all<{ id: string }>("SELECT id FROM facts WHERE status != 'removed'").map((r) => r.id);
    let n = 0;
    for (const [kind, ids] of [["entry", entries], ["episode", episodes], ["fact", facts]] as [RefKind, string[]][]) {
      for (let i = 0; i < ids.length; i += 32) {
        n += await this.ensure(kind, ids.slice(i, i + 32));
      }
    }
    this.svc.memory.setState("embeddings.model", em.id);
    this.svc.log.info("memory.embed", `Re-embedded all memory for ${em.id}: ${n} vectors`);
    return n;
  }
}
