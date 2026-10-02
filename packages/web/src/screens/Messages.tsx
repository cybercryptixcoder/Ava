import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { MessageView } from "@ava/shared";
import { useApi } from "../lib/store";
import { dayLabel } from "../lib/time";
import { Empty, ErrorLine, Segmented } from "../components/ui";
import { MessageCard } from "../components/MessageCard";

export function Messages() {
  const { data, error } = useApi<MessageView[]>("/api/messages?limit=300");
  const [filter, setFilter] = useState<"all" | "open" | "answered" | "held">("all");
  const [params] = useSearchParams();
  const focus = params.get("focus");
  useEffect(() => {
    if (focus) window.setTimeout(() => document.getElementById(`m-${focus}`)?.scrollIntoView({ block: "center" }), 100);
  }, [focus, data]);
  if (error) return <ErrorLine error={error} />;
  if (!data) return <div className="screen" aria-busy="true" />;
  const shown = data.filter((m) =>
    filter === "all" ? m.status !== "blocked" : filter === "open" ? !m.response && !m.acted && ["sent", "in_brief"].includes(m.status) : filter === "answered" ? !!m.response || !!m.acted : ["queued", "dropped"].includes(m.status),
  );
  const groups = new Map<string, MessageView[]>();
  for (const m of shown) {
    const k = dayLabel(m.sent_at ?? m.created_at);
    groups.set(k, [...(groups.get(k) ?? []), m]);
  }
  return (
    <div className="screen messages">
      <header className="screen-head">
        <h1 className="screen-title">Messages</h1>
        <Segmented
          label="Show"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "open", label: "Needs an answer" },
            { value: "answered", label: "Answered" },
            { value: "held", label: "Held back" },
          ]}
        />
      </header>
      {!shown.length ? <Empty title="No messages here.">Every message Ava sends you lands here with the rule that produced it and your response.</Empty> : null}
      {[...groups].map(([day, ms]) => (
        <section key={day} className="band" aria-label={day}>
          <h2 className="section-title">{day}</h2>
          <div className="msg-list">
            {ms.map((m) => (
              <div key={m.id} id={`m-${m.id}`} data-focus={focus === m.id || undefined}>
                <MessageCard m={m} />
                {m.status === "dropped" || m.status === "queued" ? <p className="msg-held">{m.status === "queued" ? "Why it waits" : "Why it wasn't sent"}: {m.block_reason}</p> : null}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
