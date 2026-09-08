# @titan-design/session-miner

The first product on the platform: index every Claude Code transcript into a session
graph, search it, cluster its recurring failures, and serve all of that over a CLI, MCP,
and HTTP from one command registry. It exists as much to prove the package DAG end to
end as to be useful.

Private (not published). Composes `registry`, `daemon`, `store-sqlite`, `locator`,
`cluster`, `session-read`, `session-graph`, `retrieval`, and `embed` (TP-7).

```
titan-miner refresh            # index new transcript bytes (--full rebuilds from zero)
titan-miner status             # counts, transcript states, FTS orphan ratio
titan-miner search "daemon 503 at startup"
titan-miner session list -n 20
titan-miner session show <session-id>
titan-miner drain ingest       # cluster tool errors into templates
titan-miner drain templates
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

## Not yet here

A dashboard (waits on TP-10's UI split), vector search over the spans (the `embed`
dependency is wired but no vector index is built yet), per-tool partitions for Drain (the
fact table does not carry tool names for results yet), and a scheduler for periodic
refreshes (the daemon serves; a supervisor drives `refresh`).
