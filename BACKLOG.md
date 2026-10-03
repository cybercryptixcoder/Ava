# Backlog

Small, separate tasks for the implementing model. Take them in order unless told otherwise; one task per branch and pull request. Read `AGENTS.md` first. When a task is merged, the reviewer removes it here.

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
