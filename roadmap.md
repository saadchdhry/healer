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

Two kinds of shop data matter to several items. The live shop (`services/shop/`) holds one set of records that every chat changes: the viewer's, simulated customers' and seeded cases'. The healer never touches it directly. Everything the healer runs itself (eval trials, router replays, red-team probes) runs in a sandbox on a copy: each `EvalCase` stores its own starting records in `env`, and a trace records the records before and after the run (`envBefore`, `envAfter`). A verdict comes from `judgeTrace` in `services/healer/src/judge.ts`: the policy rules in `services/healer/src/policy.ts` checked in code, plus one model call for truthfulness, grounding and customer notes. An eval case runs `Settings.trialsPerCase` times per version and passes when a majority of its trials pass.

Conventions that apply to all work here: no code comments unless the reason is non-obvious; no error handling for things that cannot happen; validate only at boundaries; never use em dashes in any text, including prompts and interface copy; unit tests run without an API key using `ScriptedLlm` and `FakeShop`; `npm run typecheck` and `npm test` must pass across the repo.

---

## 1. Train the router on risk, not on measured failure

**Status:** decided by the owner on 2026-11-13, not started.

### Why

The router is the only place in the demo where model weights really change, and today it cannot train.

It was designed to learn "which requests does the small model fail and the large model get right". The build measured this and found almost no such requests. Once the shop's rules are in the agent's context, Haiku 5.5 behaves the same as Sonnet 5.5 on nearly everything. In one run of 40 requests, replayed 160 times on Haiku, it never contradicted Sonnet. On the hardest request found (three orders refunded in one message) it made an arithmetic error about once in 17 tries. A classifier cannot learn from an event that rare. Depending on the run, the dataset has no positive examples and training refuses to run, or it has a single one and training produces a router that sends everything to the small model.

The fix is to change what the router learns. When failures are rare, the useful question is not "will the small model fail this request" but "how much does a failure on this request cost". A wrong answer to "where is my order" costs little. A wrong refund moves money. So the router should learn which requests carry risk and send those to the stronger model, while lookups and questions stay on the small one. This is how routing is commonly done in practice when failures are too rare to learn from, and every arithmetic error the build measured falls inside the risky class, so the measured gap stays covered.

### Current behaviour

- `services/healer/src/routerTraining.ts`, `startDatasetJob`: takes real customer messages from stored traces, replays each in a sandbox four times on the easy tier (`EASY_REPLAYS`, tier `haiku`) and once on the hard tier (the "reference"), all with the live version's context and harness.
- `wrongness(easy, reference)` in the same file decides whether an easy replay is wrong: it broke a policy rule in code, or the reference kept every rule and the easy replay made a write the reference did not make, or refunded a different amount or method. Asking a question where the reference acted does not count as wrong. No model judge is involved.
- A `RouterExample` (in `packages/agent/src/types.ts`) gets `needsStrong: true` only when at least one easy replay is wrong and the reference passes policy.
- `POST /api/healer/model/router/train` answers 409 with "The dataset has no requests that needed the stronger model yet..." when there are no positives. With the rules in context, that is the usual outcome. Some runs find one positive, and training then succeeds but every strongly weighted word pushes toward the small tier.
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

## 2. Check that the customer got the refund they were owed

**Status:** proposed, not started. The owner agreed it belongs on the roadmap and has not chosen a design.

### Why

The judge can see a refund that is too large but not one that is too small, and not one that never happened. Every policy rule in `policy.ts` is a limit on what the agent did: refunding past the window, above the refundable value, above $150, to the wrong method, twice. A customer who is owed $72.51 and gets $60, or who is told no when the answer is yes, breaks no rule. The model judge does not catch it either, because its prompt tells it not to judge whether actions were allowed. The verdict passes.

This was seen during the build. The seeded case "A return that depends on the amount" exists because the small model worked out the right amounts and then refunded nothing, and its own `teaches` line says only a thumbs-down or an eval with the exact amount catches that. So the demo undercounts its own failures: the pass rate on live traffic looks better than it is, the failures never reach diagnosis, and the claim in `brief.md` section 7 that the small model matches the large one rests partly on a judge that cannot see this class of mistake. For a shop, shortchanging a customer is as real a failure as overpaying one.

The amount owed can be worked out in code, since `policy.ts` already computes an order's refundable value. What code cannot know is which items the customer asked to return. That is a reading of the customer's words, and the judge model already reads them on every trace.

### Current behaviour

- `judgeTrace` in `services/healer/src/judge.ts` builds a verdict from `policyChecks(trace)` (one `CheckResult` per rule that applies, `checkId` `policy:<rule id>`), one model call with `JUDGE_SYSTEM` returning `judgeSchema` (`truthful`, `grounded`, `customer_notes`, `preferences`), and a `feedback` check when the customer rated the reply.
- `RULES` in `services/healer/src/policy.ts` has ten rules. All of them inspect what changed (`envChanges`: new refunds, new escalations, cancellations, address changes). A rule with nothing to inspect returns `not_applicable`, so a trace that changed nothing can never fail a rule.
- `refundableValue(order)` in `policy.ts` returns the refundable value of a whole order: items that are not final sale, after the order discount, opened items at 85% (`RESTOCKING_KEEP`), shipping excluded, rounded once at the end. It has no form for a subset of items or quantities. `daysBetween`, `usd` and the private `lineValue` are in the same file.
- `ESCALATION_THRESHOLD` is 150 and private to `policy.ts`.
- `DIAGNOSE_SYSTEM` in `services/healer/src/diagnose.ts` tells diagnosis that "a policy check's detail states the shop rule that was broken, with the real numbers; treat it as true". It says nothing about other code checks.
- The router's labels have a related gap. `wrongness` in `services/healer/src/routerTraining.ts` walks only the writes the small-model replay made, so a replay that refunds less than the reference is counted wrong, but a replay that refunds nothing where the reference refunded is not. That is deliberate ("asking a question where the strong tier acted is not wrong") and is left to item 1.
- The verdict is shown on the trace page, `web/src/console/pages/Traces.tsx` (the `#verdict` section, using `CheckList`). The policy rules are listed on `web/src/console/pages/Judge.tsx`.

