# @titan-design/session-graph

The activity graph behind a corpus of Claude Code transcripts: sessions, turns, token
buckets, permission phases, touched files, branches, PRs, subagents, and the edges between
them, all in one SQLite file built from `@titan-design/store-sqlite` kit tables and kept
current incrementally.

Tier 2 of the titan-platform DAG. Depends on `session-read`, `store-sqlite`, and
`cluster`. Extracted from active-work's session index (AW-23, TP-6).

```ts
import { discoverTranscripts } from "@titan-design/session-read";
import { openSessionGraph, refreshCorpus } from "@titan-design/session-graph";

const graph = openSessionGraph("~/.local/state/miner/index.sqlite3");
const summary = await refreshCorpus(graph, await discoverTranscripts());
// summary.indexed, summary.unchanged, summary.rewound, summary.quarantined, summary.missing
```

## What a refresh does

1. For every transcript, `indexTranscript` asks the watermark table where it stopped,
   checks the file (`unchanged`, `appended`, `rewritten`, `missing`), reads the delta with
   `extractTranscript`, applies it in one transaction, and advances the watermark with the
   new prefix hash. A malformed line quarantines that transcript only.
2. `rollupSessions` recomputes turn aggregates (index, end, duration, tool calls, thinking
   time) for the sessions that changed. Recompute, never accumulate, so incremental and
   full passes converge.
3. `reconcile` folds cross-transcript observations: `gh pr merge` sightings onto PRs,
   complete `gh pr create` sightings into new PR rows, subagent end times and parentage
   from child sessions.
4. `enrichTasks` runs if the caller passed a `resolveTasks` resolver, once over the whole
   task table. See below.
5. Rows whose source file has vanished are marked `missing`. Their facts stay: surviving
   Claude Code's own pruning is much of the point.

`resetIndex` clears every derived table and rewinds watermarks; the next refresh rebuilds
from byte 0 to the same rows a chunked history produced.

## The task resolver

A transcript states the id a command acted on and nothing else, so a task's title, its
initiative, and the status it holds *right now* exist nowhere in the corpus. Pass a
resolver and a product fills them; pass nothing and the graph is exactly what the
transcripts said.

```ts
await refreshCorpus(graph, transcripts, {
  resolveTasks: async (taskIds) => new Map(taskIds.map((id) => [id, myStore.get(id)])),
});
```

- **Precedence.** Every field the resolver states wins; every field it omits or nulls keeps
  what the transcripts derived. The store is the system of record for a task's present
  status, while a transcript only witnesses a command that was observed to run.
- **Batching.** One call per refresh, holding every task id in the graph, because a real
  resolver reads a database. Returning an id no transcript mentioned inserts that task.
- **Failure.** A resolver that throws costs that pass its enrichment and nothing else; the
  rows stand as the transcripts left them and `summary.tasks` carries `failed` plus the
  `error` message for the caller to log.

## Tables

Kit tables: `transcript` (watermark), `edge` (bi-temporal, `session:… touched file:…`),
`search_span` + `search_fts` (contentless full-text over prompts, responses, tool inputs
and results, keyed by the session ref). Domain tables: `fact`, `session`,
`session_model_usage`, `turn`, `permission_phase`, `human_edit`, `file_checkpoint`, `pr`,
`branch`, `file`, `task`, `subagent`, `artifact`, and the two PR observation tables.

Everything except `transcript` is derivable, which is what makes the schema safe to evolve
by drop-and-rederive.
