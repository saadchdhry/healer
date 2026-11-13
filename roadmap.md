# Healer: roadmap

Planned developments and improvements. Each item is written to be picked up by someone, or by an agent, with no memory of earlier work sessions.

## How to use this file

- Read `brief.md` first for what the project is and why. Section 7 of the brief records what the build found.
- `README.md` says how to run it. Every model call is live and costs money, so each item below gives a rough spend.
- An item is ready to build when it has all the parts used below: status, why, current behaviour, the change, where the code is, done when, and cost.
- When an item ships, move it to "Done" at the bottom with the date and one line on what changed, and update `brief.md` wherever it describes the old behaviour.

## Background every item assumes

Healer is a localhost demo of a self-improving agent. Two services share one agent package.

- `packages/agent/`: the shared contract (`src/types.ts`, `src/api.ts`), a small hand-written graph runner (`src/graph.ts`), the support agent (`src/supportAgent.ts`), its tools and guards (`src/tools.ts`), the shop world and seed data (`src/env.ts`), the Claude client wrapper (`src/llm.ts`), and a hand-written bag-of-words classifier (`src/router.ts`).
- `services/shop/`: the product. Runs the support agent for "Pocket Meadow", a fictional shop. Emits every conversation as a trace and accepts new agent versions. Knows nothing about the healer.
- `services/healer/`: the learning loop. Judges each trace, diagnoses failures, proposes a change, runs it against the eval suite (the gate), and deploys it to the shop.
- `web/`: the shop front at `/` and the console at `/console`.

An agent version has three surfaces that can change: context (memory notes), harness (system prompt, tool descriptions, guards), and model. The model config is either `fixed` (one tier for every request) or `routed` (a trained classifier, "the router", picks the easy tier or the hard tier per request). Tiers are `haiku`, `sonnet`, `opus`.

Conventions that apply to all work here: no code comments unless the reason is non-obvious; no error handling for things that cannot happen; validate only at boundaries; never use em dashes in any text, including prompts and interface copy; unit tests run without an API key using `ScriptedLlm` and `FakeShop`; `npm run typecheck` and `npm test` must pass across the repo.

---

## 1. Train the router on risk, not on measured failure

**Status:** decided by the owner on 2026-11-13, not started.

### Why

The router is the only place in the demo where model weights really change, and today it cannot train.

It was designed to learn "which requests does the small model fail and the large model get right". The build measured this and found almost no such requests. Once the shop's rules are in the agent's context, Haiku 5.5 behaves the same as Sonnet 5.5 on nearly everything. In one run of 40 requests, replayed 160 times on Haiku, it never contradicted Sonnet. On the hardest request found (three orders refunded in one message) it made an arithmetic error about once in 17 tries. A classifier cannot learn from an event that rare, so the dataset has no positive examples and training refuses to run.

The fix is to change what the router learns. When failures are rare, the useful question is not "will the small model fail this request" but "how much does a failure on this request cost". A wrong answer to "where is my order" costs little. A wrong refund moves money. So the router should learn which requests carry risk and send those to the stronger model, while lookups and questions stay on the small one. This is how routing is commonly done in practice when failures are too rare to learn from, and every arithmetic error the build measured falls inside the risky class, so the measured gap stays covered.

### Current behaviour

- `services/healer/src/routerTraining.ts`, `startDatasetJob`: takes real customer messages from stored traces, replays each in a sandbox four times on the easy tier (`EASY_REPLAYS`, tier `haiku`) and once on the hard tier (the "reference"), all with the live version's context and harness.
- `wrongness(easy, reference)` in the same file decides whether an easy replay is wrong: it broke a policy rule in code, or the reference kept every rule and the easy replay made a write the reference did not make, or refunded a different amount or method. Asking a question where the reference acted does not count as wrong. No model judge is involved.
- A `RouterExample` (in `packages/agent/src/types.ts`) gets `needsStrong: true` only when at least one easy replay is wrong and the reference passes policy.
- `POST /api/healer/model/router/train` answers 409 with "The dataset has no requests that needed the stronger model yet..." when there are no positives. With the rules in context, that is what happens.
- `trainRouter` and `predictRoute` in `packages/agent/src/router.ts` are a bag-of-words logistic regression. They work and are tested.
- `services/healer/src/gate.ts` has a deterministic check for routed candidates: every enabled eval case that belongs to an issue with cause `capability` must be routed to the hard tier, or the proposal is rejected.
- The console's Model page is `web/src/console/pages/Model.tsx`. It shows the dataset, class balance, the loss curve, train and validation accuracy, positives, and validation recall.

