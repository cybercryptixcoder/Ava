import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Escapement } from "./ui";

/**
 * The bottom bar: a prominent microphone (tap to record a voice note), a text
 * field that sends with Enter, and one slot that shows Live when there is
 * nothing to send and Send when there is.
 */
export function InputBar({
  busy,
  onSend,
  onAudio,
  onLive,
}: {
  busy: boolean;
  onSend: (text: string) => void;
  onAudio: (file: File) => void;
  onLive: () => void;
}) {
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem("ava.draft") ?? "";
    } catch {
      return "";
    }
  });
  const [rec, setRec] = useState<{ startedAt: number } | null>(null);
  const [level, setLevel] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const cancelled = useRef(false);
  const chunks = useRef<Blob[]>([]);
  const stream = useRef<MediaStream | null>(null);
  const levelRaf = useRef<number>(0);
  const levelCtx = useRef<AudioContext | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [text]);
  useEffect(() => {
    const t = window.setTimeout(() => {
      try {
        localStorage.setItem("ava.draft", text);
      } catch {
        /* storage unavailable */
      }
    }, 400);
    return () => window.clearTimeout(t);
  }, [text]);
  useEffect(
    () => () => {
      stream.current?.getTracks().forEach((t) => t.stop());
      void levelCtx.current?.close().catch(() => {});
      cancelAnimationFrame(levelRaf.current);
    },
    [],
  );

  const send = () => {
    const t = text.trim();
    if (!t || busy) return;
    onSend(t);
    setText("");
  };

  const startRecording = async () => {
    setMicError(null);
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      stream.current = media;
      // A real level for the escapement while recording.
      const ctx = new AudioContext();
      levelCtx.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(media).connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const read = () => {
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128);
        setLevel(peak);
        levelRaf.current = requestAnimationFrame(read);
      };
      read();
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m));
      const mr = new MediaRecorder(media, mime ? { mimeType: mime } : undefined);
      recorder.current = mr;
      chunks.current = [];
      cancelled.current = false;
      mr.ondataavailable = (e) => {
        if (e.data.size) chunks.current.push(e.data);
      };
      mr.onstop = () => {
        const type = mr.mimeType || "audio/webm";
        const blob = new Blob(chunks.current, { type });
        media.getTracks().forEach((t) => t.stop());
        stream.current = null;
        void levelCtx.current?.close().catch(() => {});
        levelCtx.current = null;
        cancelAnimationFrame(levelRaf.current);
        setLevel(0);
        setRec(null);
        if (!cancelled.current && blob.size) onAudio(new File([blob], `voice-note.${type.includes("mp4") ? "m4a" : "webm"}`, { type }));
      };
      mr.start(250);
      setRec({ startedAt: Date.now() });
      // Five minutes is plenty for one thought.
      window.setTimeout(() => {
        if (recorder.current?.state === "recording") recorder.current.stop();
      }, 5 * 60_000);
    } catch (e) {
      setMicError("Couldn't reach the microphone. Allow access in your browser, or type instead.");
      void e;
    }
  };

  const stopRecording = () => {
    if (recorder.current?.state === "recording") recorder.current.stop();
  };
  const cancelRecording = () => {
    cancelled.current = true;
    stopRecording();
  };

  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!rec) return;
    const t = window.setInterval(() => setElapsed(Math.floor((Date.now() - rec.startedAt) / 1000)), 500);
    return () => window.clearInterval(t);
  }, [rec]);

  if (rec) {
    const mm = Math.floor(elapsed / 60);
    const ss = String(elapsed % 60).padStart(2, "0");
    return (
      <div className="inputbar inputbar-recording" role="group" aria-label="Recording a voice note">
        <Escapement state="listening" level={level} />
        <span className="inputbar-elapsed num" aria-live="polite">
          Recording {mm}:{ss}
        </span>
        <button type="button" className="btn btn-primary btn-md" onClick={stopRecording}>
          Stop and send
        </button>
        <button type="button" className="btn btn-quiet btn-md" onClick={cancelRecording}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <form
      className="inputbar"
      aria-label="Talk to Ava"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <button
        type="button"
        className="mic"
        disabled={busy}
        aria-label="Record a voice note"
        title="Record a voice note"
        onClick={() => void startRecording()}
      >
        <span className="mic-glyph" aria-hidden="true" />
      </button>
      <label className="visually-hidden" htmlFor="home-input">
        Say something, or type
      </label>
      <textarea
        id="home-input"
        ref={ref}
        rows={1}
        value={text}
        placeholder="Say something, or type. As long as you like."
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        spellCheck
      />
      {text.trim() ? (
        <button type="submit" className="btn btn-primary btn-md" disabled={busy}>
          Send
        </button>
      ) : (
        <button type="button" className="btn btn-default btn-md inputbar-live" disabled={busy} onClick={onLive} title="Start a live conversation">
          Live
        </button>
      )}
      {micError ? (
        <p className="inputbar-error" role="alert">
          {micError}
        </p>
      ) : null}
    </form>
  );
}
