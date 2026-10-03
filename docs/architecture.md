# How Ava works

Ava is one Node process (Fastify, SQLite through `node:sqlite`) and a progressive web app. This document follows the life of the system: what it knows, when it wakes, how it decides to speak, how work gets done, and how you talk to it. Paths are under `packages/server/src` unless noted.

## The division of labour

| The model does | The system does |
|---|---|
| Plans the evening and the week, proposes rules, asks one question | Owns the clock: every wake is created, validated and run by the scheduler |
| Ranks and words candidate messages | Decides, with deterministic rules, whether there is any reason to reach out |
| Extracts changes from what you say | Applies nothing until you confirm it |
| Does preparatory work in fresh executor sessions | Validates every message against stored state and enforces caps, quiet hours, class blocks and budgets |
| Talks to you | Logs every decision, model call and outcome |

Nothing runs continuously. Between wakes the server is idle apart from HTTP requests and source webhooks.

## What Ava knows

**Evidence and beliefs are separate.** Raw inputs (transcripts, calendar events, imported conversations, sent mail, activity sessions) are stored as evidence (`state/evidence.ts`), encrypted, with retention. What Ava believes is stored separately (`state/beliefs.ts`): each belief has provenance (stated by you, observed from data, inferred), a confidence that decays with a half-life unless you confirm it again, links to the evidence behind it, and when it was last confirmed. Inferred beliefs stay proposals until you confirm them.

**Items** (`state/items.ts`, schema in `packages/shared/src/items.ts`) are the structured life model: tasks, deadlines, projects, commitments to people, replies owed (open loops), goals, preferences, saved items, calendar events. Each type declares its statuses; type-specific fields live in a JSON `data` column, so new types don't need migrations. Every change is recorded in `item_history`. Checking something off is immediate and cancels the wakes about it.

**Changes are proposals first.** Extraction (from conversation, imports, Gmail, Wispr notes) produces `Change` objects (`packages/shared/src/changes.ts`). In a conversation they are filed directly, with per-item undo, and only genuinely ambiguous or consequential ones wait as cards; in review queues (chat-history imports, saved items) they become confirmation chips (`state/proposals.ts`). Accepting applies the change through the same store; rejecting leaves nothing behind but the record.

**Active sensing.** When an unknown matters (does this project still matter?), the planner can queue one question (`state/questions.ts`). It appears in the morning stack, and the answer becomes a belief or a change.

**Rhythms** (`state/rhythms.ts`) are computed once a day from activity sessions and calendar history (when you tend to study, work, be on the laptop) and proposed as observed beliefs with their numbers attached.

## Memory

The memory system (`state/memory.ts`, `memory/`) is the long-term half of "what Ava knows": one append-only raw log, derived layers built only from it, and a read path that assembles a small, grounded context for every call.

**L0 — the raw log.** Every turn of every conversation (async and live), every transcript, chat-import row, sent mail, item change, card response, question answer and artifact is appended to `entries` as it is: verbatim, encrypted, with both when it happened and when it was recorded. Appends are append-only — nothing is edited or deleted except through the forget flow — and everything else in the system is derived from these rows.

**L1 — episodes and gists.** A background processor (`memory/processor.ts`) covers new raw entries in coherent batches (a conversation session within a time gap; one standalone record otherwise): a cheap model writes a gist (1–3 sentences, keywords, entities, importance) and extracts atomic facts from Shreyas's own words. Episodes join a recent same-session episode when the batch continues it; joins mark the gist stale, and consolidation regenerates stale gists from the raw entries. Facts are add-only rows linked to the raw ids they came from.

**L2 — temporal facts.** Facts get a `valid_from`; when a new fact contradicts a current one, a cheap-model judge (`memory/contradict.ts`) decides and the old fact's `valid_to` is set with a `superseded_by` link — replaced, never overwritten; the change stays visible as history and is logged with its reason.

**L3 — the core.** A small, versioned block of durable knowledge (who he is, standing preferences, active threads and their state), rebuilt from L2, threads and recent gists, read as the cache breakpoint of the conversation prompt. The conversation model never edits it.

**The read path** (`memory/retriever.ts`). For every message, unless the fast path skips it: keyword search over an in-memory FTS index built from decrypted rows (`memory/search.ts`) plus semantic neighbors from embeddings (`memory/embeddings.ts`; the local MiniLM model by default, so nothing leaves the server, with an optional hosted endpoint via `EMBEDDINGS_URL` and a deterministic lexical fallback for CI), ranked by relevance, recency and importance into a context pack — gists, facts and verbatim excerpts with their ref ids — under a token budget, optionally routed by a cheap-model sub-agent. Conversation calls are assembled most-stable-first: system instructions, the core (the prompt-cache breakpoint), then the pack, the recent window (last turns verbatim, capped by count and tokens) and the new message. The prompt's grounding rule: past facts only as they appear in the pack; say plainly you don't remember when it's empty. Every reply records which refs it drew on and its per-segment token counts.

