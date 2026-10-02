import type { CardView } from "@ava/shared";

/**
 * One card, layer 1: the one line that says what it is, a short "why now",
 * and — for a decision — its options as choices. The stack owns gestures and
 * animation; this is what a card looks like.
 */
export function CardFace({
  card,
  busy,
  onAct,
  onChoose,
  interactive = true,
}: {
  card: CardView;
  busy: boolean;
  onAct: (response: "yes" | "not_now") => void;
  onChoose: (option: string) => void;
  interactive?: boolean;
}) {
  const first = card.options[0] ?? null;
  return (
    <div className="card-face">
      <h2 className="card-title">{card.title}</h2>
      {card.why ? <p className="card-why">{card.why}</p> : null}
      {card.thread ? <p className="card-thread">{card.thread.title}</p> : null}
      {card.kind === "pick" && card.options.length > 1 ? (
        <ul className="card-options" aria-label="Choices">
          {card.options.map((o) => (
            <li key={o.key}>
              <button type="button" className="card-option" disabled={busy || !interactive} tabIndex={interactive ? undefined : -1} onClick={() => onChoose(o.key)}>
                <span className="card-option-label">{o.label}</span>
                {o.detail ? <span className="card-option-detail">{o.detail}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="card-actions">
        <button type="button" className="btn btn-primary btn-md" disabled={busy || !interactive} tabIndex={interactive ? undefined : -1} onClick={() => onAct("yes")}>
          {first?.label ?? "Got it"}
        </button>
        <button type="button" className="btn btn-default btn-md" disabled={busy || !interactive} tabIndex={interactive ? undefined : -1} onClick={() => onAct("not_now")}>
          Not now
        </button>
      </div>
    </div>
  );
}
