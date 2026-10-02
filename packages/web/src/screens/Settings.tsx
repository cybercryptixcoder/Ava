import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { refetchAll, useApi } from "../lib/store";
import { getPref, setPref, type ThemePref } from "../lib/theme";
import { disablePush, enablePush, pushState } from "../lib/push";
import { ago } from "../lib/time";
import { Button, ErrorLine, Field, Segmented } from "../components/ui";
import { SourcesSection } from "./SettingsSources";
import { VoiceSection } from "./SettingsVoice";
import { ConfigSection, DevSection } from "./SettingsDev";

interface S {
  locations: { id: string; label: string; tz: string }[];
  current_location_id: string;
  quiet_hours: { start: string; end: string };
  caps: { unprompted_per_day: number; max_per_wake: number };
  budgets: { system_calls: number; interactive_calls: number; usd: number };
  heartbeat_every_hours: number;
  brief_time: string;
  evening_time: string;
  weekly_review: { weekday: string; time: string };
  deadline_offsets_days: number[];
  deadline_wake_time: string;
  wake_budget: { total_per_day: number; planner_requests_per_day: number; min_gap_minutes: number };
  retention: { raw_activity_days: number; raw_audio_days: number; model_io_days: number; snapshots_days: number };
  rules: { self_pause_precision: number; self_pause_min_messages: number; max_new_per_week: number; max_active_dynamic: number; default_expiry_days: number };
  conversation: { affirmation_window: number; affirmation_max: number };
}

const SECTIONS = [
  { id: "sources", label: "Sources and connections" },
  { id: "time", label: "Time and places" },
  { id: "caps", label: "Caps and budgets" },
  { id: "voice", label: "Voice" },
  { id: "style", label: "Style notes" },
  { id: "notifications", label: "Notifications" },
  { id: "appearance", label: "Appearance" },
  { id: "privacy", label: "Privacy and data" },
  { id: "developer", label: "Developer" },
];

function useSave() {
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = async (patch: Record<string, unknown>) => {
    setError(null);
    try {
      await api.patch("/api/settings", patch);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
      refetchAll();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return { save, error, saved };
}

function NumberField({ label, value, onSave, min, max, step = 1, hint }: { label: string; value: number; onSave: (v: number) => void; min?: number; max?: number; step?: number; hint?: string }) {
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <input
          id={id}
          type="number"
          className="num"
          defaultValue={value}
          min={min}
          max={max}
          step={step}
          onBlur={(e) => {
            const v = Number(e.target.value);
            if (!Number.isNaN(v) && v !== value) onSave(v);
          }}
        />
      )}
    </Field>
  );
}

function TimeField({ label, value, onSave, hint }: { label: string; value: string; onSave: (v: string) => void; hint?: string }) {
  return (
    <Field label={label} hint={hint}>
      {(id) => <input id={id} type="time" className="num" defaultValue={value.padStart(5, "0")} onBlur={(e) => e.target.value && e.target.value !== value && onSave(e.target.value)} />}
    </Field>
  );
}