### The change

1. **The judge reads the refund request.** Add a `refund_request` field to `judgeSchema` and one paragraph to `JUDGE_SYSTEM`. The field is null unless the customer, in the latest message read with the conversation, asks for money back. Otherwise it lists each order and the items asked for, by `sku` and quantity, and a `go_ahead` flag that is true when the customer asked for the refund to be made without checking back (for example "please go ahead", "no need to check back", or a plain "refund it to my card"). Tell the judge to leave out any item whose return depends on a condition the customer set, and to list "everything" as every item on the order. This adds a few output tokens to a call that already happens, and no new call.
2. **Code works out what was owed.** Add `amountOwed(before: EnvSnapshot, customerId: string, request)` to `policy.ts`, returning per order: the amount due, whether it must go to a human instead, and one line per item explaining the figure. Generalise `refundableValue` to take the items and quantities to count (the whole order stays the default), keeping its single rounding at the end so $72.51 stays $72.51. An order owes nothing when it is not this customer's, is not delivered, was delivered more than 30 days ago, or already has a refund before this trace. Export the escalation threshold and use it: an amount due above $150 means the right outcome is an escalation, not a refund.
3. **A new code check, `owed:refund`.** In `judge.ts`, after the model call, compare what was owed with what happened, per order in the request. Kind `end_state`, label "The customer got the refund they were owed".
   - Amount due is zero: not applicable. The existing rules already catch any refund that was made.
   - Due between a cent and $150: fail if the refunds this trace made on the order total less than the amount due by more than a cent. If there was no refund, fail only when `go_ahead` is true and the agent did not escalate about the order. Asking the customer to confirm, when they did not say to go ahead, is fine.
   - Due above $150: fail when `go_ahead` is true and the agent neither escalated about the order nor refunded it (a refund is already caught by the escalation rule).
   - The detail states the case with the real numbers, in the same style as the policy rules, because diagnosis and the proposer learn from it. For example: "Priya asked to return everything from PM-1018 and to go ahead. Under shop policy $72.51 was due: pendant shade, opened, 85% of $49.30 = $41.91; brass sundial, final sale, $0.00; 2 x bud vase, $30.60; the shipping fee is never refunded. The agent refunded nothing."
   - If the judge names an item or order that is not in the records, the check is not applied, and the verdict says so.
4. **Record what the judge read.** Add `refundRequest: RefundRequest | null` to `Verdict` in `packages/agent/src/types.ts`, with `RefundRequest = { orders: { orderId: string; items: { sku: string; qty: number }[] }[]; goAhead: boolean }`. It is null when there was no request or the judge was not called. No route changes: verdicts already travel in `TraceDetail` and `GET /api/healer/verdicts`.
5. **Diagnosis uses the amount.** Add one sentence to `DIAGNOSE_SYSTEM`: the owed-refund check's detail states what the customer was due under shop policy, worked out in code from the items the judge read in the request; treat the amount as true and use it as the exact refund amount of an `end_state` check. The eval case then carries the exact amount and needs no judge to replay it.
6. **Console.** On the trace page, under the verdict, show "What the customer asked to refund", read from `refundRequest`, next to the owed-refund check, so the viewer can see the one part that came from a model. On the Judge page, under the policy rules, add one line: "Refunds that are too small, or never made, are checked against what the customer asked for: a model reads the request, and code works out what was owed."

### Known weakness to state in the interface, not to solve

The check is only as good as the judge's reading of the request. If the judge leaves an item out, the amount owed is understated and a short refund can pass; if it adds one, a correct refund can fail. Showing `refundRequest` on the trace page is what makes this visible. Conditional requests are only partly covered: the items that depend on the condition are left out, so in "A return that depends on the amount" the check catches the agent refunding nothing, but not the agent refunding $30.60 and ignoring the condition that should have added the pendant shade.

### Where the code is

| What | File |
|---|---|
| Judge prompt, schema, `judgeTrace`, the new check | `services/healer/src/judge.ts` |
| `refundableValue`, `lineValue`, the escalation threshold, the new `amountOwed` | `services/healer/src/policy.ts` |
| Tests for the above | `services/healer/src/policy.test.ts`, `services/healer/src/loop.test.ts` (scripted judge output) |
| `Verdict`, the new `RefundRequest` | `packages/agent/src/types.ts` |
| Diagnosis prompt | `services/healer/src/diagnose.ts` |
| Seed orders and their numbers (`PM-1018` is the mixed order) | `packages/agent/src/env.ts` |
| Trace page verdict section | `web/src/console/pages/Traces.tsx` |
| Judge page rules list | `web/src/console/pages/Judge.tsx` |

### Done when

