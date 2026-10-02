import { z } from "zod";
import { ItemDraftSchema, ItemPatchSchema, ProvenanceSchema } from "./items";

/**
 * A structured change to the life model. Anything Ava extracts from speech,
 * imports or email becomes one of these, shown as a confirmation chip before
 * it is applied. Checking something off in the interface applies immediately.
 */
export const ChangeSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("create_item"),
    item: ItemDraftSchema,
    /** Title of an existing or co-proposed project to link to. */
    project_title: z.string().optional(),
  }),
  z.object({ op: z.literal("update_item"), item_id: z.string(), patch: ItemPatchSchema }),
  z.object({ op: z.literal("set_status"), item_id: z.string(), status: z.string() }),
  z.object({ op: z.literal("complete_item"), item_id: z.string() }),
  z.object({
    op: z.literal("reschedule"),
    item_id: z.string(),
    due_at: z.string().nullable().optional(),
    start_at: z.string().nullable().optional(),
    end_at: z.string().nullable().optional(),
  }),
  z.object({
    op: z.literal("add_belief"),
    belief: z.object({
      area: z.string(),
      statement: z.string().min(3).max(400),
      provenance: ProvenanceSchema,
      confidence: z.number().min(0).max(1),
      subject_item_id: z.string().nullable().optional(),
    }),
  }),
  z.object({
    op: z.literal("update_belief"),
    belief_id: z.string(),
    statement: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
    status: z.enum(["active", "retired"]).optional(),
  }),
  z.object({ op: z.literal("answer_question"), question_id: z.string(), answer: z.string() }),
]);
export type Change = z.infer<typeof ChangeSchema>;

export const ProposalSchema = z.object({
  id: z.string(),
  batch_id: z.string(),
  origin: z.string(),
  change: ChangeSchema,
  summary: z.string(),
  reason: z.string().nullable(),
  status: z.enum(["pending", "accepted", "rejected", "superseded"]),
  weight: z.number().nullable(),
  evidence_id: z.string().nullable(),
  created_at: z.string(),
  resolved_at: z.string().nullable(),
});
export type Proposal = z.infer<typeof ProposalSchema>;

/** The four one-tap responses to every proactive message. */
export const ResponseKindSchema = z.enum(["do_it", "not_now", "already_done", "less_of_this"]);
export type ResponseKind = z.infer<typeof ResponseKindSchema>;

export const RESPONSE_LABELS: Record<ResponseKind, string> = {
  do_it: "Do it",
  not_now: "Not now",
  already_done: "Already done",
  less_of_this: "Less of this",
};
