# Healer

Healer is a small demo, run on your own machine, that shows how a self-improving AI agent works. A support agent for a fictional shop answers customers, and a learning loop watches every conversation, judges it, works out what went wrong, proposes a fix to the agent's context, harness or model, and keeps the fix only if a growing eval suite still passes. The shop front is the product; the console shows everything happening under the hood.

The idea behind it is written up in [brief.md](brief.md).

## Prerequisites

- Node 26 and npm
- An Anthropic API key

## Set up

Put your key in a `.env` file at the repo root:

```
ANTHROPIC_API_KEY=your-key-here
```

Then install and start everything with one command:

```
npm install
npm run dev
```

This starts three processes: the shop service, the healer service and the web app.

- Shop front: http://localhost:3000
- Console: http://localhost:3000/console

Without a key the pages still open, but the agent and the loop cannot call a model, and the console says so.

## Things to try first

- In the shop front, pick a customer, ask about an order and rate the reply. Then open the Run block in the console and follow the trace.
- On the console map, fire the seeded case "Refund long after delivery" and watch the loop judge, diagnose, propose and gate a fix. Approve it from the Propose page.
- On the Propose page, write an over-broad note by hand (for example "Never issue refunds") and run its gate to see the ratchet reject it.
- Send a few simulated customers or a red team probe from the Traffic panel.
- Switch autonomy between Manual, Approve and Automatic and fire another seeded case.

## What it costs

Every model call is live and the console's spend meter (bottom left) shows the running total. Rough figures:

- A shop message: well under a cent on the smallest tier, plus about a cent for the judge.
- One full fix (judge, diagnose, propose and gate): about 20 to 25 cents with 2 trials per eval case.
- 5 simulated customers and 1 red team probe, judged: about 10 cents.

A typical first session of chatting, a couple of fixes and some simulated traffic costs under a dollar. Lower "Trials per eval case" on the Gate page to spend less; moving the agent to Sonnet or Opus raises the cost of every reply.

## Reset

Press "Reset to factory" on the console map. It restores the shop's orders, clears all history and puts version 0 back live. Seeded cases behave as described only on fresh shop data, so reset if one plays out differently than expected.