- Unit tests for `amountOwed` cover: the whole of `PM-1018` owing $72.51; the two bud vases alone owing $30.60; an order already refunded, outside the window, not yet delivered, or another customer's owing nothing; `PM-1007` owing $189 and needing escalation.
- Unit tests for the check, with a scripted judge (`ScriptedLlm`) returning a request: a refund $12.51 short fails and the detail names both amounts; no refund with `go_ahead` fails; no refund without `go_ahead` passes; an escalation about the order passes; `PM-1007` with no escalation fails; a judge naming an unknown `sku` leaves the check unapplied.
- In a live run with autonomy set to manual (so only the judge spends): fire "A return that depends on the amount" a few times; any trace where the agent refunded nothing fails `owed:refund` with $30.60 due. Fire "Return a whole order with mixed items"; the trace page shows the request the judge read and $72.51 due. Ask a status question as any customer; there is no `owed:refund` check on that verdict.
- With autonomy back on approve, a failed `owed:refund` verdict is diagnosed into an eval case whose `end_state` check carries the exact amount.
- `npm run typecheck`, `npm test`, and `npm run build -w @healer/web` pass, and the known limit about small or missing refunds in `brief.md` section 7 is rewritten to describe the new check and its weakness.

### Cost

Under $1 for the live run with autonomy on manual: a judge call per fired message, and the judge's output grows by a few dozen tokens. Allow about $1 more for the diagnosis step at the end.

### Alternatives considered and set aside

- **Code only: refund at least the whole order's refundable value.** Set aside because partial returns are normal. A customer returning one of three items would fail every time.
- **Ask the judge model whether the refund was right.** Set aside because the arithmetic (discounts, the 85% rule, final sale, the window, the threshold) is exactly what code does reliably and models sometimes get wrong. Splitting the work keeps the model to reading intent.
- **A separate model call to read the request.** Set aside because the judge already sees the whole conversation on every trace, so a field on its output costs nothing extra.
- **Leave it to thumbs-down and hand-written eval cases.** Set aside because simulated customers never rate replies, so most traffic would keep hiding this failure.

---

## 3. Test a new eval case before it joins the suite

**Status:** proposed, not started. The owner agreed it belongs on the roadmap and has not chosen a design.

### Why

Every failure becomes a permanent eval case, written by the diagnosis model, and nothing checks the case before the gate starts trusting it. A case that is wrong in the strict direction is worse than no case. The gate requires at least one of the issue's own cases to pass, so a correct fix is rejected; the loop then retries the proposer (up to three attempts per issue), each attempt chasing a check no correct agent can meet, and the issue stays open. Later, every unrelated proposal also has to live with that case.

This happened twice during the build. Once diagnosis wrote an `end_state` check that misread what "refund" meant (since clarified in `DIAGNOSE_SYSTEM`: the refund field covers only refunds made during the conversation). Once it wrote a rubric demanding itemised amounts in the reply, and a correct tier switch failed its gate until a person edited the check. `brief.md` section 7 lists it as a known limit.

Two questions can be answered before a case is stored. Does it catch the failure it came from? Can an agent that does the right thing pass it? The first is answered in code against the source trace. The second needs a run, but one cheap run against a reference agent that knows every rule is enough to expose a check that demands the impossible.

### Current behaviour

- `diagnoseTrace` in `services/healer/src/diagnose.ts` asks the diagnosis model for an issue and an eval case, prepends `{ id: 'policy', kind: 'invariant' }`, builds the `EvalCase` with the trace's `envBefore`, history and input, and stores it at once with `enabled: true`. The only validation is the zod schema (`CHECK_PARAMS` in `services/healer/src/evals.ts`), which checks shape, not sense.
- `DIAGNOSE_SYSTEM` asks that "each check must pass for any correct handling, not one particular wording, and must not demand behaviour the evidence does not establish". Nothing enforces it.
- `evaluateChecks(h, trace, specs)` in `evals.ts` evaluates any case's checks against any trace. Code checks are free; all rubric checks of a case share one model call (`gradeRubrics` in `judge.ts`).
- `decide` in `services/healer/src/gate.ts` rejects a proposal when "none of the issue's own eval cases passes". The loop in `services/healer/src/loop.ts` retries the proposer while `attempts < MAX_ATTEMPTS` (3) and the surface is not the model, and `previousAttempts` in `propose.ts` feeds the rejected attempts back.
- A person can edit or disable a case with `PATCH /api/healer/evals/:id`. Editing checks calls `store.markChecksEdited`, which stops older eval results for that case being reused.
- Hand-written cases (`POST /api/healer/evals` in `services/healer/src/app.ts`) start from `seedSnapshot()` and are not checked either.
- `hardTierFor(live)` in `services/healer/src/routerTraining.ts` returns `sonnet` when the live tier is `haiku`, otherwise the live tier.

### The change

1. **Check the case against shop policy, in code.** Add `checkConflicts(spec, env, customerId)` to `evals.ts`, using the helpers in `policy.ts`. It returns a reason when an `end_state` check demands something the rules forbid, given the case's own starting records:
   - a refund amount above what the order can refund (from `refundableValue`, which item 2 generalises), or any positive refund on an order that is not this customer's, not delivered, past the 30-day window, or already refunded;
   - a refund amount above $150 (the rule says escalate instead);
   - a refund method that does not match how the order was paid;
   - status `cancelled`, or a new address, on an order that was not processing;
   - an `orderId` that is not in the records.
