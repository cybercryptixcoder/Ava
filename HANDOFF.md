# Handoff

What was built, what was verified and how, what you need to do to switch each piece on, what couldn't be tested from here, the judgment calls I made, and what I'd do next.

## What's built

All of it is in this repository, with no placeholders in real code paths. Without keys, each feature that needs one is switched off and says so; nothing pretends.

- **Life model**: evidence kept apart from beliefs (provenance, confidence with decay, evidence links, last confirmed); typed items with history; every change proposed as a chip and applied only on confirmation; one question at a time when an unknown matters; rhythms from activity and calendar.
- **System-owned time**: the scheduler (heartbeat every 3 hours with lookahead wakes, the 08:30 brief, the 21:30 evening plan, the Sunday weekly review, deadline wakes at 14/3/1 days, event wakes, validated wake requests from the planner, rules and executors), time-zone switching between State College and Bangalore, a dead-man's switch, and time simulation on the test profile.
- **Rules**: the constitution enforced in code, five built-in rules, the dynamic rule DSL with guard, approval tiers, expiries, shadow mode over stored snapshots, live statistics, self-pausing at low precision, and weekly caps.
- **Messages**: candidates from rules, model ranking and drafting with placeholders (deterministic templates without a key), the validator, dispatch with caps, quiet hours, class blocks and the brief, the four responses, and web push.
- **Planning and execution**: the evening plan, weekly review and new-context sessions; fresh executor sessions producing practice sets, summaries, drafts, outlines and plans, with plan-fit reports and multi-session tasks; external actions only with explicit confirmation of exactly what goes where.
- **Conversation**: extraction to chips, a streaming reply with canvas directives, cue tokens that reveal modules as Ava speaks them, a typed module vocabulary validated and hydrated from real state, canvas state Ava can read, the affirmation budget, style notes, and the personality files with a six-case test set.
- **Voice**: ElevenLabs and Cartesia text-to-speech behind one adapter (expressive and low-latency models, the same voice in both), word timings with forced-alignment fallback, speech adaptation, Deepgram Flux and AssemblyAI streaming recognition with patience settings and an unfinished-thought grace window, live mode with speculative start, sentence streaming, barge-in and per-stage latency, the voice audition, uploaded audio transcription, and a latency benchmark.
- **Sources**: Google Calendar (OAuth, push notifications), ICS feeds, manual entry, ChatGPT and Claude export import with a date-weighted review queue, Gmail sent mail (off by default), Wispr Flow through its official MCP server (off by default), saved items from bookmarks and platform exports (off by default), and the laptop activity collector (off by default).
- **The app**: an installable PWA whose main page is the card stack (swipe or keyboard, layers that fetch lazily, a voice-note mic and live mode folded into the bottom bar, the transcript as a sheet), with Calendar and Everything a tap away and Tasks and projects, Rules, What Ava knows, Messages, Log and Settings behind one menu (sources, time and places, caps and budgets, voice audition, style notes, notifications, appearance, privacy, developer panel with latency, model usage, time simulation and personality test runs), plus first-run setup. Light and dark themes designed separately, automatic by local time with an override.
- **Security**: password login with signed server-side sessions, loopback-only access when no password is set, refusal to start in production without secrets, field-level encryption at rest, retention, export and per-source deletion.
- **Repository**: one-command start for development (`npm run dev`, `npm run dev:test`) and production (`npm start`, Docker Compose with a Cloudflare Tunnel), README, [architecture](docs/architecture.md), [design plan](docs/design-plan.md), screenshots, tests, fixtures kept apart in a test profile.

## What was verified, and how

