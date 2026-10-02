import type { ThreadNode } from "@ava/shared";
import { useApi } from "../lib/store";
import { when } from "../lib/time";
import { ErrorLine } from "../components/ui";

const isDone = (status: string) => ["done", "dropped", "closed", "achieved"].includes(status);

/** The full hierarchy — threads, then items, then subtasks — collapsed by default. */
export function Everything() {
  const { data, error } = useApi<ThreadNode[]>("/api/threads");
  if (error) return <ErrorLine error={error} />;
  if (!data) return <div className="screen" aria-busy="true" />;
  return (
    <div className="screen everything">
      <header className="screen-head">
        <h1 className="screen-title">Everything</h1>
        <p className="screen-sub">Threads, then their items, then subtasks. Collapsed until you open one.</p>
      </header>
      {data.length === 0 ? (
        <p className="band-note">Nothing filed yet. What Ava learns goes here, grouped on its own.</p>
      ) : (
        <ul className="tree">
          {data.map((t) => (
            <ThreadBranch key={t.id} node={t} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ThreadBranch({ node }: { node: ThreadNode }) {
  return (
    <li className="th-node">
      <details>
        <summary className="th-sum">
          <span className="th-title">{node.title}</span>
          {node.open_count ? <span className="th-count num">{node.open_count} open</span> : null}
        </summary>
        <div className="th-body">
          {node.children.length ? (
            <ul className="tree th-children">
              {node.children.map((c) => (
                <ThreadBranch key={c.id} node={c} />
              ))}
            </ul>
          ) : null}
          <ul className="th-items">
            {node.items.map((i) => (
              <li key={i.id} className="th-item" data-done={isDone(i.status) || undefined}>
                <span className="th-item-title">{i.title}</span>
                <span className="th-item-meta">
                  <span>{i.status_label}</span>
                  {i.due_at ? <span className="num">{when(i.due_at)}</span> : null}
                </span>
                {i.subtasks.length ? (
                  <ul className="th-sub">
                    {i.subtasks.map((s) => (
                      <li key={s.id} data-done={isDone(s.status) || undefined}>
                        <span className="th-item-title">{s.title}</span>
                        <span className="th-item-meta">
                          <span>{s.status_label}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      </details>
    </li>
  );
}