2. **Check that it catches its failure.** Run `evaluateChecks` on the source trace. If every check passes, the case does not catch the failure it came from. Record that per check: a check that passes on the source trace is not wrong, but the case as a whole should fail there.
3. **Check that a correct agent can pass it.** Run the case twice on a reference agent: the live version with one extra shop note listing every rule from `POLICY_RULES` (label and description), on `hardTierFor(live)`. Grade both trials with `evaluateChecks`. Only reference trials that keep every policy rule count. A diagnosis check that fails on every counting trial is set aside; one that fails on one of two is kept and flagged. The reference note exists only for this test. It never enters a version, and the interface says so, because the brief's point that the agent learns rules only from failed checks must stay true.
4. **Set aside, do not delete.** A check with a policy conflict, or that failed on every reference trial, moves out of `checks` into the case's validation record with its reason. The `policy` invariant is never set aside. A person can put a check back from the Evals page.
5. **Contract.** In `packages/agent/src/types.ts` add `validation: CaseValidation | null` to `EvalCase`, with `CaseValidation = { at: string; referenceTier: Tier; referenceTraceIds: string[]; catchesSource: boolean | null; setAside: { check: EvalCheckSpec; reason: string }[]; flagged: { checkId: string; reason: string }[] }`. `catchesSource` is null for cases with no source trace. Add `'validate'` to `Job['kind']`. In `packages/agent/src/api.ts` add `'POST /api/healer/evals/:id/validate': Route<Job>`, which re-tests any case (a hand-written one, or one a person edited), and let `PATCH /api/healer/evals/:id` accept `validation` so restoring a check can clear it from `setAside`.
6. **Where it runs.** Put the three steps in a `validateCase(h, evalCase, sourceTrace)` function in a new `services/healer/src/validate.ts`, called from `diagnoseTrace` before the case is stored, so the loop never gates against an untested case. It stays inside the diagnose stage: the loop graph keeps its five nodes, matching the concept map. Write one activity line per result, for example "Set aside a check from 'Refund on opened items': it failed on both reference runs (it demanded the reply list every item's amount)".
7. **Console.** On the eval case page (`EvalCasePage` in `web/src/console/pages/Evals.tsx`), add a "Tested before joining the suite" layer: whether the case catches its source failure, the two reference traces as links, each set-aside check with its reason and a "Put back" button, and each flagged check. Add a "Test this case" button that calls the new route. Mark cases with set-aside checks in the suite list. One sentence explains the reference agent: "A stronger model that is shown every shop rule. It is used only to test new cases, never deployed."

### Known weakness to state in the interface, not to solve

Two reference trials can miss a check that is too strict only some of the time, and a rubric is graded by a model, so a rubric check can be set aside because the grader was wrong. The reference agent knows the rules but is still a model, so on the hardest requests it can fail a correct check and get it set aside. That is why one failure in two only flags a check, and why set-aside checks stay visible and can be put back. The conflict check covers only `end_state` checks; tool sequences and rubrics are tested only by the reference runs.

### Where the code is

| What | File |
|---|---|
| Where cases are written and stored | `services/healer/src/diagnose.ts` |
| Check interpreters, `evaluateChecks`, `CHECK_PARAMS`, new `checkConflicts` | `services/healer/src/evals.ts` |
| New `validateCase` | `services/healer/src/validate.ts` (new) |
| Policy helpers and `POLICY_RULES` | `services/healer/src/policy.ts` |
| Reference tier | `hardTierFor` in `services/healer/src/routerTraining.ts` |
| Running one trial on a version | `runTrial` in `services/healer/src/evalRunner.ts` |
| Gate rule about the issue's own cases | `services/healer/src/gate.ts` |
| Retry limit | `MAX_ATTEMPTS` in `services/healer/src/loop.ts` |
| `EvalCase`, `Job`, new `CaseValidation` | `packages/agent/src/types.ts` |
| Routes | `packages/agent/src/api.ts`, `services/healer/src/app.ts` |
| Eval case page and suite list | `web/src/console/pages/Evals.tsx` |

### Done when

- Unit tests for `checkConflicts` cover each conflict above, and a partial refund below the cap raising none.
- Unit tests for `validateCase` with `ScriptedLlm`: a rubric that fails on both reference trials is set aside; one that fails on one is flagged; an `end_state` refund of $66.00 on `PM-1009` is set aside as a conflict (at most $59.40 is refundable); the `policy` check is never set aside; a case whose checks all pass on its source trace has `catchesSource: false`.
- A loop test: a case with a check set aside does not block a proposal that the remaining checks accept.
- In a live run from a factory reset, firing "Refund on opened items" and "Refund long after delivery" produces cases that show the validation layer with both reference traces, and the activity feed shows the result of each test.
- Restoring a set-aside check puts it back in the case and the next gate uses it.
- `npm run typecheck`, `npm test`, and `npm run build -w @healer/web` pass, and the known limit about over-strict checks in `brief.md` section 7 is updated.

### Cost

Each new case adds two agent runs on the reference tier and up to three rubric gradings (one per trial, plus the source trace): roughly $0.05 to $0.15 per case. A live run that diagnoses three or four failures end to end costs about $1 to $3, most of it the proposals and gates that follow.

### Alternatives considered and set aside

- **A model reviews the checks it just wrote.** Set aside because it is the same kind of judgement that wrote the bad check, and it cannot tell whether a correct agent could pass. Running the case can.
- **Probation: a new case does not block the gate until it has passed once.** Set aside because the observed failure was on the issue's own case, which must pass for the fix to be accepted; probation does not help there, and it lets a wrong case linger.
- **Validate only with code checks, no reference run.** Set aside because the second observed failure was a rubric, which code cannot judge.
- **A sixth node in the loop graph.** Set aside because the console's concept map matches the graph one to one, and testing a test belongs to writing it, inside diagnosis.

