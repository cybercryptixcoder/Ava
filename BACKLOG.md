# Backlog

Small, separate tasks for the implementing model. Take them in order unless told otherwise; one task per branch and pull request. Read `AGENTS.md` first. When a task is merged, the reviewer removes it here.

## 1. ChatGPT export: message text stored in `parts`

**Question.** Does the ChatGPT import lose message text when `content.parts` holds something other than plain strings?

ChatGPT exports keep message text in `message.content.parts`. Usually that's an array of strings, but multimodal messages mix strings with objects (`{ "content_type": "image_asset_pointer", ... }`), some content types carry text in `content.text` instead (`"code"`, `"execution_output"`), and parts can be empty strings.

- Parser: `packages/server/src/sources/parsers/chat-export.ts` (`parseChatExport`, `userTextOf`).
- Existing test: `packages/server/test/units.test.ts`, "chat export import".
- Add tests for: mixed string and object parts (text kept, objects skipped, nothing crashes), a `multimodal_text` message, a message whose text is in `content.text`, and empty parts. Fix the parser if any fail.
- Done when the new tests pass and no user text is dropped.

## 2. ICS: recurring events

**Question.** Do recurring events in an ICS feed (a class that meets MWF all semester, written as one `VEVENT` with an `RRULE`) collapse into a single occurrence?

- Source: `packages/server/src/sources/ics.ts` (uses `node-ical`); classification in `calendar-util.ts`.
- Add a test with a small inline ICS string: a weekly `RRULE` with `BYDAY=MO,WE,FR` over several weeks, one `EXDATE`, and one overridden instance (`RECURRENCE-ID`). Assert the imported events are the individual occurrences in the sync window, the excluded date is missing and the override has its new time.
- Fix expansion if needed; respect the feed's time zone (`TZID`).
- Done when the test passes and the Calendar view shows every class meeting.

## 3. Restyle the back-room screens (one screen per PR)

The main page introduced the new design tokens and components (card, stack, input bar). The back-room screens still use the older, denser styling. Restyle each to the new tokens and spacing without changing what it does. One PR each, in this order:

- 3a. Settings
- 3b. Rules
- 3c. What Ava knows
- 3d. Messages history
- 3e. Log

For each: tokens only (`packages/web/src/styles/tokens.css`), no internal names on screen, no horizontal overflow at 320 px, screenshots at phone and desktop in both themes in the PR.

## 4. Polish Calendar and Everything

- Calendar (`packages/web/src/screens/Calendar.tsx`): the day and week views should read cleanly at a glance. His calendar plus Ava's planned check-ins, nothing else. Check long titles, overlapping events, all-day events and a day with nothing on it.
- Everything (`packages/web/src/screens/Everything.tsx`): threads, then items, then subtasks, collapsed by default. Check keyboard navigation (arrow keys and Enter on the tree), long titles, and a thread with many items.
- Screenshots in the PR. One PR per view if the diff grows past about 400 lines.
