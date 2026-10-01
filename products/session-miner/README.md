# @titan-design/session-miner

The first product on the platform: index every Claude Code transcript into a session
graph, search it, cluster its recurring failures, and serve all of that over a CLI, MCP,
and HTTP from one command registry. It exists as much to prove the package DAG end to
end as to be useful.

Private (not published). Composes `registry`, `daemon`, `store-sqlite`, `locator`,
`cluster`, `session-read`, `session-graph`, `retrieval`, `embed` (TP-7), and `memory`
(TP-19).

```
titan-miner refresh            # index new transcript bytes (--full rebuilds from zero); also reconciles the graph's price rows with session-analytics' PRICE_TABLE
titan-miner status             # counts, transcript states, FTS orphan ratio
titan-miner search "daemon 503 at startup"
titan-miner session list -n 20
titan-miner session show <session-id>
titan-miner drain ingest       # cluster tool errors into templates
titan-miner drain templates
titan-miner playbook add "Pin npm to 11 in release jobs" --tag ci --tag release
titan-miner playbook recall "release job npm"
titan-miner playbook reflect <session-id>   # renders the diary; applies nothing
titan-miner playbook status
titan-miner insights spend-by-action --since 2026-09-01 --role coordinator
titan-miner serve --port 7400  # /rpc, /mcp, /events on loopback
titan-miner mcp                # MCP over stdio
```

Every command takes `--json` for the envelope. `--state <dir>` and `--corpus <dir>` (or
`TITAN_MINER_STATE` / `TITAN_MINER_CORPUS`) override the defaults of
`~/.local/state/titan-session-miner` and `~/.claude/projects`.

The package is private, so `titan-miner` is not on your `PATH` after a global install.
Run it from a built checkout with `pnpm --filter @titan-design/session-miner exec titan-miner <args>`
or `node products/session-miner/dist/bin.js <args>`.

`--graph <file>` (or `TITAN_MINER_GRAPH`) reads a session graph another owner writes,
such as active-work's `.miner/graph.sqlite3`, in place of the miner's own index. The
miner opens it read-only: it runs no migrations, writes no price rows, and refuses write
commands. Opening refuses a graph that lacks any session-graph migration this runtime
declares.

```
titan-miner --graph "<active-work root>/.miner/graph.sqlite3" insights spend-by-action
```

The miner's own migrations are numbered from 2000. Session-graph owns the low numbers
and active-work's band starts at 1001, which is where the miner's band sat before.

## How the tiers compose

- `session-read` discovers transcripts (including subagent sidechains) and turns lines
  into events with byte-offset locators.
- `session-graph` folds them into kit tables (`store-sqlite`) and keeps the index current
  from per-transcript watermarks.
- `search` runs a `retrieval` engine: contentless FTS over the spans plus one hop of
  graph expansion through the edge table, fused with RRF, with a locator on every hit that
  `locator` reads back into an excerpt. Nothing in the index stores transcript text.
- `drain ingest` reads each unclustered `tool_result_error` fact through its locator,
  screens it with `hasErrorSignal`, and clusters it with `cluster`'s Drain pipeline. The
  clusterer snapshot lives in the same database so ids survive restarts.
- `registry` defines each command once; the CLI (commander), `daemon` (`/rpc`, `/mcp`,
  `/events`), and MCP stdio are projections of the same registry.
- `playbook` is `memory` over the same database: rules with decaying confidence, curated
  deterministically. See below.

## Insights (TP-507)

`titan-miner insights <question>` answers one cost question from the graph. Each question
is a pure function in `@titan-design/session-analytics`; the miner only registers it, so
it runs on the CLI, as the MCP tool `miner__insights__<question>`, and at
`POST /rpc/insights.<question>`.

| Question | Command | Answers | Own options |
| --- | --- | --- | --- |
| Q1 | `insights spend-by-action` | each role's spend by turn action, and the mechanical share | `--mechanical <class>` |
| Q2 | `insights handoff-threshold` | boot cost, fill growth and the best handoff threshold K per role | `--k <tokens>`, `--reviewer-prs <n>`, `--broker-log <path>` (CLI only) |
| Q3 | `insights cache-ttl` | what a 5-minute cache TTL would save against 1h, per role and profile | none |
| Q4 | `insights wake-economics` | what wakes a coordinator, and the requests and cost per wake episode | `--episode-role <role>` |
| Q7 | `insights blocked-flow` | per repo: verdict-to-merge minutes, open PRs holding MERGE, classifier denials, idle implementer slots | `--seat <seat>`, `--split-at <time>`, `--transcript <seat>=<path>`, `--journal <seat>=<path>`, `--pulls <file>` (last three CLI only) |