- **83 unit and end-to-end tests** (`npm test`, Vitest, no network): rule evaluation, scheduler validation and budgets, time-zone switching, the message validator, caps, quiet hours and class blocks, cooldowns and snoozes, the affirmation budget, module schemas, speech adaptation, turn detection, chat and saved-item parsers, encryption, auth and access control, retention, the collector's merging, the test-profile seed, and the stack (threads and the grouping cap, filing with undo, card responses and returns, push caps, the morning stack, the rule-approval and belief cadences, the calendar endpoint). Four end-to-end flows run through the real gateway, validator, scheduler and database with a scripted model provider: brain dump to confirmed items (with the deadline wakes that follow), wake to validated message (and a draft that invents facts being stopped), accepted suggestion to executor artifact with a plan-fit report, and rule proposal to shadow run to approval.
- **12 Playwright UI tests** (`npm run test:e2e`) on desktop and phone against the production build: the stack renders from real state; arrow keys and a touch drag move the deck and nothing is deleted; a card opens its second layer and a filing is undone; the back-room menu, the location switch and checking a task off work; no console errors; and no screen overflows sideways at 320 px.
- **The test profile runs a real morning**: seeding runs 07:55 to 11:52 on the simulated clock with the deterministic drafter; wakes fire, rules evaluate, the validator decides, two messages wait for the brief, one message goes out per wake, the cap holds at three. Advancing a day from Settings runs the brief, evening plan and heartbeats.
- **Typecheck** of all four packages, including tests (`npm run typecheck`).
- **Production build**: `npm start` path and the Docker image. The image refuses to start without secrets and serves the app with them, API locked behind sign-in. (In this sandbox Docker Hub rate-limited the base image, so the verification build pulled the identical `node:22-bookworm-slim` from the public ECR mirror and went through the sandbox's proxy; the committed Dockerfile is unchanged.)
- **The collector** sampled a real X11 window under Xvfb, merged samples into a session, sent it to a running server on shutdown, and left nothing on disk.
- **Screenshots** of every screen, phone and desktop, light and dark, were taken from the running app, critiqued against the brief and the design plan, fixed and retaken (see below).

## What couldn't be verified here

No API keys or third-party accounts were available in this environment, and outbound access to provider documentation was blocked. These paths are implemented and type-checked against the installed SDKs and the providers' documented APIs, but have not run against the real services:

1. **Anthropic API.** The gateway's request shapes come from SDK 0.131's types; every flow that uses the model is covered by tests with a scripted provider. First real check: talk to Ava once, then open Log and look at a model call's inputs and outputs.
2. **ElevenLabs, Cartesia, Deepgram, AssemblyAI.** Written from their API documentation as I know it, so this is the area most likely to need small fixes (parameter names, message types). Check with the voice audition, one spoken reply, then live mode and `npm run bench:voice`. If `eleven_v3` returns no character alignment, Ava falls back to the forced-alignment API automatically, at the cost of one extra call per reply.
3. **Live mode latency.** The target of under about 800 ms from the end of your turn to Ava's first sound depends on the providers and your region; it is measured per stage in Settings, Developer, but I couldn't measure it.
4. **Google Calendar and Gmail OAuth**, calendar push notifications, and Gmail sending.
5. **Wispr Flow.** Ava uses the MCP SDK's OAuth client against Wispr's official remote MCP endpoint (`WISPR_MCP_URL`, default `https://api.wisprflow.ai/connect/mcp`) with dynamic client registration. I couldn't confirm that endpoint URL or that Wispr allows third-party clients to register; if connecting fails, Settings shows Wispr's error. Dictating with Wispr Flow into Talk works regardless, since it simply types.
6. **Web push to a real device** and the installed PWA on iOS.

## Setting it up

1. `npm install`, then `npm run dev:test` to look around with fixture data.
2. Copy `.env.example` to `.env`. Generate `AVA_PASSWORD_HASH` (`npm run hash-password -- "…"`), `AVA_SESSION_SECRET` and `AVA_ENCRYPTION_KEY` (`openssl rand -hex 32` each). Back up the encryption key separately.
3. Add `ANTHROPIC_API_KEY`. Add `ELEVENLABS_API_KEY` (and optionally `CARTESIA_API_KEY`) and `DEEPGRAM_API_KEY` (or `ASSEMBLYAI_API_KEY`) for voice. `npm run config:check` confirms what's on.
4. `npm run vapid` and paste both keys for push.
5. Google: create an OAuth client (Web application) with redirect URI `PUBLIC_URL/api/oauth/google/callback`, enable the Calendar API (and Gmail API if wanted), add yourself as a test user. Note that Google expires refresh tokens after 7 days for apps left in "Testing"; publish the app ("In production", unverified is fine for personal use) to avoid reconnecting weekly. Gmail's read scope is restricted, so Google shows an unverified-app warning; that's expected for a personal project.
6. Deploy behind a tunnel (README, Deploying) and set `PUBLIC_URL` to its https address. Push notifications and Google's change notifications need it.
7. On your phone, open the tunnel URL, add Ava to the home screen, open it from there, and turn notifications on in Settings.
8. Run the first-run setup: calendar and course feeds, your two places, the voice audition, chat history import, then a first brain dump in Talk.
9. Optional: set `COLLECTOR_TOKEN`, turn on Laptop activity in Settings, and run the collector on your laptop (`node packages/collector/dist/collector.mjs service` prints a login service for your OS).
10. Optional: `DEADMAN_PING_URL` from healthchecks.io for an outside alarm.

## Limits outside the code

- iOS shows web push only for home-screen apps (16.4+) and without action buttons; browsers show at most two actions. The app always has every option.
- Google Calendar push needs a public https address; without one, calendar changes arrive when the heartbeat polls (every 3 hours) or when you press Sync now.
- The collector can't read the focused window on pure Wayland sessions (no API exists); macOS needs Accessibility permission for titles.
- Model, voice and recognition quality and cost depend on the providers; budgets cap the spend.

## Judgment calls

- **"Acted" for rule precision** means you chose "do it" (or an option) or the cited item advanced within a day. "Already done" closes the item but doesn't count as acting on the nudge, since the nudge wasn't needed; no response after 24 hours counts as ignored. A rule pauses itself below 0.4 precision after at least five messages.
- **One message per wake, and nothing before the brief.** The caps allow three unprompted messages a day; I added that at most one goes out per wake (the rest are held for later wakes) and that anything arising before today's brief waits for the brief. Running the seeded morning without these produced a burst of three messages at 08:00.
- **Time-bound suggestions are dropped, not queued.** "You have a free hour now" is useless in tomorrow's brief.
- **Deterministic templates without a model.** Wakes still produce real messages from rules and cited items when there's no key or the budget is spent; the message records how it was worded.
- **Executors see only the task.** An executor session gets the task spec and the item's context, never the planner's reasoning, so its plan-fit report is independent.
- **Encryption granularity.** Raw evidence, transcripts, model inputs and outputs, tokens, window titles and audio are encrypted; structured items stay in plaintext so they can be queried and indexed.
- **Development conveniences.** Outside production, missing core secrets are generated into the profile's data folder, and with no password set Ava answers only on the same machine. Production refuses both.
- **Window titles** are deleted after the retention period once labeled, and after twice that period regardless, so they never accumulate if there's no model to label them.
- **Design.** The interface follows a chronograph dial: one steel accent that always means "Ava's" (her plan, her check-ins, her recommendation, the primary action), hairline structure rather than grids of cards (the stack's single floating card is the deliberate exception), two typefaces (Archivo for everything measured, Newsreader for Ava's words), a dark theme designed on its own terms. The plan and its self-review are in [docs/design-plan.md](docs/design-plan.md).

What the screenshot review changed: the brief's idle indicator read as a loading spinner and became a dial face; Log split each wake into fragments and now groups every entry of a wake (push entries now carry their wake); task status controls didn't line up across rows; the Talk canvas left a large gap under modules beside the tall timeline (timelines now span rows, and spans follow the canvas width rather than the window's); the phone's Today list ran far below the fold and now shows the first items with "Show more"; wording such as "After Lunch with Arjun: 240 free minutes" now reads "after Lunch with Arjun, 4 hours free"; rule sentences such as "not you're in class … status is todo: suggest:" now read "you're not in class … status is not started, Ava suggests:"; and chip Accept buttons no longer compete with the one primary action.

## What I'd do next

1. Run the provider paths with real keys (list above) and fix whatever the first contact shows; then tune the turn-detection patience and grace window on your own speech using the latency panel.
2. Run the personality test set with audio and adjust `personality/*.md` until the six cases sound right; the comparison view shows text and audio side by side.
3. A week of real use, then look at rule precision and the Log to retune the built-in rules' thresholds.
4. Add a second channel (Telegram or SMS) behind the existing channel interface for when the phone browser isn't installed.
5. Offline queueing of check-offs and chip decisions in the service worker.
6. Encrypted off-site backups of the data folder on a schedule.

## Status (Parts 1–4, final)

Everything in the brief is built and pushed: the original build; the CI workflow (`.github/workflows/ci.yml`); the workflow files for the two-agent setup (`CLAUDE.md`, `AGENTS.md`, the PR template, `BACKLOG.md`); the server side of the card stack — threads (`state/threads.ts`), auto-filing with per-item undo (`state/filing.ts`), cards and the stack (`cards/cards.ts`, `GET /api/stack`, `/api/cards/:id/layer/2|3`, `POST /api/cards/:id/respond`, `POST /api/filings/:id/undo`, `/api/threads`), the morning stack replacing the written brief, push limited to time-sensitive cards (2 a day), rule approvals and inferences as occasional Pick cards; and the new main page on top of it.

**The stack's front room (Part 4).** The web app's main page (`/`) is the card stack: one card fully visible with one or two peeking behind; swipe right for yes and left for not now, with restrained drag feedback and the next card settling in behind; long-press for already done and stop suggesting this; tap, Enter or a desktop button for the next layer; two buttons and arrow keys on desktop. Pick options choose by key; results open the send confirmation, the artifact or the rule detail; layers 2 and 3 fetch lazily and undo per filed item. The bottom bar carries the mic (voice notes upload and transcribe through the existing pipeline), the dictated-text field and live mode folded into the same bar; Ava's short reply shows briefly and the transcript is a pull-up sheet. Calendar (`GET /api/calendar`: day dial and week view, his events plus Ava's check-ins, nothing else) and Everything (the thread hierarchy, collapsed) sit one tap away; Tasks, Rules, What Ava knows, Messages, Log and Settings moved behind one menu with the dual-time switch and the test-profile note. Today, Talk, the eight-item navigation and the canvas UI modules are deleted (`/api/today` and `views.todayView` too; `/today` and `/talk` redirect to `/`), and first-run finishes on the stack. Screenshots in `docs/screenshots` were regenerated and critiqued (stack, opened layer, all-clear, menu, calendar day and week, everything, the back room; phone and desktop, both themes), and the UI tests cover the deck, layers, undo, the menu, the location switch and a 320 px overflow guard.

Two known follow-ups: the server-side canvas machinery (`canvas/`, the hydrator, the module vocabulary) has no consumer on the main page and should be removed once confirmed unused; the back-room screens keep their old density until the restyle in `BACKLOG.md` lands.
