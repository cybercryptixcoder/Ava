import type { HydratedModule } from "@ava/shared";
import { api } from "../lib/api";
import { isHidden, useRevealVersion } from "../lib/reveal";
import { DayTimeline } from "./DayTimeline";
import { ModuleBody } from "./modules";

/** How much of the canvas grid a module takes, by type. */
export function spanOf(m: HydratedModule): "narrow" | "half" | "wide" {
  switch (m.type) {
    case "day_timeline":
    case "rule_card":
    case "note":
      return "narrow";
    case "week_view":
    case "comparison_table":
    case "rhythm_view":
    case "chart":
    case "artifact_preview":
      return "wide";
    default:
      return "half";
  }
}

export function ModuleView({ m, conversationId, onDismiss, compactTimeline }: { m: HydratedModule; conversationId: string | null; onDismiss?: (key: string) => void; compactTimeline?: boolean }) {
  useRevealVersion();
  const onEvent = (kind: string, detail: Record<string, unknown>) => {
    if (conversationId) void api.post(`/api/canvas/${m.key}/event`, { conversation_id: conversationId, kind, detail }).catch(() => {});
  };
  const hidden = isHidden(m.key);
  return (
    <section className="mod" data-type={m.type} data-span={spanOf(m)} data-hidden={hidden || undefined} aria-label={m.title} id={`mod-${m.key}`}>
      <header className="mod-head">
        <h3 className="mod-title">{m.title}</h3>
        {onDismiss ? (
          <button type="button" className="mod-dismiss" onClick={() => onDismiss(m.key)} aria-label={`Take ${m.title} off the canvas`}>
            Dismiss
          </button>
        ) : null}
      </header>
      <div className="mod-body">
        {m.data.type === "day_timeline" ? (
          <DayTimeline data={m.data} moduleKey={m.key} compact={compactTimeline ?? true} />
        ) : (
          <ModuleBody m={m} ctx={{ conversationId, moduleKey: m.key, onEvent }} />
        )}
      </div>
    </section>
  );
}
