# session-graph

**Tier 2 · domain.** Depends on [`session-read`](/reference/session-read),
[`store-sqlite`](/reference/store-sqlite), [`cluster`](/reference/cluster), and
[`locator`](/reference/locator).

```sh
npm install @titan-design/session-graph
```

## The problem it solves

Transcripts are a stream. Questions about them are a graph: which sessions touched this
file, what did that branch cost in tokens, which PRs came out of last week, what did the
subagent do.

This is that graph — sessions, turns, token buckets, permission phases, touched files,
branches, PRs, subagents, artifacts, and the edges between them — in one SQLite file built
from `store-sqlite` kit tables and **kept current incrementally**.

## When to reach for it

You want to query a corpus of Claude Code sessions, repeatedly, as it grows. If you only
want to parse one transcript, use [`session-read`](/reference/session-read) directly.

## Example

Verified against 0.2.0.

```ts
import { discoverTranscripts } from "@titan-design/session-read";
import { openSessionGraph, refreshCorpus } from "@titan-design/session-graph";

const graph = openSessionGraph("~/.local/state/miner/index.sqlite3");
const summary = await refreshCorpus(graph, await discoverTranscripts());

// {
//   transcripts: 8, indexed: 8, unchanged: 0, rewound: 0, missing: 0, quarantined: 0,
//   facts: 1899, turnsRolledUp: 10,
//   reconciled: { prCreates: 0, prMerges: 0, subagents: 0 },
//   tasks: { requested: 0, applied: 0, failed: false },
//   markedMissing: 0
// }

graph.spans.search("daemon", 5);   // [{ ownerRef: 'session:…', byteOffset, byteLength, … }]
graph.edges.from("session:abc");   // touched files, branches, PRs
```

Run it again with nothing changed and the same call reports `indexed: 0, unchanged: 8`.

## What a refresh does

1. **`indexTranscript`** asks the watermark table where it stopped, checks the file
   (`unchanged`, `appended`, `rewritten`, `missing`), reads the delta with
   `extractTranscript`, applies it in one transaction, and advances the watermark with the
   new prefix hash. A malformed line quarantines *that transcript only*.
2. **`rollupSessions`** recomputes turn aggregates — index, end, duration, tool calls,
   thinking time — for the sessions that changed. Recompute, never accumulate, so incremental
   and full passes converge.
3. **`reconcile`** folds cross-transcript observations: `gh pr merge` sightings onto PRs,
   complete `gh pr create` sightings into new PR rows, subagent end times and parentage from
   child sessions.
4. **`enrichTasks`** runs if you passed a `resolveTasks` resolver (below).
5. Rows whose source file has vanished are marked `missing`. **Their facts stay** — surviving
   Claude Code's own pruning is much of the point.

`resetIndex(graph)` clears every derived table and rewinds watermarks; the next refresh
rebuilds from byte 0 to the same rows a chunked history produced.

## The task resolver

A transcript states the id a command acted on and nothing else. A task's title, its
initiative, and the status it holds *right now* exist nowhere in the corpus. Pass a resolver
and a product fills them; pass nothing and the graph is exactly what the transcripts said.

```ts
await refreshCorpus(graph, transcripts, {
  resolveTasks: async (taskIds) => new Map(taskIds.map((id) => [id, myStore.get(id)])),
});
```

- **Precedence.** Every field the resolver states wins; every field it omits or nulls keeps
  what the transcripts derived. The store is the system of record for a task's present
  status; a transcript only witnesses a command that was observed to run.
- **Batching.** One call per refresh, holding every task id in the graph, because a real
  resolver reads a database. Returning an id no transcript mentioned inserts that task.
- **Failure.** A resolver that throws costs that pass its enrichment and nothing else. The
  rows stand as the transcripts left them, and `summary.tasks` carries `failed` plus the
  `error` message for you to log.

## Tables

**Kit tables:** `transcript` (watermark), `edge` (bi-temporal, `session:… touched file:…`),
`search_span` + `search_fts` (contentless full-text over prompts, responses, tool inputs and
results, keyed by the session ref).

**Domain tables:** `fact`, `session`, `session_model_usage`, `turn`, `permission_phase`,
`human_edit`, `file_checkpoint`, `pr`, `branch`, `file`, `task`, `subagent`, `artifact`, and
the two PR observation tables.

Everything except `transcript` is derivable, which is what makes the schema safe to evolve by
drop-and-rederive.

## Gotchas

**`refreshCorpus` takes `DiscoveredTranscript` objects**, not paths. Use
`discoverTranscripts()` rather than assembling them yourself; the `displayPath` field is the
watermark key.

**Same-length rewrites need `verifyHash`.** Without it, a rewritten file of identical length
looks `unchanged`.

**No transcript text is stored.** The FTS index is contentless: hits carry a locator and you
read the original bytes back with [`locator`](/reference/locator).

## Where it came from

active-work's session index (AW-23). The `TaskResolver` seam was added here, so the package
can stay ignorant of any product's task store.