Every question takes the same filters, which combine with AND: `--session <id>` and
`--role <role>` (both repeatable), `--agent-prefix <prefix>` for agent-chat names, and
`--since` (inclusive) and `--until` (exclusive) on request time. Roles are the cost
report's `byRole` names, such as `coordinator` or `worker:reviewer`. Compactions and
coverage stay window-wide. Dates must parse and are compared in UTC, so an offset timestamp
works. MCP and HTTP refuse an unknown key, and refuse `brokerLog` because it reads a local file.

With `--json` the envelope's data is `{ question, caveat, filters, answer }`, where
`answer` matches the question's zod schema. Without it the question prints its text
renderer. Both carry `LIST_PRICE_CAVEAT`: the figures are list prices, not a bill.

Q7 reads outside the graph, so it refuses `--session`, `--agent-prefix` and `--role`; narrow it
with `--seat`. Reviewer verdicts come from agent-chat's events table, opened read-only at
`TITAN_MINER_EVENTS_DB` (default `~/.agent-chat/events.db`). `merged_at` and the current head come
from `gh api repos/<repo>/pulls/<n>`, or from a `--pulls` snapshot. Classifier denials come from each
`--transcript` (a `.jsonl` file or a directory of them), and idle slots from each `--journal` named
`<YYYY-MM-DD>.md`, read in this machine's local time. Waits are measured to `--until`, or to now, so a
PR merged later counts as open, and its age is a censored wait. Every table names the JSON field its
numbers come from, and the text ends with the command and field behind each source.

To add a question, write its analysis in `session-analytics` first: a pure function over
the graph, a zod schema, a text renderer that ends with `LIST_PRICE_CAVEAT`, and a
synthetic-fixture test. Then add one `defineInsight({...})` to
`src/insights/questions.ts` with the plan's id, the subcommand name, the question's own
options and flags, the schema, and an `answer` that calls the analysis and its renderer.
Append it to `INSIGHT_QUESTIONS`. The shared tests then cover its envelope, its caveat,
every filter, and its presence on all three surfaces.

## The playbook (TP-19)

`playbook add` is the default path and costs nothing: the agent that just learned
something writes it down, and `memory`'s curator folds restatements into feedback rather
than accumulating near-duplicates. `playbook recall` ranks by relevance times confidence.

`playbook reflect <session-id>` is the deterministic half of the AW-31 design. It builds a
diary out of the session's own subgraph, never a model: title, branch, turns, files
touched, tasks and their status, linked pull requests, subagents, and the recurring error
signatures Drain already clustered. The outcome label is derived the same way, from merged
versus abandoned pull requests, task status, and error counts, so the training signal is
graph-derived rather than self-reported. Note that the task half is inert today: the graph
mints task refs but never resolves their status, so on the real corpus only the pull
request and error signals move the label (TP-20). By default it renders the diary and
applies nothing; supply a `Reflector` on the context to let a model propose deltas, which
are then zod-validated and stamped with `{ sessionRef, byteOffset }` provenance by the
curator rather than by the model.

The playbook is strictly downstream. It reads the graph and never writes back, so the
index stays valid with the playbook ignored, and a test asserts the row counts do not move.

## Not yet here

A dashboard (waits on TP-10's UI split), vector search over the spans (the `embed`
dependency is wired but no vector index is built yet), per-tool partitions for Drain (the
fact table does not carry tool names for results yet), and a scheduler for periodic
refreshes (the daemon serves; a supervisor drives `refresh`).

The playbook has no semantic recall yet: `memory` supports a vector index, but the miner
does not build one, so recall is keyword-only.


## Codex sessions

Opt in with `--codex-home ~/.codex --namespace workstation-account` (or
`TITAN_MINER_CODEX_HOME` and `TITAN_MINER_NAMESPACE`). Existing `--corpus` remains the
Claude projects root. Choose a stable host/account namespace; moving a source must
not rename its conversation.

Refresh discovers active and archived Codex rollouts. Session list/show report the
harness and native ID; Codex session IDs are canonical `conversation:` refs. Search
and Drain use the shared format-aware resolver, including semantic subrecords, and
return unavailable excerpts when indexed source bytes have changed or disappeared.
Tool errors with no explicit native error flag are screened by the existing error
signal classifier; they are not classified as permission denials.

The initial normalized ingest replays changed files for correct model context,
projection deduplication and usage accounting. Execution stdout is not a second
transcript corpus. Back up existing graph databases before upgrading; migration is
additive and preserves historical rows even when their originals have been pruned.
