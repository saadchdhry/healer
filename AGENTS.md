# Healer: agent instructions

Extends the `AGENTS.md` files above this folder. `README.md` says what the project is and how to run it.

---

## Start of every session

1. Read `notes.md` if it exists. It is the owner's inbox and is git-ignored. Act on every note that has no reply yet. Never edit the owner's words: reply on an indented line under the note, starting with "Agent:" and the date, and move finished notes with their replies to "Handled". Give an opinion on a suggestion before acting on it. Write a roadmap request into `roadmap.md` to that file's standard, and say in the reply which item it became.
2. Read `roadmap.md` for planned work and open defects. Read `brief.md` for the concept and design. Its section 7 records what the build found.

---

## Never disturb the owner's running demo

The owner often has `npm run dev` running in their own terminal on the default ports (web 3000, shop 4311, healer 4312) with their data in `data/`. Do not reset it, stop it, or send it test traffic, and do not write to `data/shop.db` or `data/healer.db`.

Do all live verification on the isolated copy: the `healer-verify` entry in `.claude/launch.json` (web 3210, shop 4421, healer 4422, data in `data/verify`). Reset that copy freely. Put this rule in the brief of every sub-agent that runs the app.

The owner's services watch the source files and restart on every edit. That is expected.

---

## Spending

Every model call is live and billed to the owner's key.

- Say what a live run is expected to cost before starting it, and report what it did cost from the console's cost meter.
- Use 2 trials per eval case while iterating.
- Unit tests must never need a key.

---

## Code

- **Contract first.** Shared shapes and routes live in `packages/agent/src/types.ts` and `api.ts`. Add to them; do not rename or remove without the owner's agreement. Update the web client in the same change.
- **One door to the model.** Every model call goes through `LlmClient` in `packages/agent/src/llm.ts`. Load the `claude-api` skill before changing how Claude is called. Model ids are constants in `types.ts`.
- **The judge model stays fixed.** If it changed between agent versions, scores would stop being comparable.
- **The agent is never shown shop policy.** Policy exists only as code checks in `services/healer/src/policy.ts`. The agent learns it one failure at a time, from the wording of a failed check. Do not shortcut this by putting rules in the factory prompt or handing the proposer the rule list.
- **The shop knows nothing about the healer.** Traces flow out of the shop and versions flow in. Keep it that way.
- **Prompts are on display.** The console shows them as raw workings, so write them to be read.
- **Tests** use `ScriptedLlm` (agent package) and `FakeShop` (`services/healer/src/testing.ts`) with temporary database files.
- **Text rules apply everywhere**, including prompts, interface copy, and seeded customer messages: no em dashes, sentence case, no invented abbreviations.

---

## Before calling work done

- `npm run typecheck`, `npm test`, and `npm run build -w @healer/web` pass. Remove `web/dist` afterwards.
- Anything a model decides (judge, diagnosis, proposals, simulated customers) is checked in a live run on the isolated copy, not only in tests. Say plainly which parts were seen live and which are covered by tests alone.

---

## Keeping the docs true

- **`demo-beats.md`:** every beat was performed before it was written. When a change alters what a beat describes, perform that beat again and rewrite only that passage.
- **`roadmap.md`:** move a shipped item to "Done" with the date and one line. Record a new defect under "Defects to fix" in that section's format, complete enough for an agent with no memory of this session.
- **`brief.md`:** update it wherever it describes the old behaviour, and add a line to its change log.
- **`README.md`:** what someone needs to run and find their way around the project. Detail belongs in the other files.

---

## Working with sub-agents

When several agents edit in parallel, give each its own folders, and let only the orchestrating session write to git.

---

## Git

The remote `origin` is `github.com/saadchdhry/healer`. Push only when the owner asks.
