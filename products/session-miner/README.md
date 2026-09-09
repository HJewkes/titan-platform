# @titan-design/session-miner

The first product on the platform: index every Claude Code transcript into a session
graph, search it, cluster its recurring failures, and serve all of that over a CLI, MCP,
and HTTP from one command registry. It exists as much to prove the package DAG end to
end as to be useful.

Private (not published). Composes `registry`, `daemon`, `store-sqlite`, `locator`,
`cluster`, `session-read`, `session-graph`, `retrieval`, `embed` (TP-7), and `memory`
(TP-19).

```
titan-miner refresh            # index new transcript bytes (--full rebuilds from zero)
titan-miner status             # counts, transcript states, FTS orphan ratio
titan-miner search "daemon 503 at startup"
titan-miner session list -n 20
titan-miner session show <session-id>
titan-miner drain ingest       # cluster tool errors into templates
titan-miner drain templates
titan-miner playbook add "Pin npm to 11 in release jobs" --tag ci,release
titan-miner playbook recall "release job npm"
titan-miner playbook reflect <session-id>   # renders the diary; applies nothing
titan-miner playbook status
titan-miner serve --port 7400  # /rpc, /mcp, /events on loopback
titan-miner mcp                # MCP over stdio
```

Every command takes `--json` for the envelope. `--state <dir>` and `--corpus <dir>` (or
`TITAN_MINER_STATE` / `TITAN_MINER_CORPUS`) override the defaults of
`~/.local/state/titan-session-miner` and `~/.claude/projects`.

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
does not build one, so recall is keyword-only. Repeatable array options are a registry
gap, so `--tag` takes a comma-separated list instead of repeating the flag.
