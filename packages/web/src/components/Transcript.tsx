import { useEffect, useRef } from "react";
import { stripTokens, type TurnView } from "@ava/shared";
import { clock } from "../lib/time";

/** The conversation, as a list of turns. Pulled up in a sheet, not on the main page. */
export function Transcript({ turns, draft, onPlay, playing }: { turns: TurnView[]; draft: string | null; onPlay: (t: TurnView) => void; playing: string | null }) {
  const end = useRef<HTMLDivElement>(null);
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
    </ol>
  );
}
