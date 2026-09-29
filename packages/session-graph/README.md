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
7. `projectReviewRounds` resolves chat verdicts and writes review rounds. See below.
8. `enrichTasks` runs if the caller passed a `resolveTasks` resolver, once over the whole
   task table. See below.
9. Rows whose source file has vanished are marked `missing`. Their facts stay: surviving
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
  outcome may still change: never checked, not yet merged, or merged with no commit times
  stored. PRs never checked come first, then open and closed PRs, then merged PRs offered only
  for their commit times, so a resolver that caps its batch reaches open PRs before the
  backlog. The resolver only updates rows; a PR enters the graph from a transcript.
- **`commitTimes`** is stored as a JSON array in `commit_times`. Send an empty array for a PR
  with no commits, so it is not offered again; omitting the field leaves the stored value.
- **`reviews`** replaces the PR's forge rows in `pr_review` (`APPROVED` and
  `CHANGES_REQUESTED`, keyed `gh:<pr_ref>:<submittedAt>`); omitting it leaves them. With
  `reviews`, the round rule below counts `review_rounds_gh` against the sent `commitTimes`, or
  the stored ones when none are sent. With no usable commit times, `reviewRounds` is stored
  there as the forge counted it, and omitting that too leaves the stored value.

## Review rounds

`projectReviewRounds` runs after `enrichPrs` on every pass. It first resolves each chat
verdict's `pr_ref`, then writes `review_rounds_chat` and `review_rounds` for every PR.

**The rule.** A review's head is the number of the PR's commits at or before it. A
changes-requested review counts when its head is below the commit count, which means a later
commit answered it. A PR's rounds are the distinct heads among its counting reviews. A second
changes-requested review on one head adds nothing, whether it comes from the same reviewer, a
second reviewer, or the other surface. An approval is stored and never adds a round.

- **Senders.** A chat verdict counts only when the sender's `session_origin.profile` passes
  `isReviewerProfile`, a `refreshCorpus` option. The default accepts `reviewer` and any
  profile ending in `-reviewer`.
- **Totals.** `review_rounds` is `review_rounds_gh` plus the chat heads no forge review
  already sits on. A resolver that sends only a `reviewRounds` count therefore still adds to
  the chat rounds unchanged.
- **Count-only resolvers overcount.** Without `reviews`, the forge reviews' heads are unknown,
  so a chat verdict and a forge review on the same head both count. `review_rounds` is then
  an upper bound. `review_rounds_gh` and `review_rounds_chat` are each exact, and the total
  is exact once the resolver sends `reviews` and `commitTimes`.
- **Unknown commits.** While `commit_times` is null, `review_rounds_chat` stays null and
  `review_rounds` equals `review_rounds_gh`.
- **Unparseable times.** A review whose time does not parse is ignored by the rule and stays
  stored. If any of a PR's commit times does not parse, its commit times count as unknown,
  since a dropped commit would shift every later head. `countRounds` returns null in that
  case. `summary.reviews.invalidTimes` counts the ignored reviews plus the PRs with unusable
  commit times.

**Resolving a chat verdict.** An exact `owner/name` must match a `pr` row, or the verdict
stays unresolved. Otherwise the candidates are the `pr` rows with that number, narrowed in
order. A repo hint keeps the rows whose repo's last path segment matches it, in any case; a
hint that matches none is ignored. Then the sender's family links keep the PRs `linked` from
the sender, its parent session, or any session that parent spawned. Last, the sender's
working directory repo, a bare name, is compared with each repo's last path segment. The first
step that leaves exactly one row resolves the verdict. A resolved `pr_ref` is kept on later
passes, and `summary.reviews` reports `resolved` (this pass) and `unresolved` (still null).
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
`branch`, `file`, `task`, `subagent`, `artifact`, the two PR observation tables, and
`pr_review`.

`pr_review` holds one row per review verdict. A chat row comes from a `chat_send` tool use
that session-read parsed a verdict from, keyed `chat:<tool_use_id>:<n>` where `n` is the
verdict's `ordinal` in that message. An event from a session-read that predates `ordinal`
takes the next index its tool use has not used in that `applyDelta` call; that session-read
emits all of one tool use's verdicts from one line, so the keys cannot collide across calls. It keeps only the parsed fields (verdict, repo, repo hint,
PR number, and the repo of the sender's working directory), never message text, and is purged
with its transcript. `pr_ref` stays null until a later pass resolves it.