**Consolidation** (the nightly system wake, `memory/consolidate.ts`) is the only place derived layers get revised: stale gists regenerate from raw (episodes whose raw content is entirely forgotten are removed with it), the core is rebuilt when something new landed, near-duplicate current facts are linked to a canonical row (never deleted), importance is recomputed deterministically, reflections enter the inferred-belief flow only when they cite at least three raw entries, and the graded evaluation runs — all bounded by a per-run model-call budget and recorded for the developer panel.

**Forgetting** (`memory/forget.ts`) is the only deletion path. Raw entries become content-free tombstones; index text, vectors, derived facts that lose their last raw source, affected gists and the core all follow — immediately, not at night. Every deletion runs through a preview of exactly what it would remove, from the Memory screen or by voice ("forget what I said about X" → a confirmation card; nothing deletes until it's answered).

**Evaluation.** Deterministic checks in CI (a planted fact must reach the pack; every ref in a pack must exist in the database) plus a graded three-scenario suite — direct recall, honest abstention, a visible change — run nightly with consolidation and on demand (`npm run memory:eval`); results show over time in the developer panel.

## When Ava wakes

The scheduler (`scheduler/scheduler.ts`) is the only thing that runs code on a timer. Wake kinds:

- **System-anchored**: heartbeat every 3 hours in waking hours, the morning brief (08:30), the evening plan (21:30), the weekly review (Sunday), and nightly memory consolidation (03:00). They are anchored to local times and belong to the system: neither Ava nor a rule can cancel them.
- **Deadline wakes**: 14, 3 and 1 days before each deadline, at a set local time; wakes at the same moment are merged.
- **Lookahead wakes**: each heartbeat looks at the next few hours and schedules precise wakes for good moments (5 minutes after class ends, shortly before a free block), so nothing important falls between heartbeats.
- **Event wakes**: a change you make (or a calendar push) coalesces into one wake a minute later.
- **Ava-requested wakes** (planner, rule and executor kinds): returned by the model as data and validated by `Scheduler.request`: not in the past, not beyond the horizon, not in quiet hours (except executor sessions), within the per-kind and total daily budgets, merged with a nearby request instead of duplicated. Rejections are logged with their reason.

Switching location (State College / Bangalore) recomputes every schedule in the new time zone; wakes Ava requested for a local time keep that local time.

A **dead-man's switch** (`scheduler/deadman.ts`) raises an alert if no wake has succeeded for 6 waking hours, and an optional external URL is pinged after each successful wake so you hear about it even if the server is down.

On the test profile the clock is a `SimClock` (`core/clock.ts`); `Scheduler.advanceTo` runs every wake that comes due, in order, at its own simulated time. That is what Settings, Developer, Time simulation drives.

## The wake procedure

`wake/procedure.ts`, for heartbeats, deadline, lookahead, event, planner and rule wakes:

1. **Pull.** Heartbeats poll sources that can't push.
2. **Update state.** Expire rules whose time or condition has come; recompute rhythms once a day.
3. **Evaluate rules** (`rules/engine.ts`) against a snapshot of the world (`rules/world.ts`). Each firing is a *candidate*: the rule, the real items it is about, system-computed facts it may cite, suggested options, urgency, a dedupe key and a cooldown. Candidates in cooldown or about a snoozed item are held back and logged. The snapshot is stored (compressed) so rules can be replayed later.
4. **Internal actions** need no model: `prepare` rules start a silent executor session through the scheduler's budget; `wake` rules request a wake.
5. **Rank and draft.** One small model call ranks the candidates and drafts at most a couple of messages (`wake/drafter.ts`). Facts must be placeholders: `{{item:<id>.due}}`, `{{fact:days_left}}`. Without a model key or over budget, a deterministic template drafts instead, and the message records that.
6. **Validate** (`validator/message-validator.ts`). Placeholders are rendered from stored state; any digit, date, weekday or status word written outside a placeholder fails; cited items must exist and be among the rule's findings; no claimed states of mind; no praise; 2 to 4 options with valid actions; not a repeat within the cooldown; the rule must be approved and active. A failing message never goes out; the reasons are logged.
7. **Dispatch** (`wake/dispatcher.ts`). Quiet hours, or before today's brief: queue for the brief. During a class or exam: urgent messages wait for a lookahead wake just after it, others queue. Past the daily cap (3 besides the brief): queue. At most one message per wake, so nudges never arrive in a burst. Time-bound suggestions that can't go out now are dropped rather than delivered stale tomorrow.
8. **Record** the firing outcome, store the snapshot, and log the wake's summary.

Every step writes to the decision log (`core/log.ts`), grouped by wake on the Log screen.

## Rules

**The constitution** (`rules/constitution.ts`) is fixed and enforced in code: rule plus evidence for every message; no invented states of mind; caps and quiet hours; limits on Ava's own rules; confirmation of every external action; expiries and switches; system-owned heartbeat and dead-man's switch; the daily model budget; everything logged. The Rules screen shows each article with the file that enforces it.

**Built-in rules** (`rules/builtin.ts`): deadline horizon, free block, finish line (drafted or almost done for two days), stale project (important and untouched for a week), follow-up (overdue commitment or reply owed).

**Dynamic rules** (`rules/dynamic.ts`, DSL in `packages/shared/src/rules.ts`) are written by the planner as structured data: a `when` condition over `now.*`, `location.*`, `calendar.*`, `activity.*` and `counts.*` fields, an optional `for_each` over item types with a `where`, an action (`suggest`, `prepare` or `wake`), a cooldown and an expiry. A guard rejects anything outside the vocabulary and any action text about sending, spending, caps or quiet hours. New proposals are capped per week and active rules overall.

**Approval.** Rules that message you need your yes; internal rules (prepare, wake) auto-approve within budget. Before you decide, **shadow mode** replays the stored world snapshots of the last few days and shows what the rule would have done (messaged, queued, blocked by quiet hours or class, held by the cap).

**Live statistics.** Each response (do it, not now, already done, less of this, or none) is counted. "Acted" means you chose do it or the cited item advanced within a day. A rule whose precision falls below 0.4 after at least 5 messages pauses itself and comes back in the weekly review with a revision. "Less of this" cools the rule's category for a few days.

## Planning

`planner/planner.ts`. The evening plan, the weekly review and focused sessions for something genuinely new (a new project) are the only places the large model plans. It sees the life model, the week's calendar, rhythms, rule statistics, recent messages and responses, and executor reports, and returns data: planned blocks, wake requests, rule proposals, at most one question, belief proposals and notes for the brief. Everything is validated before it takes effect. The planner never grades its own plans: executor sessions report whether the plan still fit reality, and those reports feed the next plan.

The **morning stack** (`planner/brief.ts`) is composed at the brief time: stale queued messages are dropped, the rest become cards visible now, the open question and the occasional rule or belief card are added, and a few spoken sentences are pre-rendered to audio when a voice is configured.

## Executors

`executors/executors.ts`. Accepting an option such as "make me a practice set" or "draft the reply" starts an executor task. Each session is a fresh model call with only the task spec and the item's context (never the planner's reasoning), producing an artifact (practice set, summary, draft, outline, plan) and a report: what was produced, whether the plan still fits, whether another bounded session is needed. Multi-session tasks request their next session through the scheduler. Executors never send anything. Sending a draft goes through `actions/external.ts`: you see exactly what will be sent and to whom, can edit it, and confirm each time; the server sends only the text you confirmed.

