import { useEffect, useRef, useState } from "react";
import { stripTokens, type TurnView } from "@ava/shared";
import { clock } from "../lib/time";
import { useApi } from "../lib/store";
import { Sheet } from "./ui";

/** One ref in a reply's memory sheet: the raw text behind it, loaded on demand. */
function RefRow({ id }: { id: string }) {
  const { data } = useApi<{ entry: { text: string; at: string; kind: string } | null }>(`/api/memory/entry/${id}`);
  return (
    <li className="mem-row">
      <span className="mem-chip">{id.slice(0, 3)}</span>
      <span className="mem-row-text">{data?.entry ? data.entry.text.slice(0, 200) || "(forgotten)" : "…"}</span>
    </li>
  );
}

/** The conversation, as a list of turns. Pulled up in a sheet, not on the main page. */
export function Transcript({ turns, draft, onPlay, playing }: { turns: TurnView[]; draft: string | null; onPlay: (t: TurnView) => void; playing: string | null }) {
  const end = useRef<HTMLDivElement>(null);
  const [mem, setMem] = useState<TurnView | null>(null);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [turns.length, draft]);
  return (
    <ol className="transcript" aria-live="polite">
      {turns.map((t) => (
        <li key={t.id} className="turn" data-role={t.role}>
          <span className="turn-meta">
            <span className="turn-who">{t.role === "user" ? "You" : "Ava"}</span>
            <span className="num">{clock(t.created_at)}</span>
            {t.role === "user" && t.input_kind ? <span className="turn-kind">{t.input_kind === "live" ? "live" : t.input_kind}</span> : null}
          </span>
          <div className={t.role === "ava" ? "turn-text voice" : "turn-text"}>
            {t.text.split(/\n{2,}/).map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
          {t.role === "ava" && t.memory_used && t.memory_used.length ? (
            <button type="button" className="turn-memory" onClick={() => setMem(t)}>
              Memory: {t.memory_used.length}
            </button>
          ) : null}
          {t.role === "ava" && t.mode === "async" ? (
            <button type="button" className="turn-play" onClick={() => onPlay(t)} aria-label="Play this reply">
              {playing === t.id ? "Playing" : "Play"}
            </button>
          ) : null}
        </li>
      ))}
      {draft !== null ? (
        <li className="turn" data-role="ava" data-draft="true">
          <span className="turn-meta">
            <span className="turn-who">Ava</span>
          </span>
          <div className="turn-text voice">
            {stripTokens(draft)
              .split(/\n{2,}/)
              .map((p, i) => (
                <p key={i}>{p}</p>
              ))}
          </div>
        </li>
      ) : null}
      <div ref={end} />
      {mem ? (
        <Sheet open title="Memory behind this reply" onClose={() => setMem(null)} wide>
          <p className="mem-note">The refs from the context pack this reply drew on — each one a raw entry in the log.</p>
          <ol className="mem-list">
            {(mem.memory_used ?? []).map((id) => (
              <RefRow key={id} id={id} />
            ))}
          </ol>
        </Sheet>
      ) : null}
    </ol>
  );
}
