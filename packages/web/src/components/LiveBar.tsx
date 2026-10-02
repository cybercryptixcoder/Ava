import type { LiveState } from "../lib/live";
import { Button, Escapement } from "./ui";

/** Live mode, kept quiet: Ava's state, what she heard, what she is saying. */
export function LiveBar({
  state,
  level,
  partial,
  avaLine,
  progress,
  latency,
  onEnd,
  onDone,
}: {
  state: LiveState;
  level: number;
  partial: string;
  avaLine: string;
  progress: number;
  latency: number | null;
  onEnd: () => void;
  onDone: () => void;
}) {
  const esc = state === "listening" ? "listening" : state === "speaking" ? "speaking" : state === "thinking" ? "thinking" : "idle";
  const word = state === "connecting" ? "Connecting" : state === "listening" ? "Listening" : state === "thinking" ? "Thinking" : state === "speaking" ? "Speaking" : state === "error" ? "Something went wrong" : "Ended";
  return (
    <div className="livebar" data-state={state}>
      <div className="livebar-state">
        <Escapement state={esc} level={level} progress={progress} size="lg" />
        <span className="livebar-word">{word}</span>
        {latency !== null ? (
          <span className="livebar-latency num" title="From the end of your turn to Ava's first sound">
            {latency} ms
          </span>
        ) : null}
      </div>
      <p className="livebar-heard" aria-live="polite">
        {partial || (state === "listening" ? "Take your time. Ava waits until you've finished the thought." : "")}
      </p>
      {avaLine ? <p className="livebar-ava voice">{avaLine}</p> : null}
      <div className="livebar-actions">
        <Button size="sm" onClick={onDone} disabled={state !== "listening"}>
          I'm done talking
        </Button>
        <Button size="sm" kind="quiet" onClick={onEnd}>
          End conversation
        </Button>
      </div>
    </div>
  );
}
