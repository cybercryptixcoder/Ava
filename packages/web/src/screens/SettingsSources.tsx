import { useRef, useState } from "react";
import type { Proposal, SourceView } from "@ava/shared";
import { api } from "../lib/api";
import { refetchAll, useApi } from "../lib/store";
import { ago } from "../lib/time";
import { Button, ErrorLine, Field, Switch } from "../components/ui";
import { ChipRow } from "../modules/modules";

interface Feed {
  id: string;
  label: string;
  kind: string;
  enabled: boolean;
  last_fetch_at: string | null;
  last_error: string | null;
  url_hint: string;
}

function Upload({ label, path, accept, onDone }: { label: string; path: string; accept: string; onDone: (r: unknown) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept={accept}
        className="visually-hidden"
        tabIndex={-1}
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          setBusy(true);
          setError(null);
          try {
            const form = new FormData();
            form.append("file", f, f.name);
            onDone(await api.upload(path, form));
            refetchAll();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      />
      <Button size="sm" busy={busy} onClick={() => ref.current?.click()}>
        {label}
      </Button>
      <ErrorLine error={error} />
    </>
  );
}

function SourceExtras({ s }: { s: SourceView }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data: feeds } = useApi<Feed[]>(s.id === "ics" ? "/api/ics" : null);
  const { data: imports } = useApi<{ jobs: { id: string; filename: string; conversations: number; kept: number; processed: number; proposals: number; status: string }[]; pending: Proposal[] }>(s.id === "chat_import" ? "/api/import/chat" : null);
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      refetchAll();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  switch (s.id) {
    case "gcal":
      return (
        <div className="src-extra">
          {s.configured ? (
            <a className="btn btn-default btn-sm" href="/api/oauth/google/start?kind=calendar">
              {s.connected ? "Reconnect Google Calendar" : "Connect Google Calendar"}
            </a>
          ) : null}
          {s.connected ? (
            <Button size="sm" kind="quiet" busy={busy} onClick={() => void run(() => api.post("/api/google/disconnect"))}>
              Disconnect Google
            </Button>
          ) : null}
        </div>
      );
    case "gmail":
      return s.configured ? (
        <div className="src-extra">
          <a className="btn btn-default btn-sm" href="/api/oauth/google/start?kind=gmail">
            {s.connected ? "Reconnect Gmail" : "Connect Gmail (sent mail only)"}
          </a>
        </div>
      ) : null;
    case "ics":
      return (
        <div className="src-extra src-feeds">
          {feeds?.length ? (
            <ul className="feeds">
              {feeds.map((f) => (
                <li key={f.id} className="feed">
                  <span className="feed-label">{f.label}</span>
                  <span className="feed-host">{f.url_hint}</span>
                  <span className="feed-when">{f.last_error ? <span className="error-text">{f.last_error}</span> : f.last_fetch_at ? `Synced ${ago(f.last_fetch_at)}` : "Not synced yet"}</span>
                  <Button size="sm" kind="quiet" onClick={() => void run(() => api.del(`/api/ics/${f.id}`))}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          <form
            className="feed-add"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const r = await api.post<{ summary: string }>("/api/ics", { url, label: label || "Course calendar", kind: "course" });
                setMsg(`Added: ${r.summary}`);
                setUrl("");
                setLabel("");
              });
            }}
          >
            <Field label="Feed URL">{(id) => <input id={id} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://… or webcal://…" required />}</Field>
            <Field label="Name">{(id) => <input id={id} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="CMPSC 465" />}</Field>
            <Button size="sm" type="submit" busy={busy} disabled={!url}>
              Add feed
            </Button>
          </form>
          {msg ? <p className="mod-result">{msg}</p> : null}
          <ErrorLine error={error} />
        </div>
      );
    case "chat_import":
      return (
        <div className="src-extra">
          <Upload label="Import a ChatGPT or Claude export" path="/api/import/chat" accept=".zip,.json,.jsonl" onDone={() => setMsg("Imported. Ava is reading your side of the conversations; proposals appear below as they're ready.")} />
          {msg ? <p className="mod-result">{msg}</p> : null}
          {imports?.jobs.map((j) => (
            <p key={j.id} className="import-job">
              {j.filename}: {j.kept} of {j.conversations} conversations kept, {j.processed} read, {j.proposals} proposals {j.status === "running" ? "(still reading)" : ""}
            </p>
          ))}
          {imports?.pending.length ? (
            <div className="import-review">
              <p className="label">To review, newest first (older ones may no longer matter)</p>
              <ul className="chips-list">
                {imports.pending.slice(0, 40).map((p) => (
                  <ChipRow key={p.id} p={p} />
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      );
    case "saved_items":
      return (
        <div className="src-extra">
          <Upload label="Import bookmarks or an export" path="/api/import/saved" accept=".zip,.json,.csv,.html,.htm,*" onDone={(r) => setMsg(`Added ${(r as { added: number }).added} saved items.`)} />
          {msg ? <p className="mod-result">{msg}</p> : null}
        </div>
      );
    case "wispr":
      return (
        <div className="src-extra">
          <Button
            size="sm"
            busy={busy}
            onClick={() =>
              void run(async () => {
                const r = await api.post<{ connected: boolean; authUrl: string | null }>("/api/sources/wispr/connect");
                if (r.authUrl) window.location.href = r.authUrl;
                else setMsg(r.connected ? "Connected." : "Couldn't start sign-in.");
              })
            }
          >
            {s.connected ? "Reconnect Wispr Flow" : "Connect Wispr Flow"}
          </Button>
          {msg ? <p className="mod-result">{msg}</p> : null}
          <ErrorLine error={error} />
        </div>
      );
    case "activity":
      return (
        <div className="src-extra">
          <p className="src-help">
            On your laptop, run <code>npx ava-collector --server {location.origin} --token &lt;COLLECTOR_TOKEN&gt;</code> (see the README). It merges samples into sessions locally and sends only sessions.
          </p>
        </div>
      );
    default:
      return null;
  }
}

export function SourcesSection({ only }: { only?: string[] } = {}) {
  const { data, error } = useApi<SourceView[]>("/api/sources");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const run = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setErr(null);
    try {
      await fn();
      refetchAll();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  if (error) return <ErrorLine error={error} />;
  if (!data) return <div aria-busy="true" />;
  return (
    <div className="sources">
      <ErrorLine error={err} />
      {data
        .filter((s) => !only || only.includes(s.id))
        .map((s) => (
        <article key={s.id} className="src" data-enabled={s.enabled || undefined}>
          <header className="src-head">
            <h3 className="src-name">{s.label}</h3>
            <Switch checked={s.enabled} label={`${s.label} on or off`} onChange={(v) => void run(s.id, () => api.post(`/api/sources/${s.id}/enabled`, { enabled: v }))} />
          </header>
          <p className="src-desc">{s.description}</p>
          <p className="src-state">
            {s.needs ? <span className="src-needs">{s.needs}</span> : <span>Ready</span>}
            {s.last_sync_at ? <span> Synced {ago(s.last_sync_at)}.</span> : null}
            {s.last_error ? <span className="error-text"> Last error: {s.last_error}</span> : null}
            {Object.entries(s.stats).map(([k, v]) => (
              <span key={k} className="src-stat">
                <span className="num">{v}</span> {k.replace(/_/g, " ")}
              </span>
            ))}
          </p>
          <SourceExtras s={s} />
          <div className="row-actions">
            {["gcal", "ics", "gmail", "wispr", "activity", "chat_import"].includes(s.id) && s.connected ? (
              <Button size="sm" kind="quiet" busy={busy === s.id} onClick={() => void run(s.id, () => api.post(`/api/sources/${s.id}/sync`))}>
                Sync now
              </Button>
            ) : null}
            {confirmDelete === s.id ? (
              <>
                <span className="confirm-q">Delete everything {s.label} contributed?</span>
                <Button size="sm" kind="danger" busy={busy === s.id} onClick={() => void run(s.id, () => api.del(`/api/sources/${s.id}/data`)).then(() => setConfirmDelete(null))}>
                  Delete
                </Button>
                <Button size="sm" onClick={() => setConfirmDelete(null)}>
                  Keep it
                </Button>
              </>
            ) : (
              <Button size="sm" kind="quiet" onClick={() => setConfirmDelete(s.id)}>
                Delete this source's data
              </Button>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}
