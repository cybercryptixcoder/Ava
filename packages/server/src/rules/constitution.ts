import { DynamicRuleDefinitionSchema, type DynamicRuleDefinition } from "@ava/shared";

/**
 * The fixed constitution. Nothing in the running system can change these.
 * Each article names the code that enforces it, so the Rules screen can
 * show Shreyas exactly where the guarantee lives.
 */
export const CONSTITUTION = [
  {
    id: "const.evidence",
    name: "Rule plus evidence",
    text: "No unprompted message without an approved rule and at least one real cited item. Every cited id must exist and every fact in the because line must come from stored state.",
    enforced_by: "validator/message-validator.ts",
  },
  {
    id: "const.no_mind_reading",
    name: "No invented states of mind",
    text: "Ava never claims you feel or seem anything that can't be traced to evidence.",
    enforced_by: "validator/message-validator.ts (STATE_OF_MIND)",
  },
  {
    id: "const.caps",
    name: "Hard caps and quiet hours",
    text: "A morning brief plus at most the daily cap of unprompted messages. Nothing in quiet hours. Nothing during class or exam blocks.",
    enforced_by: "wake/dispatcher.ts",
  },
  {
    id: "const.dynamic_limits",
    name: "Limits on Ava's own rules",
    text: "Dynamic rules can never raise caps, change quiet hours, edit the constitution, approve themselves, take external actions, or schedule wakes beyond the daily wake budget.",
    enforced_by: "rules/constitution.ts, rules/store.ts, scheduler/scheduler.ts",
  },
  {
    id: "const.confirm_external",
    name: "Confirm every external action",
    text: "Sending, submitting or spending anything needs your explicit confirmation each time, showing exactly what goes where.",
    enforced_by: "actions/external.ts",
  },
  {
    id: "const.expiry",
    name: "Every dynamic rule expires",
    text: "Every dynamic rule has an expiry and an on/off switch you can see.",
    enforced_by: "rules/store.ts",
  },
  {
    id: "const.system_owned",
    name: "System-owned safety",
    text: "The heartbeat and the dead-man's switch belong to the system. Ava can't cancel them.",
    enforced_by: "scheduler/scheduler.ts, scheduler/deadman.ts",
  },
  {
    id: "const.model_budget",
    name: "Daily model budget",
    text: "Model calls have their own daily budget, separate from the message cap.",
    enforced_by: "models/gateway.ts",
  },
  {
    id: "const.logging",
    name: "Everything is logged",
    text: "Every wake, rule evaluation, model call, validator decision, message and response is logged and readable.",
    enforced_by: "core/log.ts",
  },
] as const;

/** Words that would let a rule's text smuggle in an external action or a constitutional change. */
const FORBIDDEN_INTENT =
  /\b(send|sends|sending|email them|e-mail|submit|tweet|pay|purchase|buy|spend money|transfer money|text (him|her|them)|message (him|her|them) directly|quiet hours|message caps?|daily cap|constitution|approve (itself|rules?)|wake budget)\b/i;

export interface GuardResult {
  ok: boolean;
  errors: string[];
  definition: DynamicRuleDefinition | null;
}

/**
 * Validate a dynamic rule definition against the schema and the
 * constitution. The DSL has no vocabulary for caps, quiet hours, approval or
 * external actions, so most limits hold structurally; this adds the textual
 * and numeric checks.
 */
export function guardDynamicRule(input: unknown): GuardResult {
  const parsed = DynamicRuleDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`), definition: null };
  }
  const def = parsed.data;
  const errors: string[] = [];
  const text = def.action.kind === "suggest" ? def.action.intent : def.action.kind === "prepare" ? def.action.instructions : def.action.reason;
  if (FORBIDDEN_INTENT.test(text)) errors.push(`The rule's action text "${text}" refers to an external action or a constitutional setting, which dynamic rules can't do`);
  if (def.action.kind === "suggest") {
    for (const o of def.action.options ?? []) if (FORBIDDEN_INTENT.test(o)) errors.push(`Option "${o}" refers to an external action`);
  }
  if (def.cooldown_hours !== undefined && def.cooldown_hours < 2 && def.action.kind === "suggest") errors.push("A messaging rule needs a cooldown of at least 2 hours");
  return { ok: errors.length === 0, errors, definition: errors.length ? null : def };
}
