# Working on Ava

Rules for the implementing model. A reviewer (Claude Code, see `CLAUDE.md`) reviews every pull request, fixes small problems and merges. Read [README.md](README.md) for setup and [docs/architecture.md](docs/architecture.md) before changing server behaviour. Tasks are in [BACKLOG.md](BACKLOG.md).

## Workflow

- One concern per pull request. If you notice something else, note it in the PR description or BACKLOG.md; don't fix it in the same PR.
- One branch per task, named after it (`fix/chatgpt-parts`, `ui/restyle-rules`).
- Keep PRs small: ideally under about 400 changed lines, excluding lockfiles and screenshots.
- Fill in the pull request template completely.

## CI first

- Before opening a PR, run locally: `npm run typecheck`, `npm test` and `npm run build`. For UI changes also `npm run test:e2e`.
- A PR isn't ready for review until CI is green on its latest commit.
- Never claim tests pass without having run them. Paste the summary line (for example `Tests 68 passed (68)`) into the PR.
- Never skip, disable or weaken a test to get green. If a test is wrong, say why in the PR.
- New behaviour comes with a test. Server tests use the helpers in `packages/server/test/helpers.ts` (an in-memory app on a simulated clock and a scripted model provider); no test may reach the network.

## UI pull requests

- Include screenshots of every screen you changed at phone (390 px) and desktop (1440 px) widths, light and dark. Run Ava on the test profile (`npm run dev:test`, or the built server with `AVA_PROFILE=test`) and use `npm run screenshots -- --only=<screen>`; CI also uploads them as an artifact.
- Check the screen at 320 px wide too.

## Code rules

- Match the existing structure: shared schemas and pure logic in `packages/shared`, server behaviour in the matching `packages/server/src` module, screens in `packages/web/src/screens`, reusable UI in `packages/web/src/components`.
- Types are required. No `any`; prefer the shared zod schemas and their inferred types.
- No dead code, commented-out code, unused exports or stray debug logging.
- No placeholder implementations, mocks or fake data in real code paths. Fixtures belong to the test profile (`packages/server/src/fixtures`) and tests only.
- Every decision Ava makes on her own is written to the decision log (`svc.log`).

## Interface rules

- Use design tokens only (`packages/web/src/styles/tokens.css`). No new colors, font sizes, fonts, radii or spacing values outside the token system; if a token is missing, add it there and say so in the PR.
- Never show internal identifiers or type names in the UI: no `open_loop`, `task`, `rule.proposed`, ids or enum values. Map them to words a person would use.
- No horizontal overflow at any width down to 320 px.
- The main page shows Ava's judgment, not her database: one card at a time. Nothing new is added to the main page without a strong reason stated in the PR. New information belongs in a card layer, Everything, Calendar or the back room.
- Sentence case everywhere. No all-caps labels, monospace labels, middle-dot metadata strings, arrows on buttons, gradient blobs, orbs or sparkle icons.
- Respect `prefers-reduced-motion`; motion only explains a change.
- Every control works by keyboard and has a visible focus ring.

## Boundaries

Never change these without flagging it prominently at the top of the PR description, with the reason:

- the constitution (`packages/server/src/rules/constitution.ts`) and anything that enforces it
- the message validator (`packages/server/src/validator/message-validator.ts`)
- the scheduler's budget and quiet-hours checks (`Scheduler.request` in `packages/server/src/scheduler/scheduler.ts`) and the dispatcher's caps (`packages/server/src/wake/dispatcher.ts`)
- authentication, encryption and retention (`packages/server/src/http/auth.ts`, `packages/server/src/security`, `packages/server/src/core/retention.ts`)

Never add a path that sends, submits or spends anything without the existing explicit-confirmation flow.

## Lessons

Rules the reviewer adds when correcting a mistake that is likely to repeat. Follow them like the rules above.
