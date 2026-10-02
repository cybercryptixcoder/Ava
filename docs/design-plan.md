# Ava design plan

Ava keeps time for one person. The interface should feel like a precise, well-made instrument: the restraint of a vintage chronograph dial, printed rather than glowing. This plan fixes the tokens, the layouts and the principles before any screen is built, then checks itself against the brief.

## Principles that make this Ava's interface

1. **Time is drawn, not just written.** Durations are lengths on a scale, deadlines are positions on a horizon, the day is a vertical dial with hour and quarter ticks. Every time and number is set in tabular lining figures so columns of times align like dial printing.
2. **Steel is Ava's hand.** One accent, a heat-blued steel blue, and it means exactly one thing: *this is Ava's*. Her planned wakes, the work she intends to do, the "now" hand she moves, the option she recommends, the single primary action on a screen. His calendar and his tasks are drawn in ink. Looking at the Today dial you can tell at a glance what is his and what is her plan.
3. **Two voices in type.** Ava's words are set in a text serif (Newsreader), because she is a voice talking to him. Everything the instrument measures (times, items, labels, controls) is set in a grotesque with a width axis (Archivo). His own words in the transcript are in the grotesque too, slightly smaller: what he said is data she works from.
4. **Hairlines, not boxes.** Structure comes from 1px rules, tick marks and alignment. Modules on the canvas are separated by a top rule and space, not by cards with shadows. Fills are reserved for meaning: a class block is hatched (protected time), Ava's plan is a steel tint, an inferred belief is outlined rather than solid.
5. **Motion explains a change.** Things move only to show what changed (a task struck through as it's checked off, a block sliding to tomorrow, a module part appearing as Ava says it). The now-hand steps once a minute. Nothing breathes, pulses or floats. Reduced-motion turns reveals into instant appearance.
6. **Ava's presence is the escapement.** Her state lives in one small mark at the input: twelve ticks. Listening: the ticks follow his voice level. Thinking: a single tick steps around, like a seconds hand. Speaking: ticks fill as the words are spoken. No avatar, no orb.

## Tokens

### Color

Light theme, "enamel dial": a cool, slightly grey white with black printing and blued steel.

| Token | Light | Use |
|---|---|---|
| `--bg` | `#F3F4F2` | page |
| `--surface` | `#FBFBFA` | raised surfaces: popovers, the input, sheets |
| `--sunken` | `#E8EAE7` | wells, tracks, the timeline gutter |
| `--ink` | `#121418` | primary text, his items |
| `--ink-2` | `#454B53` | secondary text |
| `--ink-3` | `#626872` | labels, tick numerals (4.9:1 on bg) |
| `--rule` | `#D2D5D9` | hairlines |
| `--rule-strong` | `#868C93` | major ticks, input borders (3.1:1) |
| `--steel` | `#2443B0` | Ava's hand (7.7:1 on bg) |
| `--steel-ink` | `#FFFFFF` | text on steel |
| `--steel-tint` | `rgba(36, 67, 176, 0.09)` | Ava's planned blocks |
| `--event` | `#E1E4E8` | his calendar blocks |
| `--hatch` | `rgba(18, 20, 24, 0.07)` | class and exam hatching |
| `--signal` | `#B3261E` | errors and validator failures only |

Dark theme, "night dial": designed on its own terms. A gunmetal dial, lume-tinted printing, and the steel lifted so it reads at night. Not inverted: the ink is warm lume, the ground is cool graphite, and tints are rebalanced so blocks don't glare.

| Token | Dark |
|---|---|
| `--bg` | `#171A1F` |
| `--surface` | `#1E2228` |
| `--sunken` | `#121418` |
| `--ink` | `#E9E6DC` |
| `--ink-2` | `#B7B5AC` |
| `--ink-3` | `#8F908B` (5.3:1 on bg) |
| `--rule` | `#2B3037` |
| `--rule-strong` | `#68707A` (3.5:1) |
| `--steel` | `#90A7F3` (7.2:1 on bg) |
| `--steel-ink` | `#0E1530` |
| `--steel-tint` | `rgba(144, 167, 243, 0.13)` |
| `--event` | `#262B32` |
| `--hatch` | `rgba(233, 230, 220, 0.06)` |
| `--signal` | `#F28B80` |

The theme follows local time automatically (dark from 19:00 to 07:00 by default, in his current time zone) with a manual override that persists per device.

### Type

- **Archivo Variable** (wght 100–900, wdth 62–125): interface, data, numerals. `font-variant-numeric: tabular-nums lining-nums` everywhere numbers appear. Width is used deliberately: condensed (wdth 78) for tick numerals and small labels so they sit tight on scales, normal (100) for UI, expanded (118) light for the large dial time.
- **Newsreader Variable** (opsz 6–72): Ava's words, belief statements, the constitution's text.

| Role | Face | Size / line | Weight | Notes |
|---|---|---|---|---|
| Dial time | Archivo wdth 118 | 56 / 1 | 300 | Today header, the current time |
| Screen title | Archivo | 26 / 1.15 | 600 | sentence case |
| Section | Archivo | 17 / 1.3 | 600 | |
| Ava | Newsreader opsz 18 | 19 / 1.5 | 400 | her replies in Talk |
| Ava small | Newsreader opsz 14 | 16 / 1.5 | 400 | notes, statements in modules |
| Body | Archivo | 15 / 1.45 | 400 | |
| Meta | Archivo | 13 / 1.35 | 450 | |
| Label | Archivo wdth 82 | 12 / 1.2 | 550 | sentence case, never all caps |
| Tick | Archivo wdth 78 | 11 / 1 | 500 | scale numerals |

### Space and shape

- Spacing on a 4 px base: 4, 8, 12, 16, 24, 32, 48, 72.
- Radii by hierarchy: 2 px for chips and tick-sized controls, 6 px for buttons and inputs, 12 px for sheets and popovers. Modules have no radius: they are sections of one surface.
- Rules: 1 px hairlines. Major ticks 1 px `--rule-strong`, minor ticks 1 px `--rule`.
- Elevation only for things that float above the surface (popovers, sheets, the live bar): one soft shadow, never on modules.

## Layouts

### Frame

- **Desktop (≥ 1024 px):** a narrow left rail with the screen names in Archivo (no icons needed), and at its top the dual-time location switch: both places with their current local times, the active one in ink, the other in ink-3. One tap switches and every schedule is recomputed. Main area to the right.
- **Phone:** a bottom bar with Today, Talk, Tasks, Messages and More (Rules, What Ava knows, Log, Settings in a sheet). The location switch sits in the Today header.

### Today

The day as a vertical dial. A scale on the left with hour numerals and quarter ticks; his calendar blocks in ink on the first track (class and exam blocks hatched, because Ava stays quiet there); a narrow second track to the right is **Ava's track**: her planned wakes as small steel marks with their reasons ("checking in at 1:20, after class"), and her intended work as steel-tinted blocks. Deadlines are hairline flags at the due time. The now-hand is a steel line across both tracks with the time printed at the scale. Planned wakes can be dragged along the track, snoozed or cancelled from a small popover.

Header: the dial time, the date, the location switch, and the next check-in in one sentence. On desktop a right column holds **Waiting for you**: the morning brief (play), messages that need a response, confirmation chips, rule proposals, the one question, and anything waiting for send confirmation. On a phone the same items sit above the dial as a compact list.

### Talk

A composed canvas, not a feed. Desktop: the canvas takes the wide right area as a 12-column grid where modules take spans by type (timelines tall and narrow, comparisons wide, options medium); the left column carries the conversation (his words in the grotesque, Ava's in the serif, no bubbles) with the input at the bottom. The latest module Ava placed is in reading position; as she speaks, segments appear in time with her words. Phone: the canvas comes first, with Ava's latest words pinned just above the input; the full transcript opens as a sheet.

The input is large, auto-expanding and comfortable for minutes of dictated text (Wispr Flow types into it). Send is one action (button or Cmd/Ctrl-Enter). The escapement sits at its left. Switching to live mode is one obvious control next to it; in live mode the input becomes the live bar: the escapement grows, his words appear as he speaks, and there's one button to end.

### Tasks and projects

Grouped by what finishing needs, not by type: **Almost there** (drafted, almost done) first, then **In progress**, **Not started**, then **Projects** with last-touched drawn as a length so staleness is visible. Each row: check-off, title, a status control (Not started, Started, Drafted, Almost done, Done), due time in tabular figures. Editable by touch and by voice (Talk).

### Rules

Three bands. **The constitution**: numbered articles in the serif, read-only, each naming where it's enforced. **Built-in rules**: the five triggers with their parameters and switches. **Ava's rules**: each shows its sentence, the evidence it rests on, live stats as a tick strip (acted, not now, already done, less of this, ignored), precision, and expiry as a countdown; on/off switch; paused rules say why. **Proposals** show shadow results as marks along the last few days, labelled with what the rule would have done (message, queued, blocked by quiet hours or class), with Approve and Turn down.

### What Ava knows

Beliefs grouped by area. Statements in the serif. Provenance is visible in the drawing: stated beliefs solid, observed beliefs with a fine underline, inferred beliefs outlined and marked "unconfirmed" until he confirms them. Confidence is a short bar that visibly shortens as it decays. Confirm, Edit and Remove on every belief.

### Messages, Log, Settings

- **Messages:** every proactive message with its because line, cited items, the rule that produced it, his response, and when.
- **Log:** the decision log grouped by wake, so each wake reads as a short story: what was evaluated, what the model was asked, what the validator decided, what went out or why nothing did.
- **Settings:** sources and connections, time and places, caps and budgets, voice (with the audition grid), style notes, notifications, privacy (export, delete per source), and the developer panel (latency by stage, model usage, time simulation on the test profile, personality test runs).

### First run

Five steps on one quiet page: connect calendar and feeds, set the two locations, choose Ava's voice in the audition, import chat exports, then a first brain dump on the Talk canvas with chips to confirm.

## Review against the brief, and what changed

The first draft of this plan was checked against the brief and against the defaults any similar app would ship with. What changed:

- *First draft used a generic "card" per module with a soft shadow.* That is the banned grid of identical rounded cards. Replaced with hairline-ruled sections on one surface and type-driven spans.
- *First draft colored his tasks by status (green done, amber due soon).* That is decoration, and it spends color the accent should own. Status is now carried by position, weight and strike-through; only Ava's things are colored.
- *First draft had small all-caps labels over sections ("TODAY", "WAITING").* Banned; replaced by sentence-case labels in condensed Archivo.
- *First draft set labels and times in a monospace.* Banned; Archivo's tabular figures do the alignment, and the condensed width gives the "printed scale" feel without a mono.
- *First draft showed meta as "Due Mon · Not started · CMPSC 465".* Middle-dot strings are banned; meta is laid out in aligned columns instead.
- *The dark theme was the light theme inverted.* Rebuilt: warm lume ink on cool graphite, lifted steel, quieter event fills, so late-night use doesn't glare.
- *Ava's state was a pulsing dot.* Replaced with the escapement (ticks), which is specific to an instrument that keeps time and never pulses.

## Accessibility floor

- Text contrast at least 4.5:1 in both themes (checked values in the tables above); non-text marks at least 3:1 where they carry meaning. Tertiary text never sits on an event fill (it measures 4.4:1 there); those labels use `--ink-2`.
- Every control reachable and operable by keyboard, with a visible 2 px steel focus ring offset from the element.
- Drag interactions (moving a wake) have a keyboard and button equivalent.
- `prefers-reduced-motion` removes reveals and transitions.
- Layouts designed for 360 px phones and 1440 px desktops, not scaled between them.
