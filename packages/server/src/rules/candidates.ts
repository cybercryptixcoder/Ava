import type { RuleAction } from "@ava/shared";

/**
 * A candidate is what deterministic rule evaluation produces: a reason to
 * maybe reach out, with the real items it is about and system-computed
 * facts the message may cite. The model never sees anything else.
 */
export interface Candidate {
  rule_id: string;
  rule_name: string;
  tier: "builtin" | "dynamic";
  action: RuleAction;
  item_ids: string[];
  /** System-computed facts, citable as {{fact:name}}. Values are display strings. */
  facts: Record<string, string>;
  /** What the message is for. */
  intent: string;
  suggested_options: SuggestedOption[];
  urgency: "now" | "today" | "brief";
  dedupe_key: string;
  cooldown_hours: number;
  category: string;
  priority: number;
}

export interface SuggestedOption {
  label: string;
  action:
    | { kind: "start_executor"; executor: "practice_set" | "summary" | "draft" | "outline" | "plan"; item_id?: string; instructions: string }
    | { kind: "snooze_item"; item_id: string; hours: number }
    | { kind: "propose_change"; change: Record<string, unknown>; summary: string }
    | { kind: "open"; screen: "today" | "tasks" | "rules" | "knows" | "messages" | "settings" }
    | { kind: "none" };
}