function TimeSection({ s }: { s: S }) {
  const { save, error, saved } = useSave();
  return (
    <div className="form-grid">
      <ErrorLine error={error} />
      {saved ? <p className="saved-note">Saved. Schedules were recomputed.</p> : null}
      {s.locations.map((l, i) => (
        <div key={l.id} className="form-row">
          <Field label={`Place ${i + 1}`}>
            {(id) => (
              <input
                id={id}
                defaultValue={l.label}
                onBlur={(e) => e.target.value !== l.label && void save({ locations: s.locations.map((x) => (x.id === l.id ? { ...x, label: e.target.value } : x)) })}
              />
            )}
          </Field>
          <Field label="Time zone" hint="IANA name, like America/New_York">
            {(id) => (
              <input id={id} defaultValue={l.tz} onBlur={(e) => e.target.value !== l.tz && void save({ locations: s.locations.map((x) => (x.id === l.id ? { ...x, tz: e.target.value.trim() } : x)) })} />
            )}
          </Field>
        </div>
      ))}
      <div className="form-row">
        <TimeField label="Quiet hours start" value={s.quiet_hours.start} onSave={(v) => void save({ quiet_hours: { ...s.quiet_hours, start: v } })} />
        <TimeField label="Quiet hours end" value={s.quiet_hours.end} onSave={(v) => void save({ quiet_hours: { ...s.quiet_hours, end: v } })} />
      </div>
      <div className="form-row">
        <TimeField label="Morning brief" value={s.brief_time} onSave={(v) => void save({ brief_time: v })} />
        <TimeField label="Evening planning" value={s.evening_time} onSave={(v) => void save({ evening_time: v })} />
      </div>
      <div className="form-row">
        <Field label="Weekly review day">
          {(id) => (
            <select id={id} defaultValue={s.weekly_review.weekday} onChange={(e) => void save({ weekly_review: { ...s.weekly_review, weekday: e.target.value } })}>
              {["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => (
                <option key={d} value={d}>
                  {{ mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" }[d]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <TimeField label="Weekly review time" value={s.weekly_review.time} onSave={(v) => void save({ weekly_review: { ...s.weekly_review, time: v } })} />
      </div>
      <div className="form-row">
        <NumberField label="Heartbeat every (hours)" value={s.heartbeat_every_hours} min={1} max={12} onSave={(v) => void save({ heartbeat_every_hours: v })} />
        <TimeField label="Deadline check-ins at" value={s.deadline_wake_time} onSave={(v) => void save({ deadline_wake_time: v })} />
      </div>
      <Field label="Deadline check-ins, days before" hint="Comma separated. Default 14, 3, 1.">
        {(id) => (
          <input
            id={id}
            className="num"
            defaultValue={s.deadline_offsets_days.join(", ")}
            onBlur={(e) => {
              const v = e.target.value
                .split(",")
                .map((x) => Number(x.trim()))
                .filter((x) => Number.isInteger(x) && x >= 0);
              if (v.length && v.join() !== s.deadline_offsets_days.join()) void save({ deadline_offsets_days: v });
            }}
          />
        )}
      </Field>
    </div>
  );
}

function CapsSection({ s }: { s: S }) {
  const { save, error, saved } = useSave();
  return (
    <div className="form-grid">
      <ErrorLine error={error} />
      {saved ? <p className="saved-note">Saved.</p> : null}
      <p className="band-note">These are yours to set. Nothing Ava writes can raise them.</p>
      <div className="form-row">
        <NumberField label="Messages a day (besides the brief)" value={s.caps.unprompted_per_day} min={0} max={20} onSave={(v) => void save({ caps: { ...s.caps, unprompted_per_day: v } })} />
        <NumberField label="Messages per check-in" value={s.caps.max_per_wake} min={1} max={3} onSave={(v) => void save({ caps: { ...s.caps, max_per_wake: v } })} />
      </div>
      <div className="form-row">
        <NumberField label="Ava's own model calls a day" value={s.budgets.system_calls} min={0} onSave={(v) => void save({ budgets: { ...s.budgets, system_calls: v } })} />
        <NumberField label="Model calls you start, a day" value={s.budgets.interactive_calls} min={0} onSave={(v) => void save({ budgets: { ...s.budgets, interactive_calls: v } })} />
        <NumberField label="Spend ceiling a day (USD)" value={s.budgets.usd} min={0} step={0.5} onSave={(v) => void save({ budgets: { ...s.budgets, usd: v } })} />
      </div>
      <div className="form-row">
        <NumberField label="Wakes Ava may request a day" value={s.wake_budget.total_per_day} min={1} onSave={(v) => void save({ wake_budget: { ...s.wake_budget, total_per_day: v } })} />
        <NumberField label="Minutes between her check-ins" value={s.wake_budget.min_gap_minutes} min={1} onSave={(v) => void save({ wake_budget: { ...s.wake_budget, min_gap_minutes: v } })} />
      </div>
      <div className="form-row">
        <NumberField label="New rule proposals a week" value={s.rules.max_new_per_week} min={0} onSave={(v) => void save({ rules: { ...s.rules, max_new_per_week: v } })} />
        <NumberField label="Active rules of Ava's at most" value={s.rules.max_active_dynamic} min={0} onSave={(v) => void save({ rules: { ...s.rules, max_active_dynamic: v } })} />
        <NumberField label="Rules expire after (days)" value={s.rules.default_expiry_days} min={1} onSave={(v) => void save({ rules: { ...s.rules, default_expiry_days: v } })} />
      </div>
      <div className="form-row">
        <NumberField
          label="A rule pauses itself below this precision"
          value={s.rules.self_pause_precision}
          min={0}
          max={1}
          step={0.05}
          onSave={(v) => void save({ rules: { ...s.rules, self_pause_precision: v } })}
        />
        <NumberField label="after this many messages" value={s.rules.self_pause_min_messages} min={1} onSave={(v) => void save({ rules: { ...s.rules, self_pause_min_messages: v } })} />
      </div>
      <div className="form-row">
        <NumberField label="Encouragement at most" value={s.conversation.affirmation_max} min={0} onSave={(v) => void save({ conversation: { ...s.conversation, affirmation_max: v } })} hint="Affirmations allowed per window of replies" />
        <NumberField label="per this many replies" value={s.conversation.affirmation_window} min={1} onSave={(v) => void save({ conversation: { ...s.conversation, affirmation_window: v } })} />
      </div>
    </div>
  );
}

function StyleNotes() {
  const { data } = useApi<{ id: string; text: string; active: boolean; created_at: string }[]>("/api/style-notes");
  const [text, setText] = useState("");
  return (
    <div className="style-notes">
      <p className="band-note">When you react to how Ava talks ("too long", "more like that"), she writes a note here and follows it from then on.</p>
      <ul className="notes-list">
        {(data ?? []).map((n) => (
          <li key={n.id} className="style-note" data-active={n.active || undefined}>
            <input
              aria-label="Style note"
              defaultValue={n.text}
              onBlur={(e) => e.target.value !== n.text && void api.patch(`/api/style-notes/${n.id}`, { text: e.target.value }).then(refetchAll)}
            />
            <span className="note-when">{ago(n.created_at)}</span>
            <Button size="sm" kind="quiet" onClick={() => void api.patch(`/api/style-notes/${n.id}`, { active: !n.active }).then(refetchAll)}>
              {n.active ? "Pause" : "Use again"}
            </Button>
            <Button size="sm" kind="quiet" onClick={() => void api.del(`/api/style-notes/${n.id}`).then(refetchAll)}>
              Delete
            </Button>
          </li>
        ))}
      </ul>
      <form
        className="feed-add"
        onSubmit={(e) => {
          e.preventDefault();
          void api.post("/api/style-notes", { text }).then(() => {
            setText("");
            refetchAll();
          });
        }}
      >
        <Field label="Add a note">{(id) => <input id={id} value={text} onChange={(e) => setText(e.target.value)} placeholder="Keep quick updates to one line" />}</Field>
        <Button size="sm" type="submit" disabled={!text.trim()}>
          Add note
        </Button>
      </form>
    </div>
  );
}

function Notifications() {
  const [state, setState] = useState<string>("checking");
  const [error, setError] = useState<string | null>(null);
  const { data: devices } = useApi<{ id: string; user_agent: string | null; created_at: string; last_ok_at: string | null }[]>("/api/push/devices");
  const refresh = () => void pushState().then(setState).catch(() => setState("unsupported"));
  useEffect(refresh, []);
  const text: Record<string, string> = {
    checking: "Checking this device",
    unsupported: "This browser can't receive web push. On iPhone, add Ava to the home screen first, then turn notifications on from there.",
    unavailable: "The server has no push keys yet. Run npm run vapid, set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY, and restart.",
    denied: "Notifications are blocked for this site. Allow them in the browser's site settings.",
    on: "This device gets Ava's messages as notifications.",
    off: "This device doesn't get notifications yet.",
  };
  return (
    <div>
      <p className="band-note">{text[state]}</p>
      <ErrorLine error={error} />
      <div className="row-actions">
        {state === "off" ? (
          <Button kind="primary" size="sm" onClick={() => void enablePush().then(refresh).catch((e) => setError((e as Error).message))}>
            Turn on notifications here
          </Button>
        ) : null}
        {state === "on" ? (
          <>
            <Button size="sm" onClick={() => void api.post("/api/push/test")}>
              Send a test notification
            </Button>
            <Button size="sm" kind="quiet" onClick={() => void disablePush().then(refresh)}>
              Turn off on this device
            </Button>
          </>
        ) : null}
      </div>
      {devices?.length ? (
        <ul className="devices">
          {devices.map((d) => (
            <li key={d.id}>
              <span>{(d.user_agent ?? "Unknown device").replace(/\(.*?\)/g, "").slice(0, 60)}</span>
              <span className="note-when">{d.last_ok_at ? `Last delivered ${ago(d.last_ok_at)}` : `Added ${ago(d.created_at)}`}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Appearance() {
  const [pref, set] = useState<ThemePref>(getPref());
  return (
    <div>
      <Segmented
        label="Theme"
        value={pref}
        onChange={(v) => {
          set(v);
          setPref(v);
        }}
        options={[
          { value: "auto", label: "By time of day" },
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
        ]}
      />
      <p className="band-note">By time of day uses the night dial from 19:00 to 07:00 where you are.</p>
    </div>
  );
}

function Privacy({ s }: { s: S }) {
  const { save } = useSave();
  return (
    <div className="form-grid">
      <p className="band-note">Sensitive data is encrypted at rest. Raw high-volume data is deleted once it has been distilled; the summaries and beliefs stay.</p>
      <div className="form-row">
        <NumberField label="Keep raw window titles (days)" value={s.retention.raw_activity_days} min={0.5} step={0.5} onSave={(v) => void save({ retention: { ...s.retention, raw_activity_days: v } })} />
        <NumberField label="Keep audio (days)" value={s.retention.raw_audio_days} min={0.5} step={0.5} onSave={(v) => void save({ retention: { ...s.retention, raw_audio_days: v } })} />
        <NumberField label="Keep model call bodies (days)" value={s.retention.model_io_days} min={1} onSave={(v) => void save({ retention: { ...s.retention, model_io_days: v } })} />
      </div>
      <div className="row-actions">
        <a className="btn btn-default btn-sm" href="/api/export" download>
          Export everything Ava knows
        </a>
      </div>
      <p className="band-note">To delete what one source contributed, use Delete this source's data under Sources and connections.</p>
    </div>
  );
}

export function Settings() {
  const { data, error } = useApi<{ settings: S }>("/api/settings");
  const [params] = useSearchParams();
  const section = params.get("section");
  const banner = params.get("error") ?? (params.get("connected") ? `Connected ${params.get("connected")}.` : null);
  useEffect(() => {
    if (section) document.getElementById(`set-${section}`)?.scrollIntoView({ block: "start" });
  }, [section, data]);
  if (error) return <ErrorLine error={error} />;
  if (!data) return <div className="screen" aria-busy="true" />;
  const s = data.settings;
  return (
    <div className="screen settings">
      <header className="screen-head">
        <h1 className="screen-title">Settings</h1>
      </header>
      {banner ? <p className={params.get("error") ? "error-line" : "saved-note"}>{banner}</p> : null}
      <div className="settings-grid">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((x) => (
            <a key={x.id} href={`#set-${x.id}`} className="settings-link">
              {x.label}
            </a>
          ))}
        </nav>
        <div className="settings-body">
          <section id="set-sources" className="band">
            <h2 className="section-title">Sources and connections</h2>
            <SourcesSection />
          </section>
          <section id="set-time" className="band">
            <h2 className="section-title">Time and places</h2>
            <TimeSection s={s} />
          </section>
          <section id="set-caps" className="band">
            <h2 className="section-title">Caps and budgets</h2>
            <CapsSection s={s} />
          </section>
          <section id="set-voice" className="band">
            <h2 className="section-title">Voice</h2>
            <VoiceSection />
          </section>
          <section id="set-style" className="band">
            <h2 className="section-title">Style notes</h2>
            <StyleNotes />
          </section>
          <section id="set-notifications" className="band">
            <h2 className="section-title">Notifications</h2>
            <Notifications />
          </section>
          <section id="set-appearance" className="band">
            <h2 className="section-title">Appearance</h2>
            <Appearance />
          </section>
          <section id="set-privacy" className="band">
            <h2 className="section-title">Privacy and data</h2>
            <Privacy s={s} />
          </section>
          <section id="set-developer" className="band">
            <h2 className="section-title">Developer</h2>
            <ConfigSection />
            <DevSection />
          </section>
        </div>
      </div>
    </div>
  );
}