---

## 4. Run more trials where a rare failure is costly

**Status:** proposed, not started. The owner agreed it belongs on the roadmap and has not chosen a design.

### Why

The gate cannot see a failure that happens one time in five. During the build the small model got a hard request wrong about 20% of the time, and a gate running 2 or 3 trials per case accepted a change that sent that request to the small model. That is "noise mistaken for improvement", which `brief.md` section 3.5 names as a failure mode the demo must guard against.

The arithmetic is unforgiving. A case passes when a majority of its trials pass. With 3 trials and a 20% failure rate, the case fails only when 2 or 3 trials fail, which happens about 10% of the time; 90% of the time the gate calls it a pass. More trials under a majority rule make it worse, not better: with 9 trials a 20% failure rate almost always wins the majority. Majority voting is the right rule for ordinary cases, where it absorbs a model's off moment. It is the wrong rule for a request where one wrong answer moves money.

So two things must change together, and only where it matters: the number of trials and the pass rule. `Settings.trialsPerCase` is one global number, so raising it for everything costs too much.

### Current behaviour

- `Settings` in `packages/agent/src/types.ts` is `{ autonomy, trialsPerCase }`. `DEFAULT_SETTINGS` in `services/healer/src/store.ts` sets `trialsPerCase: 3`. `PUT /api/healer/settings` in `services/healer/src/app.ts` accepts 1 to 9.
- `runSuite` in `services/healer/src/evalRunner.ts` runs every enabled case `trialsPerCase` times, four trials at a time. `caseResult` sets `passed` when `passes * 2 > trials.length`.
- `reusableRun` reuses an earlier run of the same version only when its `trialsPerCase` equals the current setting, and drops results for cases edited since.
- `decide` in `services/healer/src/gate.ts` compares cases by their `passed` flag: a case regressed when it passed on the base and fails on the candidate, and the pass rate is the count of passing cases. Trial-level pass rates are shown, not compared.
- For a routed candidate, `gateProposal` also checks that every enabled case belonging to an issue with cause `capability` is routed to the hard tier. A case the small model fails one time in five may never have been diagnosed as a capability issue, because it passes four times in five, so this check does not cover it.
- The trials setting is `TrialsSetting` on `web/src/console/pages/Gate.tsx`, with the line "More trials separate a real change from run-to-run noise".

### The change

1. **Mark cases that move money as strict.** Add `strict: boolean` to `EvalCase`. Set it in code when a case is created: true when its source trace called `issue_refund` or `cancel_order` (whether or not a guard blocked it), or when any `end_state` check expects a refund amount or status `cancelled`. This is the same idea of high stakes as item 1; if item 1 is built first, share its helper. Diagnosis, hand-written cases and the golden cases (`golden.ts`, where "Clean refund inside the window" and "Cancel an order still processing" become strict) all use it. A person can switch it on the Evals page.
2. **Strict trials only when the model changes.** Add `strictTrials` to `Settings` (default 10, accepted range 3 to 20). In `gateProposal`, when the candidate's `model` differs from the base's (a tier switch or a router), run strict cases `strictTrials` times on both base and candidate, and judge them by the every-trial rule: the case passes only if every trial passes. All other cases, and every gate for a context or harness change, run as today. Context and harness changes alter what the agent knows; model changes alter how reliably it acts, which is where the observed failure came from.
3. **Contract.** Add `rule: 'majority' | 'every'` to `CaseResult` and `strictTrials: number | null` to `EvalRun` (null when the run used no strict trials). `PATCH /api/healer/evals/:id` accepts `strict`. `runSuite` takes a `strict` option; `caseResult` takes the rule.
4. **Stop a strict case at its first failure.** Under the every-trial rule one failure decides the case, so skip its remaining trials. A failing candidate costs little.
5. **Reuse only like with like.** `reusableRun` keeps an earlier result only when it was run under the same rule and, for a strict result, either has `strictTrials` trials or stopped on a failure.
6. **Say what the gate could see.** For each strict case, add a gate reason with the trial count and what it means, computed in code as one minus (0.8 to the power of the trial count). For example: "Strict: 'Three returns in one message' passed 10 of 10 trials on version 7. A request that fails 1 time in 5 would show at least one failure in 10 trials 89% of the time." On a failure, say which trial failed and why, as `failingDetail` does today.
7. **Console.** In `TrialsSetting`, add the strict trials input with a live line: "With N trials, a request that fails 1 time in 5 is caught X% of the time. Used only for cases that move money, and only when a change switches the model." Show a "strict" tag on cases in the Evals list and on the gate run page, and the every-trial rule next to their trial squares.

### Known weakness to state in the interface, not to solve

Ten trials still miss a 1-in-5 failure about 11% of the time, and the rarer error measured during the build, about 1 in 17 on three orders in one message, is caught only about 45% of the time. A gate cannot prove a rare failure absent; it can only make it unlikely at a stated cost. If the base version itself fails a strict trial, that case counts as failing on the base and cannot regress, so the gate cannot use it; the reasons should say so rather than stay silent. Gates for context and harness changes still use the majority rule, so a prompt change that makes refunds flaky can slip through.

### Where the code is

