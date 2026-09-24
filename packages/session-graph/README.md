# @titan-design/session-graph

The activity graph behind a corpus of Claude Code transcripts: sessions, turns, token
buckets, permission phases, touched files, branches, PRs, subagents, and the edges between
them, all in one SQLite file built from `@titan-design/store-sqlite` kit tables and kept
current incrementally.

Tier 2 of the titan-platform DAG. Depends on `session-read`, `store-sqlite`,
`cluster`, `locator`, and `agent-protocol`. Extracted from active-work's session index (AW-23, TP-6).

```ts
import { discoverTranscripts } from "@titan-design/session-read";
import { openSessionGraph, refreshCorpus } from "@titan-design/session-graph";

const graph = openSessionGraph("~/.local/state/miner/index.sqlite3");
const summary = await refreshCorpus(graph, await discoverTranscripts());
// summary.indexed, summary.unchanged, summary.rewound, summary.quarantined, summary.missing,
// summary.facetsBackfilled, summary.facetBacklog
```

`openSessionGraph` takes an optional `schemaVersion`: the highest migration version the
*caller* owns, checked before any migration runs. A product layering its own tables on this
graph passes its own top version, since this package's `MIGRATIONS` are one band of a shared
database rather than the top of it. `products/session-miner` numbers its own from 1000 and
passes 1002.

## What a refresh does

1. For every transcript, `indexTranscript` asks the watermark table where it stopped,
   checks the file (`unchanged`, `appended`, `rewritten`, `missing`), reads the delta with
   `extractTranscript`, applies it in one transaction, and advances the watermark with the
   new prefix hash. A malformed line quarantines that transcript only.
2. `backfillFacets` re-extracts the audit facet of already-indexed transcripts whose
   `transcript_facet` version is below session-read's `EXTRACT_VERSION`: up to
   `facetLimit` of them per pass (default 40), newest `file_mtime` first, each read from
   byte 0 to its watermark. It replaces that transcript's rows in the eight audit tables
   and never writes the legacy tables, so their accumulating counts cannot double.
   Transcripts that are `missing` or `quarantined` are skipped. `summary.facetsBackfilled`
   and `summary.facetBacklog` report progress; pass `facetLimit: Infinity` to clear the
   backlog in one pass. A classifier change is a version bump, not a `resetIndex`.
3. `rollupSessions` recomputes turn aggregates (index, end, duration, tool calls, thinking
   time) for the sessions that changed, including those the backfill touched. Recompute, never accumulate, so incremental and
   full passes converge.
4. `resolveOrigins` runs if the caller passed a `resolveOrigins` resolver. See migration 5.
5. `reconcile` folds cross-transcript observations: `gh pr merge` sightings onto PRs,
   complete `gh pr create` sightings into new PR rows, subagent end times and parentage
   from child sessions.
6. `enrichPrs` runs if the caller passed a `resolvePrs` resolver. See below.
7. `enrichTasks` runs if the caller passed a `resolveTasks` resolver, once over the whole
   task table. See below.
8. Rows whose source file has vanished are marked `missing`. Their facts stay: surviving
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
- **Estimate.** `estimate` fills `task.estimate`, in whatever unit the store keeps.
- **Batching.** One call per refresh, holding every task id in the graph, because a real
  resolver reads a database. Returning an id no transcript mentioned inserts that task.
- **Failure.** A resolver that throws costs that pass its enrichment and nothing else; the
  rows stand as the transcripts left them and `summary.tasks` carries `failed` plus the
  `error` message for the caller to log.

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

Kit tables: `transcript` (watermark), `edge` (bi-temporal, `session:… touched file:…`),
`search_span` + `search_fts` (contentless full-text over prompts, responses, tool inputs
and results, keyed by the session ref). Domain tables: `fact`, `session`,
`session_model_usage`, `turn`, `permission_phase`, `human_edit`, `file_checkpoint`, `pr`,
`branch`, `file`, `task`, `subagent`, `artifact`, and the two PR observation tables.

Everything except `transcript` is derivable, which is what makes the schema safe to evolve
by drop-and-rederive.


## Mixed harnesses

`indexCodexSource(graph, source)` consumes descriptors returned by session-read's
`discoverCodexSources`. Changed source contents are replayed into temporary staging,
then structural observations, searchable spans and the watermark are replaced in one
transaction. Malformed or missing sources retain their prior indexed rows. The
initial implementation favors correctness over tail-only parsing; prefix replay can
be expensive on large rollouts.

`normalizedSessions`, `normalizedUsage` and `readIndexedText` provide summaries,
response-deduplicated token accounting and source-aware excerpt readback. Unknown
tokens stay null. Response deltas take precedence over snapshot projections; snapshots
are ordered within reset epochs. Multiple semantic subrecords remain independently
stored, while text siblings in the same line/field share a span with several selectors.

Migration 3 adds conversation, alias, source and semantic-event tables without
rewriting legacy session/fact/turn rows. Known Claude transcript sessions get explicit
aliases in the `legacy` corpus namespace; workspace session-body refs are not
reclassified. `resolveConversationAlias` rejects ambiguous aliases. Original source
files are not needed to migrate. Back up the database before upgrading; restoring
that backup is the rollback path for an older binary. Explicit `resetIndex` remains a
destructive rebuild and requires the original sources; it is never run by migration.

Migration 4, `audit tables`, adds one table per session-read audit event kind
(`request`, `tool_call`, `inbound`, `context_block`, `compaction`, `queue_op`,
`session_signal`, `cost_state_observation`) plus `transcript_facet`, and adds
`session.account` and five rollup or outcome columns. It creates only empty tables and
nullable columns, so existing rows are untouched; transcripts indexed before it gain
audit rows through `backfillFacets` on later refreshes. `request` holds one row per `(transcript_id, request_id)`:
the several assistant lines of one API response collapse to the first line's offset and
the largest value of each token column. `session.account` comes from discovery, not the
transcript. `purgeTranscript` and `resetIndex` clear all nine tables.

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

For snapshot-only usage across multiple physical sources, queries select one source
by latest native usage timestamp, then greatest usage-record coverage and stable
source ID. Source-local reset epochs cannot safely be summed across copies. This is
a conservative projection, not a claim of complete usage across disjoint partial
sources. Response deltas still deduplicate across sources by native response ID.
Codex commit/push analytics are currently unreported (`null`), rather than zero.