## Conversation

`conversation/conversation.ts`. An async turn: your words are appended to the raw log (and referenced as evidence); a fast extraction call turns them into changes, which are filed directly with per-item undo (anything ambiguous or consequential becomes a card instead); then the conversation model streams a short reply that shows briefly on the main page and lives in the transcript sheet. Each turn is assembled from the core, a freshly retrieved context pack and the recent window ([Memory](#memory) above); replies ground on what the pack contains and record the refs they used. The reply protocol (`conversation/protocol.ts`) allows `<propose>` for changes Ava wants confirmed and `<style_note>` when you react to how she talks; results otherwise show up as changes to the stack, not as a canvas of modules.

The canvas module machinery (`canvas/`, `packages/shared/src/canvas.ts`) remains in the codebase — module specs validated against the typed vocabulary and hydrated from real state — but the main page no longer renders modules.

**How Ava talks** lives in `personality/`: `voice.md` (who she is), `spoken.md` and `operational.md` (style for speech and for messages), `examples.md`. Length scales with what you said. She is never told to encourage; instead an affirmation budget is enforced after the fact (`conversation/affirmation.ts`): at most one affirmation per ten replies, none in operational messages unless acknowledging a real completion. Over budget, the sentence is trimmed (also from the stored raw reply) or, if nothing would be left, the reply is regenerated without it. Style notes you give are stored and included in every later turn.

## Voice

`voice/`. Speech adaptation (`packages/shared/src/speech.ts`, `voice/speech-adapt.ts`) turns written text into speakable text (clock times, abbreviations, your pronunciations) while keeping cue offsets, then maps word timings back to cues so playback can follow the words. ElevenLabs returns character alignment (converted to words); Cartesia returns word timestamps; if a model returns none, forced alignment is used.

**Live mode** (`voice/live.ts`) runs over one WebSocket: 16 kHz microphone audio up, 24 kHz speech down. Streaming recognition (Deepgram Flux or AssemblyAI) provides semantic end-of-turn with thresholds set by your patience setting; on top of that `voice/turn-detector.ts` holds the turn open when the last words sound unfinished ("…and", "so the") and joins whatever you say next. An early end-of-turn signal starts the model speculatively, and retrieval for the reply starts speculatively on the partial transcript; at assembly time it gets a small grace window (`memory.live_grace_ms`) and falls back to the core plus the recent window when it isn't ready, so live replies never wait on memory. Sentences stream into text-to-speech as they complete. Speaking over Ava stops her within a frame or two (the browser stops playback locally and the server cancels generation). Every turn records its stages (end-of-turn detection, retrieval, model first token, first sentence, first audio, playback) in `latency_samples`.

## Sources

`sources/`. Each source implements one plugin interface (`sources/types.ts`): configured, connected, needs, poll, stats, delete-my-data, on/off. Google Calendar (OAuth, change notifications when `PUBLIC_URL` is https), ICS feeds, manual entry, chat history import, Gmail (sent mail only), saved items, Wispr Flow (official MCP server with OAuth) and laptop activity. High-volume sources are compressed in stages: activity is merged into sessions on the laptop, labeled in batches on the server, summarized into rhythms, and only then proposed as beliefs; raw titles are deleted on a schedule.

## Reaching you

`channels/hub.ts`. Every proactive message is a row in `messages`; a message that passes the validator becomes a card in the stack rather than a separate object in the app. Web push is used only for time-sensitive cards, capped per day, and carries just the card's one line with "yes" and "not now" where the platform shows actions; the service worker (`packages/web/public/sw.js`) posts responses straight back and opens the card on tap (`/?card=<id>`). The channel interface is small so another channel (SMS, a chat app) can be added beside web push.

Card anatomy follows the old message anatomy: a first line that is the point; a why line built only from cited facts; 2 to 4 options that start the work; and responses (yes, not now, already done, stop suggesting this) that feed the rule's statistics.

## Models and budgets

`models/gateway.ts` is the only path to the model. It checks the daily budgets (calls Ava starts, calls you start, total spend), records every call (purpose, model, latency, tokens, cost) with inputs and outputs encrypted, applies prompt caching (stable instructions first, conversation prefixes cached), uses structured outputs for every JSON-returning call, streams conversation and live replies, and opts in to server-side refusal fallbacks. The provider behind it is swappable: tests use a scripted provider that answers by call purpose.

## Security and privacy

- Single user. Password (scrypt hash) and signed, http-only session cookies stored server side; `Secure` when served over https; sign-in rate limited. Without a password set, only requests from the same machine are answered, and production refuses to start.
- Secrets only from environment variables.
- Field-level AES-256-GCM encryption for sensitive data (evidence, transcripts, model inputs and outputs, OAuth tokens, window titles); audio files are encrypted whole. Structured items stay queryable in plaintext.
- Retention deletes raw high-volume data on a schedule once distilled.
- Data about other people is processed only to extract your own commitments.
- Export everything as one decrypted JSON file; delete per source.

## The web app

`packages/web`. React with a small fetch-and-cache store, live updates over server-sent events, a service worker for push and an offline shell. The front room is the **stack** (`/`): one card fully visible with one or two peeking behind, swipe or the two desktop buttons to respond, tap (or Enter) for the next layer (`components/Stack.tsx`, `components/CardLayer.tsx`), a bottom bar with a prominent mic for voice notes and live mode folded in (`components/InputBar.tsx`), and the transcript as a pull-up sheet. **Calendar** (a day dial and week view of his events plus Ava's planned check-ins) and **Everything** (the full thread hierarchy, collapsed) sit one tap away; the back room — Tasks and projects, Rules, What Ava knows, Messages, Log, Settings — lives behind one menu. New cards arrive live, and a push deep link opens its card. The look is set out in [design-plan.md](design-plan.md).

## Data

One SQLite file per profile (`data/real/ava.db`, `data/test/ava.db`) with forward-only migrations (`db/schema.ts`). Main tables: `items`, `item_history`, `evidence`, `beliefs`, `proposals`, `rules`, `rule_firings`, `cooldowns`, `wakes`, `messages`, `log`, `model_calls`, `plans`, `plan_blocks`, `questions`, `briefs`, `canvas_modules`, `exec_tasks`, `artifacts`, `external_actions`, `sources`, `activity_sessions`, `snapshots`, `audio_files`, `latency_samples`. The memory system adds `entries` (the raw log; it replaced the old `turns` table), `entry_links`, `episodes`, `episode_entries`, `facts`, `fact_entries`, `cores`, `memory_embeddings`, `memory_state`, and `memory_eval_runs`.
