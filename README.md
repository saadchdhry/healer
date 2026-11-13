# Healer

Healer is a demo that runs on your own machine and shows how a self-improving AI agent works. A support agent for a fictional shop answers customers, while a learning loop judges every conversation, works out what went wrong, proposes a change to the agent, and keeps the change only if a growing set of tests still passes. The shop front is the product, and the console shows everything happening under the hood.

## Requirements

- Node 26 and npm
- An Anthropic API key

## Set up

Create your `.env` file from the example, then put your key in it as `ANTHROPIC_API_KEY`:

```bash
cp .env.example .env
```

Install dependencies:

```bash
npm install
```

## Run

```bash
npm run dev
```

This starts the shop service, the healer service, and the web app.

- Shop front: http://localhost:3000
- Console: http://localhost:3000/console

Every model call is live and billed to your key. The console shows the running spend.

## Reset

Press "Reset to factory" on the console's home page. It restores the shop's orders, clears all history, and puts version 0 of the agent back in the shop.

## Checks

Neither needs an API key.

```bash
npm run typecheck
```

```bash
npm test
```

## Layout

| Folder | What it holds |
|---|---|
| `packages/agent` | The shared contract, the graph runner, the support agent, and its tools |
| `services/shop` | The shop's backend, which runs the agent for customers |
| `services/healer` | The learning loop: judge, diagnose, propose, gate, promote |
| `web` | The shop front and the console |

## Where to go next

- [demo-beats.md](demo-beats.md): a step-by-step walkthrough of the whole demo.
- [brief.md](brief.md): the idea behind the project and how it was designed.
- [roadmap.md](roadmap.md): planned improvements.
