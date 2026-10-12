---
name: session-insights
description: "Use when answering a question about agent sessions (cost, handoffs, cache, wakes, guardrails) for a session, a seat or a window, such as a daily autonomy retro. Checks data quality and prices first, hands compact JSON to a read-only analyst, and keeps only findings whose citations re-run."
---

# Session insights

Turn `titan-miner insights` answers into findings an owner can act on. Every number in a
finding comes from a re-runnable command, and the loop fails closed: a stale graph or a price
mismatch stops it before any analysis.

Run the steps in order. Write every answer to a scratch directory outside any public repo as
`--json` output; the analyst reads those files and nothing else.

## Step 1: resolve the scope

Decide which sessions the question is about, and express it as insight filters.

- One or more sessions: `--session <id>` (repeatable).
- A family of agents: `--agent-prefix <prefix>`.
- A window: `--since <time>` (inclusive) and `--until <time>` (exclusive).
- A seat since a time: run `titan-miner insights seat-generations --seat <name> --since <time> --json`
  and use its `sessionArgs` string as the `--session` flags for the graph questions.

Use the same filters in every later step, so the answers describe the same sessions.

## Step 2: data quality

Run `titan-miner insights data-quality <filters> --json`. Add `--assignments <file>` when the
question touches outcomes.

- For each fault, file one session-insights task with the fault's `suggestedTitle` and its
  `evidence` in the notes: `active-work task add titan-platform --title "<suggestedTitle>" --tags session-insights`.
  Search open tasks first and add a note to a match instead of filing a duplicate.
- Stop on a `graph-stale` fault. Run `titan-miner refresh`, then start again at step 2.
- Any other `error` fault, such as `unpriced-model`, does not stop the loop, but it makes every
  dollar figure from the affected requests a lower bound. Say so in the retro.

## Step 3: prices

Build a published price file from the claude-api skill's model table: a JSON array of
`{ model, input, cacheRead, cacheWrite5m, cacheWrite1h, output }` in USD per million tokens. Then
run `titan-miner insights prices --published <file> <filters> --json`.

Stop on any entry in `mismatches`: no cost claim until it is empty. File a task naming each
model and field, so the price table is fixed in `@titan-design/session-analytics`. Do not work
around the table in the analysis.

## Step 4: run the questions

Run only the questions the retro asks about, each with the step 1 filters and `--json`:

- `titan-miner insights spend-by-action` (Q1): spend by turn action, and the mechanical share.
- `titan-miner insights handoff-threshold` (Q2): boot cost, fill growth, the best handoff threshold.
- `titan-miner insights cache-ttl` (Q3): what a 5-minute cache TTL would save against 1 hour.
- `titan-miner insights wake-economics` (Q4): what wakes a coordinator and what a wake costs.
- Q5 to Q11 as needed: `titan-miner insights tool-errors`, `titan-miner insights round-trips`,
  `titan-miner insights blocked-flow`, `titan-miner insights liveness`,
  `titan-miner insights tool-gaps`, `titan-miner insights tool-adoption`,
  `titan-miner insights probes`.
- Guardrails: Q13 quality-guardrails (review fill and successor rework, with a before/after
  comparison) is pending TP-499 slice e. Until it is registered, use
  `titan-miner insights blocked-flow --split-at <time>` for a before/after on a lever.
- Cost per outcome: `active-work miner outcomes`, once TP-513 ships it. Until then, report the
  outcome question as a gap under step 8.

Keep each answer as a file named after its question. Never pass raw transcripts on.

## Step 5: the analyst

Spawn one read-only sonnet worker through agent-chat `agent_spawn`, with the profile the seat
uses for read-only analysis. Give it:

- `analyst-brief.md` from this directory, as its brief.
- The JSON files from steps 2 to 4, as paths. No transcripts, no database, no `agent-chat` CLI.
- The scope from step 1 and the question the retro asks.

It returns a findings file: a JSON array in the citation contract the brief describes.

## Step 6: verify citations

Run `titan-miner insights verify-citations --findings <file>`. It re-runs every cited question
and exits non-zero when any citation is not `ok`.

Drop every finding with a citation that is not `ok`. Do not repair a finding by hand. If the
analyst's reading was right and the field moved, ask it for a corrected finding and verify again.

## Step 7: report

- Findings go to the retro, each with its claim, its citations as commands, and its falsifier.
- A proposed change goes to `proposals/`. It names the guardrail that will show whether it
  worked: Q13 quality-guardrails once it ships, and Q7 `blocked-flow --split-at <change time>`
  for the merge flow. A lever with no guardrail is not proposed.
- State the step 2 and step 3 caveats next to any dollar figure.

## Step 8: extend the library

When the retro needs a number no question returns, do not compute it ad hoc. File a
session-insights task in titan-platform with the question in one sentence and the smallest
query that answers it, such as the tables and columns it reads. The first expected one is
requests per finished agent. Once that question ships, this skill names it in step 4.
