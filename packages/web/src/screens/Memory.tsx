import { useEffect, useState } from "react";
import type { MemoryConsolidationView, MemoryCoreView, MemoryEntryListRow, MemoryEntryView, MemoryEpisodeListRow, MemoryEpisodeView, MemoryFactListRow, MemoryFactView, MemoryForgetClosure } from "@ava/shared";
import { api } from "../lib/api";
import { refetchAll, useApi } from "../lib/store";
import { clock, dayLabel } from "../lib/time";
import { Button, Empty, ErrorLine, Segmented, Sheet } from "../components/ui";

type Tab = "raw" | "episodes" | "facts" | "core";
type ForgetTarget = { entry_ids?: string[]; episode_id?: string; fact_id?: string; title: string };
interface SearchHit {
  ref_kind: "entry" | "episode" | "fact";
  ref_id: string;
  score: number;
  at: string;
  importance: number;
  preview: string;
}

/** The forget confirmation: preview first, exactly, then one deliberate click. */
function ForgetSheet({ target, onClose }: { target: ForgetTarget; onClose: () => void }) {
  const [closure, setClosure] = useState<MemoryForgetClosure | null>(null);
  const [ids, setIds] = useState<string[]>([]);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const targetKey = JSON.stringify(target);
  useEffect(() => {
    void api
      .post<{ entry_ids: string[]; closure: MemoryForgetClosure }>("/api/memory/forget/preview", target)
      .then((r) => {
        setClosure(r.closure);
        setIds(r.entry_ids);
      })
      .catch((e: Error) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);
  const apply = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ summary: string }>("/api/memory/forget/apply", { entry_ids: ids });
      setResult(r.summary);
      refetchAll();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const n = closure?.entries.length ?? 0;
  return (
    <Sheet open title={`Forget: ${target.title}`} onClose={onClose}>
      <ErrorLine error={error} />
      {!closure && !error ? <p className="mem-note">Working out exactly what this would remove…</p> : null}
      {closure && !result ? (
        <div className="forget">
          <p className="forget-warn">
            This removes <strong>{n} raw {n === 1 ? "entry" : "entries"}</strong> from memory
            {closure.facts.length ? <>, along with <strong>{closure.facts.length}</strong> {closure.facts.length === 1 ? "derived fact" : "derived facts"} (no other source left)</> : null}
            {closure.episodes_stale.length ? <>, rebuilds <strong>{closure.episodes_stale.length}</strong> {closure.episodes_stale.length === 1 ? "gist" : "gists"} from what remains</> : null}
            {closure.episodes_removed.length ? <>, and removes <strong>{closure.episodes_removed.length}</strong> {closure.episodes_removed.length === 1 ? "gist" : "gists"} entirely</> : null}
            . It cannot be undone.
          </p>
          {closure.facts.length || closure.episodes_stale.length || closure.episodes_removed.length ? (
            <ul className="forget-derived">
              {closure.facts.map((f) => (
                <li key={f.id}>Fact removed: “{f.statement}”</li>
              ))}
              {closure.episodes_stale.map((e) => (
                <li key={e.id}>Gist rebuilt: “{e.gist}”</li>
              ))}
              {closure.episodes_removed.map((e) => (
                <li key={e.id}>Gist removed: “{e.gist}”</li>
              ))}
            </ul>
          ) : null}
          <ol className="forget-entries">
            {closure.entries.slice(0, 24).map((e) => (
              <li key={e.id}>
                <span className="mem-chip">{e.kind}</span> <span className="num">{clock(e.at)}</span> {e.preview}
              </li>
            ))}
            {closure.entries.length > 24 ? <li className="mem-note">…and {closure.entries.length - 24} more</li> : null}
            {!closure.entries.length ? <li className="mem-note">Nothing here is still in memory.</li> : null}
          </ol>
          <div className="forget-actions">
            <Button kind="danger" busy={busy} disabled={!ids.length} onClick={() => void apply()}>
              Forget {n === 1 ? "it" : "them"}
            </Button>
            <Button kind="quiet" onClick={onClose}>
              Keep {n === 1 ? "it" : "them"}
            </Button>
          </div>
        </div>
      ) : null}
      {result ? (
        <div className="forget">
          <p className="forget-done">{result}.</p>
          <Button kind="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      ) : null}
    </Sheet>
  );
}

function EntrySheet({ id, onClose, onForget, onEpisode }: { id: string; onClose: () => void; onForget: (t: ForgetTarget) => void; onEpisode: (id: string) => void }) {
  const { data, error } = useApi<{ entry: MemoryEntryView | null }>(`/api/memory/entry/${id}`);
  const e = data?.entry;
  return (
    <Sheet open title="Raw entry" onClose={onClose} wide>
      <ErrorLine error={error} />
      {e ? (
        <div className="entryview">
          <p className="mem-kv">
            <span className="label">Kind</span> {e.kind} <span className="label">Source</span> {e.source}
            {e.role ? (
              <>
                {" "}
                <span className="label">Role</span> {e.role}
              </>
            ) : null}{" "}
            <span className="label">When</span> {dayLabel(e.at)} {clock(e.at)}
          </p>
          {e.deleted ? <p className="forget-warn">This was forgotten{e.deleted_reason ? `: ${e.deleted_reason}` : ""}. The text is gone; only the tombstone remains.</p> : null}
          <pre className="mem-full">{e.text || "(empty)"}</pre>
          {e.links.length ? (
            <p className="mem-note">
              Touches: {e.links.map((l) => `${l.rel} ${l.target_kind} ${l.target_id}`).join(", ")}
            </p>
          ) : null}
          {e.episodes.length ? (
            <p className="mem-note">
              In: {e.episodes.map((ep) => (
                <button key={ep} type="button" className="mem-link" onClick={() => onEpisode(ep)}>
                  {ep}
                </button>
              ))}
            </p>
          ) : null}
          {!e.deleted ? (
            <div className="forget-actions">
              <Button kind="danger" size="sm" onClick={() => onForget({ entry_ids: [e.id], title: "this entry" })}>
                Forget this
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </Sheet>
  );
}

function EpisodeSheet({ id, onClose, onForget, onEntry }: { id: string; onClose: () => void; onForget: (t: ForgetTarget) => void; onEntry: (id: string) => void }) {
  const { data, error } = useApi<{ episode: MemoryEpisodeView | null }>(`/api/memory/episode/${id}`);
  const ep = data?.episode;
  return (
    <Sheet open title="Episode" onClose={onClose} wide>
      <ErrorLine error={error} />
      {ep ? (
        <div className="entryview">
          <p className="mem-kv">
            <span className="label">When</span> {dayLabel(ep.at)} {clock(ep.at)}–{clock(ep.end)} <span className="label">Source</span> {ep.source} <span className="label">Version</span> {ep.version}
            {ep.stale ? <span className="mem-badge">gist gets reworked tonight</span> : null}
          </p>
          <p className="mem-gist">{ep.gist || "(no gist yet)"}</p>
          <ol className="mem-list">
            {ep.entries.map((e) => (
              <li key={e.id} className="mem-row" data-deleted={e.deleted || undefined}>
                <span className="mem-chip">{e.role ?? e.kind}</span>
                <span className="num mem-time">{clock(e.at)}</span>
                <button type="button" className="mem-link mem-row-text" onClick={() => onEntry(e.id)}>
                  {e.preview}
                </button>
              </li>
            ))}
          </ol>
          <div className="forget-actions">
            <Button kind="danger" size="sm" onClick={() => onForget({ episode_id: ep.id, title: "this episode" })}>
              Forget this whole episode
            </Button>
          </div>
        </div>
      ) : null}
    </Sheet>
  );
}

function FactSheet({ id, onClose, onForget }: { id: string; onClose: () => void; onForget: (t: ForgetTarget) => void }) {
  const { data, error } = useApi<{ fact: MemoryFactView | null }>(`/api/memory/fact/${id}`);
  const f = data?.fact;
  return (
    <Sheet open title="Fact" onClose={onClose} wide>
      <ErrorLine error={error} />
      {f ? (
        <div className="entryview">
          <p className="mem-gist">{f.statement}</p>
          <p className="mem-kv">
            <span className="label">Status</span> {f.status} <span className="label">Provenance</span> {f.provenance} <span className="label">Importance</span> {f.importance.toFixed(2)}
            {f.valid_from ? (
              <>
                {" "}
                <span className="label">Valid from</span> {dayLabel(f.valid_from)}
              </>
            ) : null}
            {f.valid_to ? (
              <>
                {" "}
                <span className="label">until</span> {dayLabel(f.valid_to)}
              </>
            ) : null}
          </p>
          {f.chain.length > 1 ? (
            <>
              <h3 className="label">How it changed</h3>
              <ol className="fact-chain">
                {f.chain.map((c) => (
                  <li key={c.id} data-status={c.status}>
                    <span className="mem-chip">{c.status}</span> {c.statement}
                    <span className="mem-note">
                      {c.valid_from ? ` from ${dayLabel(c.valid_from)}` : ""}
                      {c.valid_to ? ` until ${dayLabel(c.valid_to)}` : " — current"}
                    </span>
                  </li>
                ))}
              </ol>
            </>
          ) : null}
          <h3 className="label">From his own words</h3>
          <ol className="mem-list">
            {f.source_entries.map((e) => (
              <li key={e.id} className="mem-row">
                <span className="num mem-time">{clock(e.at)}</span>
                <span className="mem-row-text">{e.preview}</span>
              </li>
            ))}
            {!f.source_entries.length ? <li className="mem-note">Its raw sources are gone.</li> : null}
          </ol>
          {f.status !== "removed" ? (
            <div className="forget-actions">
              <Button kind="danger" size="sm" onClick={() => onForget({ fact_id: f.id, title: "this fact" })}>
                Forget this fact
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </Sheet>
  );
}

export function Memory() {
  const [tab, setTab] = useState<Tab>("raw");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searchBusy, setSearchBusy] = useState(false);
  const [entry, setEntry] = useState<string | null>(null);
  const [episode, setEpisode] = useState<string | null>(null);
  const [fact, setFact] = useState<string | null>(null);
  const [forget, setForget] = useState<ForgetTarget | null>(null);
  const [factStatus, setFactStatus] = useState<"current" | "superseded">("current");

  const status = useApi<{ entries: number; by_kind: Record<string, number>; pending: number; embeddings: { model: string | null; vectors: number } }>("/api/memory/status");
  const raw = useApi<{ entries: MemoryEntryListRow[] }>(tab === "raw" && !hits ? "/api/memory/entries?limit=120" : null);
  const eps = useApi<{ episodes: MemoryEpisodeListRow[] }>(tab === "episodes" ? "/api/memory/episodes" : null);
  const facts = useApi<{ facts: MemoryFactListRow[] }>(tab === "facts" ? `/api/memory/facts?status=${factStatus}` : null);
  const core = useApi<MemoryCoreView>(tab === "core" ? "/api/memory/core" : null);
  const cons = useApi<MemoryConsolidationView>(tab === "core" ? "/api/memory/consolidate" : null);

  const runSearch = async () => {
    const query = q.trim();
    if (!query) {
      setHits(null);
      return;
    }
    setSearchBusy(true);
    try {
      const r = await api.post<{ hits: SearchHit[] }>("/api/memory/search", { query, limit: 40 });
      setHits(r.hits);
    } finally {
      setSearchBusy(false);
    }
  };
  const clearSearch = () => {
    setQ("");
    setHits(null);
  };
  const openHit = (h: SearchHit) => {
    if (h.ref_kind === "entry") setEntry(h.ref_id);
    else if (h.ref_kind === "episode") setEpisode(h.ref_id);
    else setFact(h.ref_id);
  };

  const s = status.data;
  let lastDay = "";
  return (
    <div className="screen memory">
      <header className="screen-head">
        <h1 className="screen-title">Memory</h1>
        <p className="screen-sub">The raw log and everything built from it. Forgetting happens here, with a full preview first.</p>
      </header>
      <p className="mem-band">
        {s ? (
          <>
            <strong>{s.entries.toLocaleString()}</strong> raw entries
            {s.pending ? `, ${s.pending} waiting to be processed` : ""}
            {s.embeddings.vectors ? (
              <>
                {" "}
                · {s.embeddings.vectors.toLocaleString()} embeddings ({s.embeddings.model})
              </>
            ) : null}
          </>
        ) : (
          "…"
        )}
      </p>
      <div className="mem-tools">
        <Segmented
          label="Section"
          value={tab}
          onChange={(t) => setTab(t)}
          options={[
            { value: "raw", label: "Raw log" },
            { value: "episodes", label: "Episodes" },
            { value: "facts", label: "Facts" },
            { value: "core", label: "Core" },
          ]}
        />
        {tab === "raw" ? (
          <form
            className="mem-search"
            onSubmit={(e) => {
              e.preventDefault();
              void runSearch();
            }}
          >
            <label className="visually-hidden" htmlFor="mem-q">
              Search memory
            </label>
            <input id="mem-q" type="search" placeholder="Search everything he said, gists and facts" value={q} onChange={(e) => setQ(e.target.value)} />
            <Button size="sm" busy={searchBusy} type="submit">
              Search
            </Button>
            {hits ? (
              <Button size="sm" kind="quiet" onClick={clearSearch}>
                Clear
              </Button>
            ) : null}
          </form>
        ) : null}
      </div>
      <ErrorLine error={status.error || raw.error || eps.error || facts.error || core.error || cons.error} />

      {tab === "raw" && hits ? (
        <ol className="mem-list">
          {hits.map((h) => (
            <li key={`${h.ref_kind}:${h.ref_id}`} className="mem-row">
              <span className="mem-chip">{h.ref_kind}</span>
              <span className="num mem-time">{dayLabel(h.at)}</span>
              <button type="button" className="mem-link mem-row-text" onClick={() => openHit(h)}>
                {h.preview || h.ref_id}
              </button>
            </li>
          ))}
          {!hits.length ? <li className="mem-note">Nothing in memory matches that.</li> : null}
        </ol>
      ) : null}

      {tab === "raw" && !hits ? (
        <ol className="mem-list">
          {(raw.data?.entries ?? []).map((e) => {
            const day = dayLabel(e.at);
            const showDay = day !== lastDay;
            lastDay = day;
            return (
              <li key={e.id} className="mem-row" data-deleted={e.deleted || undefined}>
                {showDay ? <span className="mem-day">{day}</span> : null}
                <span className="mem-chip">{e.kind}</span>
                <span className="num mem-time">{clock(e.at)}</span>
                <button type="button" className="mem-link mem-row-text" onClick={() => setEntry(e.id)}>
                  {e.deleted ? <em>forgotten{e.deleted_reason ? ` (${e.deleted_reason})` : ""}</em> : e.text}
                </button>
              </li>
            );
          })}
          {raw.data && !raw.data.entries.length ? <Empty title="The log is empty.">Everything he says or types lands here first.</Empty> : null}
        </ol>
      ) : null}

      {tab === "episodes" ? (
        <ol className="mem-list">
          {(eps.data?.episodes ?? []).map((e) => (
            <li key={e.id} className="mem-row">
              <span className="mem-chip">episode</span>
              <span className="num mem-time">{dayLabel(e.at)}</span>
              <button type="button" className="mem-link mem-row-text" onClick={() => setEpisode(e.id)}>
                {e.gist || "(no gist yet)"}
              </button>
              <span className="mem-note">
                {e.entries} {e.entries === 1 ? "entry" : "entries"} · v{e.version}
                {e.stale ? " · queued for rework" : ""}
              </span>
            </li>
          ))}
          {eps.data && !eps.data.episodes.length ? <Empty title="No episodes yet.">Gists appear as the log is processed in the background.</Empty> : null}
        </ol>
      ) : null}

      {tab === "facts" ? (
        <>
          <Segmented label="Facts shown" value={factStatus} onChange={(v) => setFactStatus(v)} options={[{ value: "current", label: "Current" }, { value: "superseded", label: "Superseded" }]} />
          <ol className="mem-list">
            {(facts.data?.facts ?? []).map((f) => (
              <li key={f.id} className="mem-row">
                <span className="mem-chip">{f.provenance}</span>
                <button type="button" className="mem-link mem-row-text" onClick={() => setFact(f.id)}>
                  {f.statement}
                </button>
                <span className="mem-note">
                  {f.sources} {f.sources === 1 ? "source" : "sources"}
                  {f.valid_to ? ` · until ${dayLabel(f.valid_to)}` : ""}
                  {f.canonical_id ? " · duplicate" : ""}
                </span>
              </li>
            ))}
            {facts.data && !facts.data.facts.length ? <Empty title={factStatus === "current" ? "No current facts yet." : "Nothing has been superseded yet."} /> : null}
          </ol>
        </>
      ) : null}

      {tab === "core" ? (
        <div className="mem-core">
          <h2 className="label">The core — what Ava durably knows</h2>
          {core.data?.latest ? (
            <>
              <p className="mem-note">
                Version {core.data.latest.version}, written {dayLabel(core.data.latest.created_at)} {clock(core.data.latest.created_at)}
              </p>
              <pre className="mem-full core">{core.data.latest.text}</pre>
            </>
          ) : (
            <p className="mem-note">No core yet. It gets written from facts, threads and recent gists during consolidation.</p>
          )}
          {core.data && core.data.versions.length > 1 ? (
            <p className="mem-note">
              {core.data.versions.length} versions kept · tokens: {core.data.versions.map((v) => v.tokens).join(", ")}
            </p>
          ) : null}
          <h2 className="label">Housekeeping</h2>
          {cons.data?.last ? <p className="mem-note">Last consolidation ({dayLabel(cons.data.last.at)}): {cons.data.last.summary}</p> : <p className="mem-note">No consolidation run yet; it happens nightly.</p>}
          <ol className="mem-list">
            {(cons.data?.recent ?? []).map((l, i) => (
              <li key={i} className="mem-row">
                <span className="mem-chip">{l.kind.replace("memory.", "")}</span>
                <span className="num mem-time">{clock(l.at)}</span>
                <span className="mem-row-text">{l.summary}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {entry ? <EntrySheet id={entry} onClose={() => setEntry(null)} onForget={(t) => { setEntry(null); setForget(t); }} onEpisode={(id) => setEpisode(id)} /> : null}
      {episode ? <EpisodeSheet id={episode} onClose={() => setEpisode(null)} onForget={(t) => { setEpisode(null); setForget(t); }} onEntry={(id) => setEntry(id)} /> : null}
      {fact ? <FactSheet id={fact} onClose={() => setFact(null)} onForget={(t) => { setFact(null); setForget(t); }} /> : null}
      {forget ? <ForgetSheet target={forget} onClose={() => setForget(null)} /> : null}
    </div>
  );
}
