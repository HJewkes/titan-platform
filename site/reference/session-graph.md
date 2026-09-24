# session-graph

**Tier 2 · domain.** Depends on [`session-read`](/reference/session-read),
[`store-sqlite`](/reference/store-sqlite), [`cluster`](/reference/cluster),
[`locator`](/reference/locator), and [`agent-protocol`](/reference/agent-protocol).

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
//   markedMissing: 0, facetsBackfilled: 0, facetBacklog: 0
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
2. **`backfillFacets`** re-extracts the audit facet of already-indexed transcripts whose
   `transcript_facet` version is below session-read's `EXTRACT_VERSION`: up to `facetLimit`
   per pass (default 40), newest `file_mtime` first, each read from byte 0 to its watermark.
   It replaces only that transcript's audit rows, so legacy counts cannot double, and skips
   `missing` and `quarantined` transcripts. Pass `facetLimit: Infinity` to clear the backlog
   in one pass. A classifier change is a version bump, not a `resetIndex`.
3. **`rollupSessions`** recomputes turn aggregates — index, end, duration, tool calls,
   thinking time — for the sessions that changed, including those the backfill touched. Recompute, never accumulate, so incremental
   and full passes converge.
4. **`resolveOrigins`** runs if you passed a `resolveOrigins` resolver (see migration 5).
5. **`reconcile`** folds cross-transcript observations: `gh pr merge` sightings onto PRs,
   complete `gh pr create` sightings into new PR rows, subagent end times and parentage from
   child sessions.
6. **`enrichPrs`** runs if you passed a `resolvePrs` resolver (below).
7. **`enrichTasks`** runs if you passed a `resolveTasks` resolver (below).
8. Rows whose source file has vanished are marked `missing`. **Their facts stay** — surviving
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
- **Estimate.** `estimate` fills `task.estimate`, in whatever unit the store keeps.
- **Batching.** One call per refresh, holding every task id in the graph, because a real
  resolver reads a database. Returning an id no transcript mentioned inserts that task.
- **Failure.** A resolver that throws costs that pass its enrichment and nothing else. The
  rows stand as the transcripts left them, and `summary.tasks` carries `failed` plus the
  `error` message for you to log.

## The PR outcome resolver

A transcript sees a merge only when that session ran `gh pr merge`. A merge done by another
session or in the browser, a close, and the review history exist nowhere in the corpus. Pass
`resolvePrs` and a product fills `state`, `merged_at`, `closed_at` and `review_rounds`.

```ts
await refreshCorpus(graph, transcripts, {
  resolvePrs: async (prs) => new Map(prs.map((pr) => [pr.prRef, myForge.outcome(pr.repo, pr.number)])),
});
```

- **Order.** It runs after `reconcile`, so it sees every merge the transcripts witnessed.
- **Merged is sticky.** A resolver's `open` or `closed` never replaces a `merged` state, so a
  stale forge cache cannot reopen a PR. States are stored lower-case.
- **Batching.** One call per refresh with every PR that has a repo and number and whose
  outcome may still change: never checked, or not yet merged. A merged PR is asked about
  once. The resolver only updates rows; a PR enters the graph from a transcript.
- **`review_rounds`** is stored as the resolver counts it. What counts as a round is an open
  question in the TP-256 design (Q6).
- **Failure.** Same as the task resolver: the pass completes, the rows stand, and
  `summary.prs` carries `failed` plus `error`.

`reconcile` sets `merged_at` from merge sightings only for a PR the resolver has not yet
checked. Once the resolver has answered for a PR, its `merged_at` is the forge's and a later
pass never overwrites it with a sighting time.

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

**`schemaVersion` is the caller's version, not this package's.** `openSessionGraph` accepts
one and refuses a database stamped past it, before any migration runs. Pass the top of the
schema *you* own: this package's `MIGRATIONS` are one band of a shared database, and a
product layering its own tables sits above them. `products/session-miner` numbers its own
from 1000 and passes 1002.

## Where it came from

active-work's session index (AW-23). The `TaskResolver` seam was added here, so the package
can stay ignorant of any product's task store.


## Mixed Codex/Claude graphs

`indexCodexSource` stages a normalized rollout before atomically replacing its source
rows and watermark. Malformed/missing files retain prior indexed data. Semantic
subrecords retain distinct identities; `readIndexedText` resolves their selected
text and returns null if source evidence changed.

Migration 3 adds canonical conversations and explicit aliases for known legacy Claude
transcript sessions without rewriting existing rows or requiring original files.
`normalizedSessions` and `normalizedUsage` expose Codex metadata and usage, while
existing Claude APIs continue to operate. Back up the database before upgrading;
restore that backup when rolling back to an older binary. Migration never resets
or rebuilds the corpus.

Migration 5, `origin, episodes, prices`, adds four tables and three views. It creates only
empty tables, so existing rows are untouched.

- `session_origin` and `session_external_event` hold who launched a session and the
  lifecycle events the launcher saw outside the transcript. `refreshCorpus` fills them
  through the `resolveOrigins` option, once per pass, for sessions with no origin row or one
  older than the session's last line. Each origin with a parent projects into a `spawned`
  edge and a `subagent` row. `resetIndex` clears them and the next pass refills them.
- `episode` holds each segmentation heuristic's cut of a session.
  `replaceEpisodes(graph, sessionId, heuristic, rows)` is its only writer. It replaces one
  heuristic's rows for one session in a transaction and leaves every other heuristic's rows
  alone, so `worker-v1` and `coordinator-v1` coexist. The rule itself lives in
  session-analytics. A rewritten transcript purges its sessions' episodes.
- `price` holds USD per million tokens by model prefix and effective date.
  `syncPrices(graph, rows, { tableVersion, source })` replaces the whole table in one
  transaction.
- `request_dedup` collapses fan-out copies of a request to the earliest one. Every cost
  query reads it, never `request`. `request_cost` prices each row by longest model prefix
  and latest `effective_from`; an unmatched model reads `priced = 0` and costs 0.
  `context_contribution` attributes each request's context growth to the blocks before it.

Migration 6, `episode transcript ids`, adds nullable `start_transcript_id` and
`end_transcript_id` columns to `episode`, surfaced as `EpisodeRow.startTranscriptId` and
`endTranscriptId`. A session resumed across two transcripts then orders by timestamp,
transcript id, and byte offset, because byte offsets reset with the new file.
