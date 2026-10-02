import { useEffect, useRef, useState } from "react";
import type { CardResponse, CardView } from "@ava/shared";
import { CardFace } from "./Card";

const TAP_SLOP = 10;
const HOLD_MS = 500;
const FLY_MS = 240;

interface Drag {
  cardId: string;
  dx: number;
  dy: number;
}

/**
 * The stack: one card fully visible with the next one or two peeking out
 * behind it. Swipe right to do it, left for not now, tap for a layer,
 * long-press (or right-click) for the quieter actions; arrow keys and Enter
 * do the same from the keyboard.
 */
export function Stack({
  cards,
  busy,
  focusToken,
  focusedId,
  onRespond,
  onOpen,
  onHold,
}: {
  cards: CardView[];
  busy: boolean;
  /** Bumped by the page when focus should return to the top card. */
  focusToken: number;
  /** A card to mark as freshly arrived (the push deep link). */
  focusedId: string | null;
  onRespond: (card: CardView, response: CardResponse, option?: string | null, viaKeyboard?: boolean) => void;
  onOpen: (card: CardView) => void;
  onHold: (card: CardView) => void;
}) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const [exiting, setExiting] = useState<{ card: CardView; dx: number; dir: 1 | -1 } | null>(null);
  const start = useRef<{ x: number; y: number; t: number; intent: "none" | "horizontal" | "vertical" } | null>(null);
  const holdTimer = useRef<number | null>(null);
  const exitTimer = useRef<number | null>(null);
  const front = useRef<HTMLDivElement>(null);
  const top = cards[0] ?? null;
  const dragging = drag !== null && top !== null && drag.cardId === top.id;

  useEffect(() => {
    if (focusToken > 0) front.current?.focus();
  }, [focusToken]);
  useEffect(
    () => () => {
      if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
      if (exitTimer.current !== null) window.clearTimeout(exitTimer.current);
    },
    [],
  );

  const clearHold = () => {
    if (holdTimer.current !== null) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  };

  const threshold = () => {
    const w = front.current?.offsetWidth ?? 360;
    return Math.max(90, Math.min(170, w * 0.32));
  };

  const onPointerDown = (e: React.PointerEvent, card: CardView) => {
    if (busy || e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button, a, input, select, textarea")) return;
    start.current = { x: e.clientX, y: e.clientY, t: Date.now(), intent: "none" };
    clearHold();
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = null;
      start.current = null;
      setDrag(null);
      onHold(card);
    }, HOLD_MS);
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent, card: CardView) => {
    const s = start.current;
    if (!s || busy) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (s.intent === "none") {
      if (Math.abs(dx) > TAP_SLOP || Math.abs(dy) > TAP_SLOP) {
        s.intent = Math.abs(dx) >= Math.abs(dy) ? "horizontal" : "vertical";
        clearHold();
      } else return;
    }
    if (s.intent !== "horizontal") return;
    setDrag({ cardId: card.id, dx, dy });
  };

  const onPointerUp = (e: React.PointerEvent, card: CardView) => {
    const s = start.current;
    start.current = null;
    clearHold();
    if (!s || busy) return;
    if (s.intent === "none") {
      if (Date.now() - s.t < HOLD_MS) onOpen(card);
      return;
    }
    if (s.intent === "vertical") return;
    const dx = e.clientX - s.x;
    const t = threshold();
    if (dx > t) fly(card, "yes");
    else if (dx < -t) fly(card, "not_now");
    else setDrag(null);
  };

  /** The card leaves the deck with a short flight; the deck settles behind it. */
  const fly = (card: CardView, response: CardResponse, option?: string | null, viaKeyboard = false) => {
    const dx = drag && drag.cardId === card.id ? drag.dx : 0;
    setExiting({ card, dx, dir: response === "not_now" ? -1 : 1 });
    setDrag(null);
    if (exitTimer.current !== null) window.clearTimeout(exitTimer.current);
    exitTimer.current = window.setTimeout(() => setExiting(null), FLY_MS + 80);
    onRespond(card, response, option, viaKeyboard);
  };

  if (!top) return <div className="stack stack-empty" />;
  const width = front.current?.offsetWidth ?? 360;
  const t = threshold();
  const moveDx = dragging ? drag.dx : 0;
  const hintRight = Math.min(1, Math.max(0, moveDx / t));
  const hintLeft = Math.min(1, Math.max(0, -moveDx / t));
  const style: React.CSSProperties | undefined = dragging
    ? { transform: `translate3d(${drag.dx}px, ${drag.dy * 0.18}px, 0) rotate(${Math.max(-5, Math.min(5, drag.dx * 0.025))}deg)` }
    : undefined;
  const firstLabel = top.options[0]?.label ?? "Yes";

  return (
    <div className="stack" data-dragging={dragging || undefined} data-busy={busy || undefined}>
      {cards
        .slice(1, 3)
        .map((c, i) => (
          <div key={c.id} className="stack-peek" data-pos={i + 2} aria-hidden="true" />
        ))
        .reverse()}
      <div
        key={top.id}
        className="stack-front"
        data-focus={focusedId === top.id || undefined}
        ref={front}
        role="group"
        aria-label={top.title}
        aria-busy={busy || undefined}
        tabIndex={0}
        style={style}
        onPointerDown={(e) => onPointerDown(e, top)}
        onPointerMove={(e) => onPointerMove(e, top)}
        onPointerUp={(e) => onPointerUp(e, top)}
        onPointerCancel={() => {
          start.current = null;
          clearHold();
          setDrag(null);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onHold(top);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") {
            e.preventDefault();
            fly(top, "yes", null, true);
          } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            fly(top, "not_now", null, true);
          } else if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen(top);
          }
        }}
      >
        <CardFace card={top} busy={busy} onAct={(r) => fly(top, r)} onChoose={(o) => fly(top, "yes", o)} />
        <span className="visually-hidden">Swipe or use the arrow keys to respond; Enter opens the details. Hold for the quieter actions.</span>
      </div>
      {exiting ? (
        <div
          className="stack-front stack-leave"
          key={`${exiting.card.id}-leave`}
          aria-hidden="true"
          style={
            {
              "--fx": `${exiting.dx}px`,
              "--fr": `${Math.max(-5, Math.min(5, exiting.dx * 0.025))}deg`,
              "--tx": `${exiting.dir * (width * 1.6)}px`,
              "--tr": `${exiting.dir * 9}deg`,
            } as React.CSSProperties
          }
        >
          <CardFace card={exiting.card} busy interactive={false} onAct={() => {}} onChoose={() => {}} />
        </div>
      ) : null}
      <div className="stack-hint stack-hint-left" aria-hidden="true" style={{ opacity: hintLeft * 0.9 }}>
        Not now
      </div>
      <div className="stack-hint stack-hint-right" aria-hidden="true" style={{ opacity: hintRight * 0.9 }}>
        {firstLabel}
      </div>
      <span className="visually-hidden">{cards.length > 1 ? `${cards.length - 1} more behind this card` : ""}</span>
    </div>
  );
}
