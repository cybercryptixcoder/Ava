import { evaluateCondition, type DynamicRuleDefinition } from "@ava/shared";
import type { Settings } from "../config/settings";
import type { Candidate } from "./candidates";
import { itemMetrics, makeResolver, type WorldItem, type WorldState } from "./world";

/**
 * Evaluate one dynamic rule deterministically against a world snapshot.
 * A rule without for_each fires once (citing nothing yet); messaging rules
 * must cite items, so those are dropped later by the validator if empty.
 */
export function evaluateDynamicRule(
  rule: { id: string; name: string },
  def: DynamicRuleDefinition,
  w: WorldState,
  s: Settings,
): Candidate[] {
  const ctx = makeResolver(w);
  if (def.when && !evaluateCondition(def.when, ctx)) return [];

  let matched: WorldItem[] = [];
  if (def.for_each) {
    const types = Array.isArray(def.for_each.type) ? def.for_each.type : [def.for_each.type];
    matched = w.items.filter((i) => types.includes(i.type));
    if (def.for_each.where) matched = matched.filter((i) => evaluateCondition(def.for_each!.where!, makeResolver(w, i)));
    if (!matched.length) return [];
    const now = new Date(w.at);
    matched.sort((a, b) => {
      const ha = itemMetrics(a, now, w.tz).hours_until_due ?? 1e9;
      const hb = itemMetrics(b, now, w.tz).hours_until_due ?? 1e9;
      return ha - hb;
    });
    matched = matched.slice(0, def.limit ?? 3);
  }

  const cooldown = def.cooldown_hours ?? s.rules.default_cooldown_hours;
  const category = def.category ?? "dynamic";
  const base = {
    rule_id: rule.id,
    rule_name: rule.name,
    tier: "dynamic" as const,
    action: def.action,
    cooldown_hours: cooldown,
    category,
    priority: 50,
  };

  if (def.action.kind === "suggest") {
    const ids = matched.map((m) => m.id);
    return [
      {
        ...base,
        item_ids: ids,
        facts: {},
        intent: def.action.intent,
        suggested_options: (def.action.options ?? []).map((label) => ({ label, action: { kind: "none" as const } })),
        urgency: "today",
        dedupe_key: `${rule.id}:${ids.join(",")}`,
      },
    ];
  }
  if (def.action.kind === "prepare") {
    // One preparation per matched item (or one overall).
    const targets = matched.length ? matched : [null];
    return targets.map((m) => ({
      ...base,
      item_ids: m ? [m.id] : [],
      facts: {},
      intent: def.action.kind === "prepare" ? def.action.instructions : "",
      suggested_options: [],
      urgency: "brief" as const,
      dedupe_key: `${rule.id}:${m?.id ?? "all"}`,
    }));
  }
  // wake
  const ids = matched.map((m) => m.id);
  return [
    {
      ...base,
      item_ids: ids,
      facts: {},
      intent: def.action.reason,
      suggested_options: [],
      urgency: "brief",
      dedupe_key: `${rule.id}:wake:${ids.join(",")}`,
    },
  ];
}
