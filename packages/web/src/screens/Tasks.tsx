import { useState } from "react";
import { DateTime } from "luxon";
import type { HydratedItem } from "@ava/shared";
import { api } from "../lib/api";
import { refetchAll, useApi } from "../lib/store";
import { tz } from "../lib/time";
import { Button, Empty, ErrorLine, Field, Sheet } from "../components/ui";
import { ItemRow } from "../components/ItemRow";

interface Project extends HydratedItem {
  next_step: string | null;
  important: boolean;
  days_since_touched: number;
  open_count: number;
}
interface TasksResp {
  items: HydratedItem[];
  done: HydratedItem[];
  projects: Project[];
  saved: (HydratedItem & { url: string | null; platform: string | null })[];
}

function Group({ title, note, items }: { title: string; note?: string; items: HydratedItem[] }) {
  if (!items.length) return null;
  return (
    <section className="group" aria-label={title}>
      <header className="group-head">
        <h2 className="section-title">{title}</h2>
        <span className="num group-count">{items.length}</span>
        {note ? <p className="group-note">{note}</p> : null}
      </header>
      <ul className="items">
        {items.map((i) => (
          <ItemRow key={i.id} item={i} />
        ))}
      </ul>
    </section>
  );
}

function AddItem({ projects, onClose }: { projects: Project[]; onClose: () => void }) {
  const [type, setType] = useState("task");
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [project, setProject] = useState("");
  const [person, setPerson] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/items", {
        type,
        title,
        due_at: due ? DateTime.fromISO(due, { zone: tz() }).toUTC().toISO() : null,
        project_id: project || null,
        data: person ? { to_person: person } : {},
        importance: type === "project" ? 2 : undefined,
      });
      refetchAll();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Field label="What it is">
        {(id) => (
          <select id={id} value={type} onChange={(e) => setType(e.target.value)}>
            <option value="task">Task</option>
            <option value="commitment">Commitment to someone</option>
            <option value="open_loop">Reply I owe</option>
            <option value="project">Project</option>
            <option value="goal">Goal</option>
          </select>
        )}
      </Field>
      <Field label="Title">{(id) => <input id={id} value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus />}</Field>
      {type !== "project" && type !== "goal" ? (
        <Field label="Due" hint="Optional. In your current time zone.">
          {(id) => <input id={id} type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />}
        </Field>
      ) : null}
      {type === "commitment" || type === "open_loop" ? (
        <Field label="Who it's for">{(id) => <input id={id} value={person} onChange={(e) => setPerson(e.target.value)} />}</Field>
      ) : null}
      {type !== "project" && projects.length ? (
        <Field label="Project">
          {(id) => (
            <select id={id} value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">None</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          )}
        </Field>
      ) : null}
      <ErrorLine error={error} />
      <div className="row-actions">
        <Button kind="primary" type="submit" busy={busy} disabled={!title.trim()}>
          Add
        </Button>
        <Button type="button" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function Tasks() {
  const { data, error } = useApi<TasksResp>("/api/tasks");
  const [adding, setAdding] = useState(false);
  if (error) return <ErrorLine error={error} />;
  if (!data) return <div className="screen" aria-busy="true" />;
  const tasks = data.items.filter((i) => i.type === "task");
  const almost = tasks.filter((i) => ["drafted", "almost_done"].includes(i.status)).sort((a, b) => b.days_in_status - a.days_in_status);
  const started = tasks.filter((i) => i.status === "started");
  const todo = tasks.filter((i) => i.status === "todo");
  const people = data.items.filter((i) => i.type !== "task");
  const maxStale = Math.max(14, ...data.projects.map((p) => p.days_since_touched));
  return (
    <div className="screen tasks">
      <header className="screen-head">
        <h1 className="screen-title">Tasks and projects</h1>
        <Button kind="primary" size="sm" onClick={() => setAdding(true)}>
          Add something
        </Button>
      </header>
      {!data.items.length && !data.projects.length ? <Empty title="Nothing open.">Tell Ava about what you're working on in Talk, or add something here.</Empty> : null}
      <div className="tasks-grid">
        <div className="tasks-main">
          <Group title="Almost there" note="One step from done. Finishing these matters most." items={almost} />
          <Group title="In progress" items={started} />
          <Group title="Not started" items={todo} />
          <Group title="People waiting on you" items={people} />
          <Group title="Done in the last three days" items={data.done} />
        </div>
        <aside className="tasks-side">
          <section className="group" aria-label="Projects">
            <header className="group-head">
              <h2 className="section-title">Projects</h2>
            </header>
            <ul className="projects">
              {data.projects.map((p) => (
                <li key={p.id} className="proj" data-important={p.important || undefined} data-status={p.status}>
                  <div className="proj-top">
                    <span className="proj-title">{p.title}</span>
                    <span className="proj-status">{p.status_label}</span>
                  </div>
                  <div className="proj-stale" aria-label={`Last touched ${p.days_since_touched} days ago`}>
                    <span className="proj-stale-bar" style={{ width: `${Math.max(2, (p.days_since_touched / maxStale) * 100)}%` }} />
                    <span className="num proj-stale-label">{p.days_since_touched === 0 ? "Touched today" : `${p.days_since_touched} d since touched`}</span>
                  </div>
                  {p.next_step ? <p className="proj-next voice-sm">{p.next_step}</p> : null}
                </li>
              ))}
            </ul>
          </section>
          {data.saved.length ? (
            <section className="group" aria-label="Saved for later">
              <header className="group-head">
                <h2 className="section-title">Saved for later</h2>
                <span className="num group-count">{data.saved.length}</span>
              </header>
              <ul className="saved">
                {data.saved.slice(0, 12).map((s) => (
                  <li key={s.id}>
                    {s.url ? (
                      <a href={s.url} target="_blank" rel="noreferrer">
                        {s.title}
                      </a>
                    ) : (
                      s.title
                    )}
                    <span className="saved-platform">{s.platform}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </aside>
      </div>
      <Sheet open={adding} onClose={() => setAdding(false)} title="Add something">
        <AddItem projects={data.projects} onClose={() => setAdding(false)} />
      </Sheet>
    </div>
  );
}
