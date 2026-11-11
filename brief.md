# Healer: product brief

Status: draft 3 (2026-11-11). Live Claude model confirmed. The model surface is shown two ways: switching the main model, and really training a small local classifier. Three decisions still open in section 5.

## Summary

- **What it is.** A localhost demo where a small support agent visibly gets better as it is used, with every step of the learning loop on screen.
- **The idea it teaches.** An agent improves by changing one of three things (context, harness, model), and a growing set of evals decides which changes are kept.
- **How it runs.** Live Claude models. The agent starts on the smallest tier. A fixed, stronger model judges, diagnoses, and proposes fixes.
- **The model surface.** Shown twice: a simulated version (moving the agent up a model tier) and a real one (training a small local router on the demo's own traces).
- **Still to decide.** The scenario, guided tour or sandbox, and how deep the graph view goes (section 5).

## 1. Purpose

A small demo that runs on localhost and makes the idea of a self-improving agent easy to see and understand. The viewer should be able to watch an agent fail, watch the system learn from the failure, and see proof that it got better without getting worse elsewhere.

Success test: someone who has never built an agent can use the demo for ten minutes and then explain, in their own words, what a self-learning loop is, what can change inside an agent, and why evals are what make the change safe.

## 2. Source framework

From "How to Build Agents That Improve Over Time: Model, Harness, Context" (Harrison Chase, LangChain, Interrupt London, published 2026-10-27).

**An agent has three parts, and each one can improve.**

| Part | What it is | How it improves | Cost and speed | Who triggers it today |
|---|---|---|---|---|
| Model | The reasoning engine, plus smaller models at the edges (guardrails, judges) | Update weights. Supervised fine-tuning on good traces for narrow tasks. Reinforcement learning (tasks → rollouts → score → update) for complex ones | Expensive, slow | A human, almost always |
| Harness | The system around the model: what it sees, how actions run, verification, persistence, loop control | Change code, prompts, or tools | Medium. Affects every user | A background agent proposes, a human reviews |
| Context | Text and knowledge: memory, notes, skills, files | Rewrite text | Cheap, instant. Can be scoped per user, per org, or agent-wide | Can run in the background |

**Three levels of autonomy.** Manual (an engineer drives the cycle), human in the loop (a background process proposes, a human approves), fully automated (the stated North Star, not here yet).

**Two foundations under every loop.**

- Traces: the exact inputs, outputs, and sequence of every step. Vocabulary: run (one model or tool call) → trace (one task) → thread (one conversation). Agent failures are semantic, so they show up in traces and not in ordinary logs.
- Evals: the definition of what good looks like ("the new PRD"). Three hard parts: realistic inputs (which come from traces), defining good (exact match, or criteria applied to the final answer, the end state of the environment, or the sequence of tool calls), and a simulated environment so evals never touch production.

**Finding mistakes.** From production traces (reactive), from domain experts (manual), or by red teaming (proactive). There is no universal judge of correctness. One workaround: ask the same question two ways, and if the answers disagree, one of them is wrong.

**The flywheel.** Run the agent → get feedback (human or online judge) → inspect the trace → add the case as an eval data point → propose a change to model, harness, or context → confirm no regression → repeat.

**Hardest part, per the talk.** Choosing what to remember, what not to remember, and how to remember it.

## 3. How we think about it

This section is our synthesis. It builds on the talk and adds pieces the talk only gestures at.

![Self-learning loop framework](docs/self-learning-loop.svg)

### 3.1 One sentence

A self-improving agent is an agent plus a ratchet: every failure becomes a permanent test, and a change is only kept if it passes every test collected so far. Without the ratchet it is self-modification, not self-improvement.

### 3.2 Five questions every learning loop must answer

| Question | Mechanism | Stage in the loop |
|---|---|---|
| What happened? | Traces | Run |
| Was it good? | Feedback, judges, environment checks | Judge |
| Why did it go wrong, and which part is at fault? | Diagnosis (credit assignment) | Diagnose |
| What do we change, and for whom? | A surface (context, harness, model) and a scope (one user, one org, everyone) | Propose |
| How do we know it is better, and who signs off? | The eval gate and the autonomy dial | Gate, then promote |

### 3.3 The training analogy

A self-learning loop is training without touching the weights. Traces are the data. Evals are the loss function and the validation set. Diagnosis is the gradient. The proposed change is the update. Autonomy is the learning rate. The three surfaces are three groups of parameters with very different learning rates.

### 3.4 Loops nested by timescale

| Loop | Where the lesson lives | Persists? | Typical cadence |
|---|---|---|---|
| Self-correction inside one run (retry, reflect) | Nowhere | No. This is not learning, though it is often mistaken for it | Seconds |
| Context loop | Memory and notes | Yes, per scope | Minutes |
| Harness loop | Prompts, tools, code | Yes, for everyone | Days |
| Model loop | Weights | Yes, for everyone | Weeks |

Working rule (ours, not the talk's): fix at the cheapest surface that solves the problem, and escalate only when the same pattern keeps recurring.

### 3.5 What goes wrong

These are the nuances the demo should let the viewer trigger on purpose.

- Regression: a fix for one case breaks three others. The gate must catch it.
- Wrong diagnosis: the lesson is filed against the wrong surface or the wrong scope (a personal preference saved as a global rule).
- Memory rot: lessons pile up, contradict each other, or go stale.
- Unreliable judge: the judge is a model too, and can be wrong.
- Teaching to the test: the agent passes the evals and still fails real users.
- Noise mistaken for improvement: model output varies between runs, so a change only counts if it beats run-to-run variation. Each eval case runs several times and the gate compares pass rates.

## 4. Demo concept (proposed)

**Shape.** A single page with three areas.

1. The agent at work: a chat with a small agent operating inside a simulated environment.
2. The loop: a live graph (run → judge → diagnose → propose → gate → promote) whose nodes light up as each stage happens, with the trace for the current run one click away.
3. The agent's anatomy: the three surfaces with version history and diffs, the eval suite as a scoreboard that grows, and a chart of pass rate per agent version.

**Recommended scenario.** A support agent for a fictional online shop, working against a mock order database that resets for every eval run. It starts deliberately under-informed and on the smallest model tier, so its failures have three distinct causes that the loop must tell apart: missing knowledge (fix the context), loose process (fix the harness), and not enough capability (change the model).

**Models.** The Claude roles call the live API. The router runs locally.

| Role | Model | Why |
|---|---|---|
| The agent being improved | Starts on Claude Haiku 5.5 (`claude-haiku-5-5`). The loop can move it to Claude Sonnet 5.5 (`claude-sonnet-5-5`), then Claude Opus 5.5 (`claude-opus-5-5`) | Tiers differ visibly in capability and in price, so both the gain and its cost show up on the scoreboard |
| Judge, diagnosis, proposal | Claude Opus 5.5, fixed | The teacher should be stronger than the student, and the judge must not change between versions or scores stop being comparable |
| Router | A small classifier trained locally on the demo's own traces | Decides per request whether the small model is enough. The only place where weights really change |

**How the model surface is shown.** Two mechanisms, one simulated and one real.

*Simulated: switching the main model.* Claude itself cannot be fine-tuned inside this demo, so a move up the tier ladder stands in for "the weights got better".

- Tiers, not adjacent versions. Two neighbouring versions of a top model would both pass a small eval suite, so the improvement would be invisible.
- The loop proposes the switch. Diagnosis must first classify a failure as a capability gap, meaning the trace shows the agent had the right knowledge and instructions and still got it wrong. The gate then shows pass rate next to cost per task.
- A manual model picker is also available for free play, so the viewer can try any tier and watch the scoreboard move.

*Real: training a small local classifier.* Moving every request to a bigger model fixes the hard cases and overpays for the easy ones. A small router decides, per request, whether the small model is enough. It is trained on the demo's own traces, which makes it a genuine case of supervised fine-tuning at toy scale.

- Training data: past runs labelled by whether the small model passed. The labels come for free from eval runs the gate already performs on both tiers.
- The model: a bag-of-words classifier that trains in under a second on a few dozen examples. The viewer sees the training set, the loss curve, accuracy on held-out cases, and a new weights version.
- The gate applies to weights too. A router that sends hard cases to the small model lowers the pass rate and is rejected. A good one holds the pass rate and cuts cost per task.
- A "generate traffic" control has Claude write realistic customer messages to grow the training set.

Build risks:

- The hard eval cases that separate the tiers must be found by experiment. If the smallest model passes everything, the cases get harder or the ladder starts from an older model.
- With only a few dozen examples the router will be rough. That is acceptable as long as the gate keeps bad versions out and the screen says the scale is a toy.

Guided storyline, each step one click:

| Step | What the viewer sees | Concept it teaches |
|---|---|---|
| 1 | Agent refunds an order that is outside the refund window | Failure detected by checking the end state of the environment |
| 2 | The trace is opened and the failure is diagnosed as a knowledge gap | Traces, diagnosis |
| 3 | A policy note is added to shared context, and the case becomes an eval | Context learning at org scope, the eval suite growing |
| 4 | The viewer states a personal preference, and it is saved for them only | Context learning at user scope |
| 5 | Several traces show refunds issued without looking up the order first. They are clustered into one issue and a prompt or tool change is proposed as a diff | Harness learning, tool-sequence criteria, human approval |
| 6 | An over-broad fix is proposed and the gate rejects it because older evals now fail | The ratchet, regression |
| 7 | A hard case keeps failing even though the trace shows the agent had the right knowledge and instructions. It is diagnosed as a capability gap, a move to the next model tier is proposed, and the gate shows pass rate against cost per task | The model as a surface, telling causes apart, the price of the most expensive lever |
| 8 | The router is trained on labelled traces, so easy requests go back to the small model. Cost per task drops while the pass rate holds | Real supervised fine-tuning at toy scale, traces as training data, held-out validation |
| 9 | The same question is asked two ways and the answers disagree | Red teaming without a universal judge |
| 10 | The autonomy dial is turned from manual to approve to automatic, and the loop runs on its own | Autonomy levels, the North Star |

**Concept coverage.** Model, harness, context. User, org, and global scope. Runs, traces, threads. Human feedback and online judge. Exact match and criteria evals on answer, end state, and tool sequence. Simulated environment. Issue clustering. Regression gate. Versioning and rollback. Red teaming by consistency probe. Three autonomy levels.

## 5. Decisions

### Settled

- **Live model.** The agent and the loop run on live Claude models. The API key is supplied by the owner in a local `.env` file that is never committed.
- **Model surface.** Both mechanisms are in. Switching the main model across tiers is the simulated improvement, proposed by the loop and also available as a manual picker. Training a small local classifier on traces is the real improvement.

### Awaiting confirmation

- **The classifier's job.** Proposed: a router that decides per request whether the small model is enough. This gives the classifier a real role and ties it to model switching. Alternative: an intent classifier (refund, order status, complaint) that is independent of model tiers, which is simpler but does not change the agent's results.

### Open

Each has a recommended default. Nothing gets built until these are settled.

1. **Scenario.** Recommended: the support agent above, because it has write actions, policies, and personal preferences, which together exercise every eval type and every scope. Alternative: a data analyst over a small database (closer to the Hex example in the talk), where answers are numbers and easy to check but there are no write actions.
2. **Guided tour or sandbox?** Recommended: both. A guided storyline for first understanding, then free play.
3. **Depth of the graph view.** Is the goal to see the loop as a concept, or also to see it as an executable graph of nodes and edges (in the style of LangGraph) whose code is readable as a teaching artifact?

## 6. Out of scope

- Fine-tuning or reinforcement learning of the Claude models themselves. Real training happens only on the small local router.
- Multi-user accounts, authentication, deployment.
- Production-grade observability. Traces live in a local file or local database.

## 7. Change log

- 2026-11-11: Draft 1. Source framework captured from the talk, thinking framework proposed, demo concept and open decisions drafted.
- 2026-11-11: Draft 2. Live Claude model confirmed. Model surface changed from a trained local classifier to a model switch, with a tier ladder, a loop-driven switch, and a visible training set proposed. Model roles added. Storyline grew to ten steps.
- 2026-11-11: Draft 3. Small local classifier restored as a trained router alongside model switching. Manual model picker added. Summary added at the top. Framework diagram saved to `docs/self-learning-loop.svg` and embedded in section 3.