| What | File |
|---|---|
| Trials per case, pass rule, reuse | `services/healer/src/evalRunner.ts` |
| Gate decision, reasons, the routing check | `services/healer/src/gate.ts` |
| `Settings`, `EvalCase`, `CaseResult`, `EvalRun` | `packages/agent/src/types.ts` |
| Default settings | `services/healer/src/store.ts` |
| Settings and eval case routes | `services/healer/src/app.ts`, `packages/agent/src/api.ts` |
| Where cases are created | `services/healer/src/diagnose.ts`, `services/healer/src/golden.ts`, `POST /api/healer/evals` in `app.ts` |
| Tests | `services/healer/src/gate.test.ts`, `services/healer/src/evals.test.ts` |
| Trials setting, gate run page | `web/src/console/pages/Gate.tsx` |
| Eval suite and case pages | `web/src/console/pages/Evals.tsx` |

### Done when

- Unit tests: a strict case with 9 of 10 trials passing fails and regresses against a base that passed 10 of 10; a strict case stops after its first failed trial; a context-only proposal runs strict cases with ordinary trials; `reusableRun` does not reuse a majority result for a strict gate; the high-stakes rule marks the two golden cases above strict and the status question not.
- A gate test with scripted runs where the small model fails one trial in five on a strict case: the old rule accepts, the new rule rejects, and the reason states the 89%.
- In a live run, a tier switch down to haiku (proposed by hand) with "Three returns in one message" in the suite as a strict case runs it 10 times on each side, and the gate run page shows the strict tag, the trials and the sentence about what the gate could see.
- `npm run typecheck`, `npm test`, and `npm run build -w @healer/web` pass, and `brief.md` (section 3.5 on noise, and the known limit in section 7) describes strict cases.

### Cost

About $2 to $5 for the live run. A model-change gate with half a dozen strict cases adds about 60 trials per side, most of them cheap code-checked runs; the base side is reused across gates of the same live version. Keep `trialsPerCase` at 2 while iterating.

### Alternatives considered and set aside

- **Raise `trialsPerCase` for everything.** Set aside because under a majority rule more trials do not reveal a 1-in-5 failure, and the cost grows with every case in the suite.
- **Compare trial pass rates statistically between base and candidate.** Set aside for now because a test with a few dozen trials has little power against a 20% rate and is hard to explain on screen. The every-trial rule and a stated detection chance teach the same point plainly.
- **Strict trials on every gate.** Set aside because most gates change context or harness and would pay several times more for little gain. Worth revisiting if a prompt change is ever seen to make refunds flaky.
- **Rely on the routing check.** Set aside because it covers only cases already diagnosed as capability, and a 1-in-5 failure often is not.

---

## 5. Restore a seeded case's orders before firing it

**Status:** proposed, not started. The owner agreed it belongs on the roadmap and has not chosen a design.

### Why

Seeded cases exist so each concept can be reproduced on demand (`brief.md` section 4.3). They are sent through the live shop, and so is all other traffic: the viewer's chats, simulated customers, and earlier seeded cases all refund, cancel and re-address the same orders. After some traffic, a seeded case no longer starts from the state its `teaches` line describes. "Refund on opened items" expects $59.40 to be due on `PM-1009`; after a simulated customer has been refunded on that order, the case shows the one-refund rule instead. "Cancel an order already shipped" means nothing once `PM-1013` has been cancelled. `brief.md` section 7 lists it as a known limit, and the Traffic panel already warns about it.

Today the only cure is a factory reset, which also wipes every version, issue, proposal and eval case the viewer has built up. The fix is narrow: each seeded case names the orders it depends on, and firing it puts those orders back first.

### Current behaviour

- `SEEDED_CASES` in `services/healer/src/seeds.ts` are `{ id, title, teaches, customerId, messages }` (type `SeededCase` in `packages/agent/src/types.ts`). They name their orders only inside the message text, mostly through `NOTABLE_ORDERS` in `packages/agent/src/env.ts`, and two by literal id (`PM-1017`, `PM-1019`).
- `startFireJob` sends the messages through `h.shop.chat` with `source: 'seed'`, exactly as the shop front does. The shop (`POST /api/shop/chat` in `services/shop/src/app.ts`) runs the agent on its stored records and saves `trace.envAfter` as the new records.
- Simulated customers (`services/healer/src/simulate.ts`) read the live records and pick orders that suit their intent, so they adapt to drift and are not part of this problem.
- Eval cases are not affected: each carries its own records in `EvalCase.env` and runs in a sandbox.
- The only way back is `POST /api/shop/reset`, which restores `seedSnapshot()`, clears threads and events, redeploys the factory version and emits a `reset` event; the healer answers that event with a full wipe (`resetLocal` in `services/healer/src/app.ts`, called from `handleShopEvent` in `services/healer/src/shopLink.ts`).
- `Environment.addRefund` and `addEscalation` in `packages/agent/src/env.ts` number new records from the count of existing ones (`RF-` and `ESC-` plus count plus one). That is safe today because records are never removed. Once a restore removes a refund, the next one can reuse an id that already exists, and `envChanges` in `policy.ts`, which finds new refunds by id, would not see it.
- The seed picker and its warning ("Each case behaves as described on fresh shop data...") are in `TrafficPanel` in `web/src/console/pages/Home.tsx`.

### The change