`resetIndex` drops `pr` rows and forge review rows with everything else, so `commit_times`,
`review_rounds_gh` and the forge reviews return only when a resolver answers again.

Everything except `transcript` is derivable, which is what makes the schema safe to evolve
by drop-and-rederive.


## Injected context

A `user` record carries more than the human typed. The harness, hooks and agent-chat put
their own blocks there, and indexing them would make every session match its own
reminders and briefs. `stripInjected` removes them before a prompt reaches `search_fts`,
and `readIndexedText` applies it again on readback, so a miner excerpt shows the same
text. Only prompt spans change. `fact`, `normalized_event` and the audit tables keep
every line, and a turn with nothing left indexes no prompt span.
An index built before this rule keeps its old prompt spans until `resetIndex` rebuilds it.

- **Whole line.** A line whose session-read inbound cause is anything but `human_typed` or
  `tool_result` indexes no prompt. That covers `isMeta` lines (hook and SessionStart
  bootstrap output, skill loads, harness resumes), peer channel messages, task
  notifications, compaction summaries, scheduled wakeups, image notes and local commands.
- **Blocks cut anywhere.** session-read's closed `INJECTED_MARKERS` (`<system-reminder>`,
  `<channel source="...">`, `<task-notification>`), plus `<user-prompt-submit-hook>`,
  `<command-name>`, `<command-message>`, `<local-command-caveat>`,
  `<local-command-stdout>`, `<local-command-stderr>`, `<bash-stdout>`, `<bash-stderr>`
  and `[Request interrupted by user…]` notes.
- **Kept words.** `<command-args>` and `<bash-input>` lose their tags and keep their
  contents, because the human typed them.
- **Whole turn by text.** session-read's unclosed markers heading the text (local-command
  output, compaction summary, image note, loop wakeup, the agent-chat orientation header).
  agent-chat puts no tag around a spawn brief, so a brief is also known by the framing
  agent-chat writes itself: a `# Predecessor:` handover, the isolated or shared worktree
  note that ends the brief, or a `--- File Ownership ---` section. A brief with none of
  these still indexes, because nothing in the line tells it apart from a typed prompt.
- **Tool-result echoes.** `tool_result` blocks never enter prompt text; a user line's prompt
  span holds its text blocks only. Background results arrive as `<task-notification>`.

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

Migration 7, `origin task link`, adds nullable `task_ids` (a JSON array, primary id first)
and `task_source` columns to `session_origin`, surfaced as `ResolvedOrigin.taskIds` and
`taskSource`. It changes no existing row or edge. A row whose `task_source` is null is
offered to the resolver again on every pass, so the first pass with a task-aware resolver
is the backfill. A resolver that sets `taskIds`, even to an empty array or null, always
leaves `task_source` non-null: the given source, or `none` (`NO_TASK_LINK`) when there are
no ids. A resolver that leaves `taskIds` undefined leaves a stored link as it was, and a
row without one stays on offer. A task-aware resolver therefore returns an entry for every
requested session it examined, with `taskIds` empty when nothing links; a session it leaves
out keeps a null `task_source` and is offered again on every pass. The
upsert updates only the columns it names, so a later column keeps its value. Each linked id
projects a `task` row and a `session ran task` edge with `attrs = { via: "origin", source }`
and a confidence of 1.0 for `name` or `name-over-brief`, 0.9 for `brief-anchor` and 0.6 for
`brief-paragraph`. Only rows resolved in the current pass are projected. When a
re-resolution drops an id, only that origin-made edge expires. A transcript's `ran` edge
carries no `via`, and when a transcript claims an edge the origin made first, the edge is
superseded without `via`, so origin expiry never removes a transcript's claim.
session-graph stores and projects the ids a resolver hands it; it does not compute them.

For snapshot-only usage across multiple physical sources, queries select one source
by latest native usage timestamp, then greatest usage-record coverage and stable
source ID. Source-local reset epochs cannot safely be summed across copies. This is
a conservative projection, not a claim of complete usage across disjoint partial
sources. Response deltas still deduplicate across sources by native response ID.
Codex commit/push analytics are currently unreported (`null`), rather than zero.
