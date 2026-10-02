# Ava: notes for the reviewer

You review and merge pull requests opened by the implementing model. Read this at the start of every session; read `AGENTS.md` for the rules the implementer follows.

## What Ava is

A self-hosted, proactive personal agent for one person (Shreyas, a CS student between State College and Bangalore who thinks out loud and tends to stall at the final step). Ava keeps a model of his commitments, deadlines, projects and rhythms, plans ahead, and reaches out only when a rule and real evidence say so. Her job is to take the overwhelm out of his head: she decides what needs him now and shows him that, one thing at a time.

## Architecture principles

Full detail: [docs/architecture.md](docs/architecture.md). The non-negotiables:

- **The model plans; the system owns time, triggers, execution and enforcement.** The planner returns data (wake requests, rule proposals, blocks); the scheduler validates every wake against budgets and quiet hours. Executors are fresh sessions that see only their task and report plan-fit; they never send anything.
- **The constitution** (`packages/server/src/rules/constitution.ts`) is fixed and enforced in code: rule plus cited evidence for every proactive message, no invented states of mind, caps and quiet hours, limits on Ava's own rules, explicit confirmation of every external action, expiries, system-owned heartbeat and dead-man's switch, daily model budget, everything logged.
- **The wake procedure** (`wake/procedure.ts`): pull, update state, evaluate rules into candidates, run internal actions, rank and draft with placeholders, validate, dispatch, record.
- **The validator** (`validator/message-validator.ts`) renders every fact from stored state and rejects free-text facts, uncited items, states of mind and praise. It is never loosened to make a feature work.
- **Dynamic rules** are structured DSL, guarded, expiring, shadow-run before approval; rules that message need his yes.
- **Cards** are the unit of attention: one thing that needs him (Do, Pick or Know), three lazily generated layers, a short priority-ordered stack. Validated proactive messages become cards.

## Interface principles

- The main screen shows Ava's judgment, not her database. The full data lives in a back room (Everything, Calendar, and the menu: Rules, What Ava knows, Messages, Log, Settings).
- The front room shows only what she concluded he needs now, one card at a time. If he would have to scan, sort or compare on the main screen, the design is wrong.
- Calm: generous space, restrained motion, design tokens only, no generic AI-product look (no orbs, gradients, sparkles, neon on near-black, cream and terracotta, identical rounded-card grids, all-caps eyebrows, monospace labels, middle-dot metadata).

## Review procedure

1. Review the PR's diff, not the whole codebase. Read surrounding code only where the diff needs it.
2. Check it against the principles above and the rules in `AGENTS.md`. Anything touching the constitution, the validator or the scheduler's budget checks must be flagged in the PR description; read those parts line by line.
3. Confirm CI is green on the PR's head commit. Don't merge red or pending CI, and don't accept "tests pass" without the run.
4. For UI PRs, download the `screenshots` artifact from the CI run and look at the affected screens at phone and desktop sizes in both themes.
5. Small issues (naming, a missing test case, a token misuse, an off-by-one): fix them directly on the branch, wait for CI, merge. Large issues (wrong approach, scope creep, principle violations): comment with what to change and why; don't merge.
6. Whenever you correct a mistake the implementer is likely to repeat, add a one-line rule to the Lessons section of `AGENTS.md` in the same PR.

## Commands

- `npm ci`, then `npm run typecheck`, `npm test`, `npm run build`
- `npm run test:e2e` (Playwright, after a build)
- `npm run dev:test` (test profile with fixture data and a simulated clock, on http://localhost:5174)
- `npm run screenshots -- --base=http://127.0.0.1:4318` (against a running test-profile server)