1. **Name the orders.** Add `orderIds: string[]` to `SeededCase` and fill it for every case: `late_refund` `PM-1002`; `large_refund` `PM-1007`; `opened_item` `PM-1009`; `final_sale` `PM-1011`; `cancel_shipped` `PM-1013`; `address_shipped` `PM-1017`; `other_customers_order` `PM-1014`; `second_refund` `PM-1006`; `store_credit_to_card` `PM-1016`; `multi_rule` and `conditional_return` `PM-1018`; `three_orders` `PM-1018`, `PM-1007`, `PM-1003`; `preference_stated` `PM-1015`; `preference_later` `PM-1019`.
2. **Fix record numbering first.** In `Environment`, number a new refund or escalation from the highest existing number plus one, not the count. Add a test that removes a refund and checks the next id is new.
3. **A restore route in the shop.** Add `'POST /api/shop/env/restore': Route<Ok, { orderIds: string[] }>` to `ShopApi` in `packages/agent/src/api.ts`. For each id, the shop replaces the order with its record from `seedSnapshot()` and replaces that order's refunds and escalations with the seed's (for `PM-1006`, the original `RF-0001` stays). It runs inside the shop's `serialised` queue, so it never interleaves with a chat, and leaves threads, events and the deployment alone. It emits no event, so the healer does not mistake it for a reset. The route is generic ("put these orders back to their starting records"), so the shop still knows nothing about the healer. Add `restore(orderIds)` to `ShopClient` in `shopLink.ts` and to `FakeShop` in `testing.ts`.
4. **Fire restores what drifted.** Add `seedDrift(env, seed)` to `seeds.ts`, comparing the live records with `seedSnapshot()` for the case's orders and returning one plain line per difference ("PM-1009 has a refund RF-0004 of $22.00 that was not there at the start"). `startFireJob` reads `h.shop.env()`, and if anything drifted, restores those orders before the first message and writes an activity line naming what was undone.
5. **Show drift before firing.** Add `'GET /api/healer/seeds/drift': Route<Record<string, string[]>>` (seed id to differences), kept separate from `GET /api/healer/seeds` so the picker still loads when the shop is down. In `TrafficPanel`, under the chosen case, show its differences and "These orders will be put back to their starting records when you fire it". Replace the current warning, which recommends a factory reset, with one sentence: "Firing a case first puts its orders back as they were at the start; nothing else changes."

### Known weakness to state in the interface, not to solve

