import type { ShadowFiring, ShadowResult } from "@ava/shared";
import { clock, dayLabel } from "../lib/time";

const OUTCOME: Record<ShadowFiring["outcome"], string> = {
  would_message: "Would have messaged you",
  would_queue_for_brief: "Would have waited for the brief",
  blocked_quiet_hours: "Held: quiet hours",
  blocked_class: "Held: you were in class",
  blocked_cap: "Held: daily cap reached",
  blocked_cooldown: "Held: cooldown",
  would_prepare: "Would have prepared work",
  would_wake: "Would have woken Ava",
};

/** What a proposed rule would have done over its shadow run. */
export function Shadow({ shadow }: { shadow: ShadowResult | null }) {
  const s = shadow;
  if (!s) return <p className="shadow-none">No shadow run yet.</p>;
  const from = new Date(s.from).getTime();
  const to = new Date(s.to).getTime();
  return (
    <div className="shadow">
      <p className="label">
        Shadow run over {Math.round((to - from) / 86_400_000)} days: {s.firings.length ? `${s.firings.length} time${s.firings.length === 1 ? "" : "s"}` : "it would not have fired"}
      </p>
      <div className="shadow-track" aria-hidden="true">
        {Array.from({ length: Math.round((to - from) / 86_400_000) + 1 }, (_, d) => (
          <span key={d} className="shadow-day" style={{ left: `${(d / Math.max(1, Math.round((to - from) / 86_400_000))) * 100}%` }} />
        ))}
        {s.firings.map((f, i) => (
          <span key={i} className="shadow-mark" data-outcome={f.outcome} style={{ left: `${((new Date(f.at).getTime() - from) / (to - from)) * 100}%` }} />
        ))}
      </div>
      {s.firings.length ? (
        <ul className="shadow-list">
          {s.firings.slice(0, 8).map((f, i) => (
            <li key={i} data-outcome={f.outcome}>
              <span className="num shadow-when">
                {dayLabel(f.at)} {clock(f.at)}
              </span>
              <span>{OUTCOME[f.outcome]}</span>
              <span className="shadow-items">{f.item_titles.join(", ")}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