### The change

1. **Label by risk as well as by measured failure.** A request needs the strong model when either of these is true:
   - **High stakes.** In any of its replays (the four easy ones or the reference), the agent called a tool that moves money or cannot be undone. Use `issue_refund` and `cancel_order`. Count the attempt whether or not a guard blocked it. Do not count `update_shipping_address` (reversible while the order is processing) or `escalate_to_human` (a hand-off to a person, which is the safe direction).
   - **Measured failure.** The existing `wrongness` rule, unchanged.
2. **Record why.** Add a `reason` field to `RouterExample`: `'high_stakes'`, `'measured_failure'`, or `null` for requests that stay on the small model. When both apply, record `'measured_failure'`, since it is the stronger evidence. Show the reason as a column in the dataset table on the Model page.
3. **Keep the reference requirement only where it belongs.** A measured failure still needs the reference to pass policy. A high-stakes label does not depend on the reference passing.
4. **Say what it is.** Everywhere the router is described, the claim becomes "it learns which requests carry risk and sends those to the stronger model". Update the explainer on the Model page, the rationale text written by `proposeRouter` in `routerTraining.ts`, the activity line written at the end of the dataset job, the 409 message for an empty positive class, and `brief.md` (the "Real: training a small local classifier" part of section 4.5, the settled decision about the classifier's job in section 5, and section 7).
5. **Leave the gate check as it is.** Capability cases must still be routed to the hard tier. Add one line to a routed proposal's gate reasons stating what share of the dataset the router sends to each tier, so the viewer can see where the saving comes from.

### Known weakness to state in the interface, not to solve

A request the agent correctly refuses (for example a refund outside the 30-day window, once the rule is in context) is labelled low stakes if no replay attempted the refund. The classifier will usually still route it to the strong model, because it shares words such as "refund" with requests that were labelled high stakes. That is generalisation from wording, not a guarantee. Say so in one sentence on the Model page.

### Where the code is

| What | File |
|---|---|
| Labelling, dataset job, training entry point, routed proposal | `services/healer/src/routerTraining.ts` |
| Tests for the above | `services/healer/src/routerTraining.test.ts` |
| `RouterExample`, `RouterModel` | `packages/agent/src/types.ts` |
| Trainer and predictor | `packages/agent/src/router.ts` |
| Routes (`/model/router/dataset`, `/train`, `/:id/propose`) and the 409 | `services/healer/src/app.ts` |
| Gate decision and the routing check | `services/healer/src/gate.ts` |
| Tool calls recorded on a trace (`toolCalls`, `blockedByGuard`) | `packages/agent/src/types.ts`, `packages/agent/src/tools.ts` |
| Simulated customers and their intent mix | `services/healer/src/simulate.ts` |
| Model page | `web/src/console/pages/Model.tsx` |

### Done when

- Unit tests cover: a request labelled high stakes from an attempted refund, from an attempted cancellation, and from a call a guard blocked; an address change and an escalation not counting; both reasons applying; a lookup staying on the small model.
- From a factory reset, after firing the seeded cases and sending about 30 simulated customers, a dataset of up to 40 examples has both classes, with positives somewhere around a third to a half.
- Training succeeds, and validation has positives so that validation recall is a real number.
- The words with the largest positive weights are ones a person would expect, such as refund, return, cancel, money.
- A routed proposal passes the gate with nothing regressed, the pass rate not lower, and a lower cost per task than the same version with every request on the hard tier.
- The Model page shows the reason column, the new wording, and the known weakness.
- `npm run typecheck`, `npm test`, and `npm run build -w @healer/web` pass, and `brief.md` matches what was built.

### Cost

About $1 to $3 of API spend for the live run. Replays are cheap because no model judge is involved. Use 2 trials per eval case while iterating.

### Alternatives considered and set aside

- **A weaker bottom model.** Start the ladder from an older model (Haiku 4.5 with thinking off) to widen the capability gap and keep the original "learn from failure" idea. Set aside because it needs a second request shape in `packages/agent/src/llm.ts` (older models take a thinking budget, not an effort level), more experiment, and might still give too few positives.
- **Leave it.** Keep the trainer showing an honest "nothing to learn yet". Set aside because the demo's only real weight training would never run.

---

## Done

Nothing yet.