Restoring undoes real changes on those orders, including a refund the viewer obtained by chatting in the shop, and the activity line is the only record of it. There is a short window between the restore and the case's first message in which a simulated customer running at the same moment could change the order again. The restore covers only the orders a case names: a case whose behaviour depends on another of the customer's orders (for example the agent listing all of Priya's orders) can still differ.

### Where the code is

| What | File |
|---|---|
| Seeded cases and firing | `services/healer/src/seeds.ts` |
| `SeededCase` | `packages/agent/src/types.ts` |
| Shop contract, healer route types | `packages/agent/src/api.ts` |
| Seed records, `NOTABLE_ORDERS`, record numbering | `packages/agent/src/env.ts` |
| Restore route, the `serialised` queue | `services/shop/src/app.ts` |
| Shop client and fake | `services/healer/src/shopLink.ts`, `services/healer/src/testing.ts` |
| Drift route | `services/healer/src/app.ts` |
| How new refunds are detected | `envChanges` in `services/healer/src/policy.ts` |
| Traffic panel | `web/src/console/pages/Home.tsx` |
| Tests | `packages/agent/src/tools.test.ts` (numbering), `services/shop/src/app.test.ts` (restore), `services/healer/src/traffic.test.ts` (fire restores) |

### Done when

- Unit tests: numbering after a removal; the shop restore puts back an order's status, address, refunds and escalations and leaves other orders, threads and the deployment alone; `seedDrift` reports nothing on fresh records and one line per change after a refund, a cancellation and an address change; firing a drifted case calls restore before chat, and firing a clean one does not.
- In a live run with autonomy on manual: fire "Refund on opened items", then fire it again. The second time the Traffic panel shows the refund from the first run as drift, firing restores it, and the new trace's `envBefore` shows `PM-1009` with no refunds. Versions, issues and eval cases are unchanged.
- `npm run typecheck`, `npm test`, and `npm run build -w @healer/web` pass, and the known limit about seeded cases in `brief.md` section 7 is updated.

### Cost

Under $0.50: two or three fired seeded cases with their judge calls. The restore itself makes no model call.

### Alternatives considered and set aside

- **Fire seeded cases in a sandbox.** Set aside because seeded cases are meant to arrive as traffic through the shop, like any customer, and to go through the loop from a real trace.
- **A data-only reset of every order.** Set aside as the main fix because it also undoes the viewer's own chats on unrelated orders, but the same route without `orderIds` could offer it later.
- **Pick a fresh order that matches the case.** Set aside because most cases depend on one specific order (the only opened item, the only final-sale item), and the `teaches` lines quote exact amounts.
- **Warn only.** Set aside because the warning already exists and the cure it offers, a factory reset, throws away the viewer's progress.

---

## Defects to fix

Found on 2026-11-13 while performing the full walkthrough in `demo-beats.md` against live models. These are smaller than the items above, so each is written as: what happens, how to see it, where the code is, and a suggested fix. The suggested fix is a starting point, not a decision.

### A failure that also states a preference is never diagnosed

- **What happens.** When one customer message both breaks a shop rule and states a personal preference, the judge files a customer-scope preference issue that holds the trace. The loop then treats that trace as already filed and skips diagnosis. No shop-scope issue and no eval case are written, so the shop rule is learned as a note for one customer only, and the ratchet gains nothing.
- **How to see it.** In automatic mode, fire the seeded case "New address for a shipped order". On the verified run it produced only the customer note "Remember Lena's new address and only apply it to orders still processing".
- **Where.** The judge branch of the loop in `services/healer/src/loop.ts`, and `undiagnosed()` in `services/healer/src/diagnose.ts`. The preference issue is created in `services/healer/src/judge.ts`.
- **Suggested fix.** Decide "already filed" per kind of issue. A preference issue must not stop a failed verdict on the same trace from being diagnosed. Add a loop test with a failed verdict that also carries a preference.

### A rejected proposal cannot be gated again

- **What happens.** On a rejected proposal the "Run the gate" button stays enabled, but the server answers that only a draft can be gated. When the gate rejected a good fix because diagnosis wrote a check that was too strict, the viewer can edit the check but cannot re-run the gate. They must write the same proposal again by hand.
- **How to see it.** Open any rejected proposal and press "Run the gate".
- **Where.** `web/src/console/pages/Propose.tsx` for the button, and the `POST /api/healer/proposals/:id/gate` route in `services/healer/src/app.ts`.
- **Suggested fix.** Disable the button unless the proposal is a draft. Add a "Propose again" action on a rejected proposal that creates a new draft with the same changes on the current live version. This pairs with roadmap item 3.

### Approving one queued proposal strands the others

- **What happens.** Several proposals can wait in the approval queue, all gated against the same live version. Approving one makes a new live version, and the rest remain in the queue marked as gated against a version that is no longer live. They can only be discarded. Nothing gates them again.
- **How to see it.** In approve mode, let two issues reach the approval queue, then approve one.
- **Where.** Proposal status handling in `services/healer/src/promote.ts` and `services/healer/src/gate.ts`, and the queue on `web/src/console/pages/Propose.tsx`.
- **Suggested fix.** When a version is promoted, move the other waiting proposals back to draft, rebuilt on the new live version, and in approve or automatic mode queue their gates again. Say in the activity feed that this happened.

### Running the suite can silently do nothing

- **What happens.** "Run the suite on this version" reuses an earlier run when one already covers every enabled case. The job finishes in a few milliseconds with no new row and no message, so it looks broken.
- **How to see it.** Run the suite on a version twice in a row.
- **Where.** `reusableRun` in `services/healer/src/evalRunner.ts`, the `POST /api/healer/evals/run` route in `services/healer/src/app.ts`, and `web/src/console/pages/Evals.tsx`.
- **Suggested fix.** Reuse is right for the gate, where it saves money. For a run the viewer asked for by hand, either always run fresh, or say plainly that the earlier run was reused and offer to run again anyway.

### A saved preference can ask the agent to break policy

- **What happens.** The judge records what a customer says they prefer, and the loop turns it into a customer note. On an exploratory run it saved "Prefers refunds to a bank card rather than store credit" for a customer whose order was paid with store credit. A later probe showed the agent refunding that order to a card, which breaks the refund-method rule. A customer note has no eval case of its own, so its gate only checks for regressions and let it through.
- **How to see it.** As a customer with a store-credit order, say you always want refunds on your card, let the note deploy, then ask for a refund.
- **Where.** The preference extraction in `services/healer/src/judge.ts`, and how preference issues become proposals in `services/healer/src/propose.ts`.
- **Suggested fix.** Tell the judge to record only facts and preferences the shop is free to honour, and to leave out requests about money, eligibility or exceptions. Consider writing one eval case with each customer note, run as that customer with an `invariant` check, so the gate can see a note that leads to a rule being broken.

### Simulated customers contradict what the agent has learned about them

- **What happens.** The simulator does not know a customer's saved notes. After a customer asked to be called Annie, a simulated message from the same customer said "My name is Ava Thompson, not Annie", which created a contradicting preference. Notes pile up and conflict, which is the "memory rot" failure in `brief.md` section 3.5.
- **How to see it.** Save a preference for a customer, then send a batch of simulated customers.
- **Where.** `services/healer/src/simulate.ts`, and note handling in `services/healer/src/propose.ts`.
- **Suggested fix.** Two parts, and either helps alone. Give the simulator the customer's current notes so it stays in character. When a new preference conflicts with an existing note for the same customer, have the proposer edit or remove the old note instead of adding a second one. `Change` already has `edit` and `remove` operations for context.

### Diagnosis can call a missing rule a capability gap

- **What happens.** On an exploratory run, refunds issued on orders that had not been delivered were diagnosed as a capability gap, although no note in context stated the rule. The loop proposed moving the agent to Sonnet. The gate rejected it, because the case still failed and cost per task rose about seventeenfold, so the ratchet held. But the real fix, a context note, was never proposed.
- **How to see it.** Not dependable. It depends on the diagnosis model's reading.
- **Where.** The diagnosis prompt in `services/healer/src/diagnose.ts`.
- **Suggested fix.** Before accepting `capability`, check in code or in the prompt that a note or instruction in the live version actually covers the rule named by the failed check. If none does, the cause is `knowledge`. When a model-surface proposal is rejected because its own case still fails, send the issue back to diagnosis instead of retrying the same surface.

### Small interface points

- The table on the Run page is wider than a narrow window, so the Verdict column needs sideways scrolling.
- Changes to settings are logged in the activity feed under the "Propose" stage, which is misleading.
- The shop runs on a fixed date (2026-11-11) while the console shows real clock times, which can confuse a first-time viewer. `demo-beats.md` explains it; the console could too.
- The agent sometimes promises memory it does not have ("I'll call you Annie from now on") before any note exists, and the judge does not flag it. `demo-beats.md` uses this as a teaching point.

---

## Done

Nothing yet.
