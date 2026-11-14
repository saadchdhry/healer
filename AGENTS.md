# Healer: agent instructions

At the start of a session, read `notes.md` (the owner's git-ignored inbox) and act on every note without a reply, following the rules at its top.

## Never disturb the owner's running demo

The owner often has `npm run dev` running on the default ports (web 3000, shop 4311, healer 4312) with their data in `data/`. Never reset it, stop it, send it test traffic, or write to `data/shop.db` or `data/healer.db`. Do all live testing on the `healer-verify` entry in `.claude/launch.json` (web 3210, data in `data/verify`), and reset that freely. Put this rule in the brief of every sub-agent that runs the app.

## Spending

Every model call is billed to the owner. Say what a live run should cost before starting it, and report what it cost from the console's cost meter. Use 2 trials per eval case while iterating.

## Rules the code will not stop you breaking

- Every model call goes through `LlmClient` in `packages/agent/src/llm.ts`, so the cost meter sees it.
- The agent is never shown shop policy. It lives only as code checks in `services/healer/src/policy.ts`, and the agent learns it from the wording of failed checks. Never put policy rules in the factory prompt or hand them to the proposer, even to fix a defect by hand.
- The owner's writing rules (no em dashes, no invented abbreviations) also apply to prompts, interface copy and seeded customer messages.
- Every beat in `demo-beats.md` was performed before it was written. If a change alters a beat, perform it again on the isolated copy before rewriting that passage.
