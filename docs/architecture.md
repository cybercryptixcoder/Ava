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

**Changes are proposals first.** Extraction (from conversation, imports, Gmail, Wispr notes) produces `Change` objects (`packages/shared/src/changes.ts`) that become confirmation chips (`state/proposals.ts`). Accepting applies the change through the same store; rejecting leaves nothing behind but the record.

**Active sensing.** When an unknown matters (does this project still matter?), the planner can queue one question (`state/questions.ts`). It appears in the morning brief and on Today, and the answer becomes a belief or a change.

**Rhythms** (`state/rhythms.ts`) are computed once a day from activity sessions and calendar history (when you tend to study, work, be on the laptop) and proposed as observed beliefs with their numbers attached.

## When Ava wakes

The scheduler (`scheduler/scheduler.ts`) is the only thing that runs code on a timer. Wake kinds:

- **System-anchored**: heartbeat every 3 hours in waking hours, the morning brief (08:30), the evening plan (21:30), the weekly review (Sunday). They are anchored to local times and belong to the system: neither Ava nor a rule can cancel them.
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

The **morning brief** (`planner/brief.ts`) gathers the day: calendar, deadlines, planned check-ins, messages queued overnight, rule proposals and the question. It produces a short spoken version (under a minute) and screen modules, and is pre-rendered to audio when a voice is configured.

## Executors

`executors/executors.ts`. Accepting an option such as "make me a practice set" or "draft the reply" starts an executor task. Each session is a fresh model call with only the task spec and the item's context (never the planner's reasoning), producing an artifact (practice set, summary, draft, outline, plan) and a report: what was produced, whether the plan still fits, whether another bounded session is needed. Multi-session tasks request their next session through the scheduler. Executors never send anything. Sending a draft goes through `actions/external.ts`: you see exactly what will be sent and to whom, can edit it, and confirm each time; the server sends only the text you confirmed.

## Conversation and the canvas

`conversation/conversation.ts`, `canvas/`.

An async turn: your words are stored as evidence; a fast extraction call turns them into confirmation chips; then the conversation model streams a reply. The reply interleaves words with canvas directives:

- `<show>{module spec}</show>`, `<update key="…">{patch}</update>`, `<remove key="…"/>`
- `<propose>[changes]</propose>` for chips Ava wants confirmed
- `<style_note>…</style_note>` when you react to how she talks
- cue tokens such as `[[plan]]` or `[[opts.o2]]` in the spoken text, marking the moment a module or one of its parts should appear

Module specs are validated against a typed vocabulary (`packages/shared/src/canvas.ts`: day timeline, week view, task list, options, deadline horizon, project card, artifact preview, comparison table, rule card, belief card, confirmation chips, note, rhythm view, chart). The server hydrates references (item ids, rule ids, artifact ids) from real state before anything renders; a spec that fails is dropped and logged. Ava knows what is on the canvas: each turn includes a summary of the modules, she can fetch a module's full state with a tool, and your interactions with modules (choosing an option, checking something off) come back to her as events.

**How Ava talks** lives in `personality/`: `voice.md` (who she is), `spoken.md` and `operational.md` (style for speech and for messages), `examples.md`. Length scales with what you said. She is never told to encourage; instead an affirmation budget is enforced after the fact (`conversation/affirmation.ts`): at most one affirmation per ten replies, none in operational messages unless acknowledging a real completion. Over budget, the sentence is trimmed (also from the stored raw reply) or, if nothing would be left, the reply is regenerated without it. Style notes you give are stored and included in every later turn.

## Voice

`voice/`. Speech adaptation (`packages/shared/src/speech.ts`, `voice/speech-adapt.ts`) turns written text into speakable text (clock times, abbreviations, your pronunciations) while keeping cue offsets, then maps word timings back to cues so the app reveals canvas parts as the words are spoken. ElevenLabs returns character alignment (converted to words); Cartesia returns word timestamps; if a model returns none, forced alignment is used.

**Live mode** (`voice/live.ts`) runs over one WebSocket: 16 kHz microphone audio up, 24 kHz speech down. Streaming recognition (Deepgram Flux or AssemblyAI) provides semantic end-of-turn with thresholds set by your patience setting; on top of that `voice/turn-detector.ts` holds the turn open when the last words sound unfinished ("…and", "so the") and joins whatever you say next. An early end-of-turn signal starts the model speculatively. Sentences stream into text-to-speech as they complete. Speaking over Ava stops her within a frame or two (the browser stops playback locally and the server cancels generation). Every turn records its stages (end-of-turn detection, model first token, first sentence, first audio, playback) in `latency_samples`.

## Sources

`sources/`. Each source implements one plugin interface (`sources/types.ts`): configured, connected, needs, poll, stats, delete-my-data, on/off. Google Calendar (OAuth, change notifications when `PUBLIC_URL` is https), ICS feeds, manual entry, chat history import, Gmail (sent mail only), saved items, Wispr Flow (official MCP server with OAuth) and laptop activity. High-volume sources are compressed in stages: activity is merged into sessions on the laptop, labeled in batches on the server, summarized into rhythms, and only then proposed as beliefs; raw titles are deleted on a schedule.

## Reaching you

`channels/hub.ts`. Every message is a row in `messages` and appears in the app at once (server-sent events). Web push delivers it to installed devices with up to two action buttons; the service worker (`packages/web/public/sw.js`) posts responses straight back. The channel interface is small so another channel (SMS, a chat app) can be added beside web push.

Message anatomy: a first line that is the point; a because line built only from cited facts; 2 to 4 options that start the work; and four one-tap responses (do it, not now, already done, less of this) that feed the rule's statistics.

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

`packages/web`. React with a small fetch-and-cache store, live updates over server-sent events, a service worker for push and an offline shell. Screens: Today (the day as a vertical dial with your calendar, Ava's plan and check-ins, and what's waiting for you), Talk (conversation and canvas), Tasks and projects, Rules, What Ava knows, Messages, Log, Settings, and the first-run setup. The look is set out in [design-plan.md](design-plan.md).

## Data

One SQLite file per profile (`data/real/ava.db`, `data/test/ava.db`) with forward-only migrations (`db/schema.ts`). Main tables: `items`, `item_history`, `evidence`, `beliefs`, `proposals`, `rules`, `rule_firings`, `cooldowns`, `wakes`, `messages`, `log`, `model_calls`, `plans`, `plan_blocks`, `questions`, `briefs`, `turns`, `canvas_modules`, `exec_tasks`, `artifacts`, `external_actions`, `sources`, `activity_sessions`, `snapshots`, `audio_files`, `latency_samples`.
