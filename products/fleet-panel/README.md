# @titan-design/fleet-panel

A Claude Code mod that docks a pane of the running agent-chat agents beside the chat: one
row per agent with its status, model, account, task and PR, last `Status:` report, context
fill and session spend, under a strip of per-account 5h and 7d usage and the slot count.

Tier product of the titan-platform DAG. It imports no other package.

## How it works

Two halves, so the mod stays thin and everything else is plain, tested Node:

- **`titan-fleet-feed`** (`src/bin.ts`) reads agent-chat and prints one JSON snapshot per
  line. It reads `agent-chat agent ls --json` (roster), `agent-chat agent budget --accounts
  --json` (account usage), the broker's `/health` (slots), each session's status-cache file
  (context fill and $) and follows `/events` (Status reports, spawn tasks). A pushed event
  starts a reconcile within a second; a poll reconciles every 15 s regardless.
- **The mod** (`src/mod/register.tsx`, built to `plugin/hooks/register.js`) adds `/fleet`,
  which starts the feed and opens the pane, and redraws on every snapshot.

Every reading keeps the time it was taken, and the pane ages it against its own clock: a
status-line reading older than two minutes is dimmed, an account reading the budget reader
calls stale shows `STALE <age>` instead of a figure, and a feed that has printed nothing
for a minute says `feed quiet`. A source that fails keeps its last value and says how old
it is. Headless agents draw no status line, so their spend shows `—` until the drill-in
slice prices their transcripts.

## Install (owner's machine)

```sh
pnpm install --frozen-lockfile && pnpm build
ln -s "$PWD/products/fleet-panel/dist/bin.js" ~/.local/bin/titan-fleet-feed
claude --plugin-dir "$PWD/products/fleet-panel/plugin"
```

Then run `/fleet`. `titan-fleet-feed --demo` (or `TITAN_FLEET_DEMO=1`) draws synthetic
agents with no broker, for reviewing the layout.

## Tests

`pnpm vitest run products/fleet-panel` covers the shaping. `claude plugin test
products/fleet-panel/plugin` (after `pnpm build`) runs the mod against Claude Code's
engine: the pane's text on the terminal and desktop surfaces, and the stopped-feed message.
