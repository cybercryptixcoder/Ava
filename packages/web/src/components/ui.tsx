import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";

export function Button({
  kind = "default",
  size = "md",
  busy,
  children,
  className,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: "default" | "primary" | "quiet" | "danger"; size?: "sm" | "md"; busy?: boolean }) {
  return (
    <button type={type} className={`btn btn-${kind} btn-${size}${className ? ` ${className}` : ""}`} aria-busy={busy || undefined} {...rest} disabled={busy || rest.disabled}>
      {children}
    </button>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="switch-track">
        <span className="switch-thumb" />
      </span>
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className="seg-opt" onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      {children(id)}
      {hint ? <div className="field-hint">{hint}</div> : null}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children ? <div className="empty-body">{children}</div> : null}
    </div>
  );
}

export function ErrorLine({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return (
    <p className="error-line" role="alert">
      {error}
    </p>
  );
}

export function Sheet({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`sheet${wide ? " sheet-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <div className="sheet-head">
          <h2 className="sheet-title">{title}</h2>
          <Button kind="quiet" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

/**
 * The escapement: Ava's state as twelve ticks. Listening follows his voice
 * level; thinking steps one tick around like a seconds hand; speaking fills
 * the ticks as the words are spoken. Idle is all ticks at rest.
 */
export function Escapement({ state, level = 0, progress = 0, size = "sm" }: { state: "idle" | "listening" | "thinking" | "speaking" | "extracting"; level?: number; progress?: number; size?: "sm" | "lg" }) {
  const n = 12;
  const lit = state === "listening" ? Math.min(n, Math.round(Math.sqrt(level) * 30)) : state === "speaking" ? Math.round(progress * n) : 0;
  const label = state === "idle" ? "Ava is idle" : state === "listening" ? "Ava is listening" : state === "speaking" ? "Ava is speaking" : "Ava is thinking";
  return (
    <span className={`escapement esc-${size}`} data-state={state} role="status" aria-label={label} title={label}>
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className="esc-tick" data-on={state === "listening" || state === "speaking" ? i < lit : undefined} style={{ ["--i" as string]: i }} />
      ))}
    </span>
  );
}

/** A strip of response ticks: acted, not now, already done, less of this, ignored. */
export function TickStrip({ stats }: { stats: { acted: number; not_now: number; already_done: number; less_of_this: number; ignored: number } }) {
  const parts: [string, number, string][] = [
    ["acted", stats.acted, "Acted on"],
    ["already", stats.already_done, "Already done"],
    ["notnow", stats.not_now, "Not now"],
    ["less", stats.less_of_this, "Less of this"],
    ["ignored", stats.ignored, "No response"],
  ];
  const total = parts.reduce((n, p) => n + p[1], 0);
  return (
    <div className="tickstrip" aria-label={parts.map(([, n, l]) => `${l} ${n}`).join(", ")}>
      {total === 0 ? <span className="tickstrip-none">No messages yet</span> : null}
      {parts.flatMap(([k, count, label]) => Array.from({ length: count }, (_, i) => <span key={`${k}${i}`} className={`ts-tick ts-${k}`} title={label} />))}
    </div>
  );
}

export function Meter({ value, label }: { value: number; label: string }) {
  return (
    <span className="meter" role="meter" aria-valuemin={0} aria-valuemax={1} aria-valuenow={value} aria-label={label}>
      <span className="meter-fill" style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }} />
    </span>
  );
}
