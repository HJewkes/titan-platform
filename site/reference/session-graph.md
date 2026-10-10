# session-graph

**Tier 2 · domain.** Depends on [`session-read`](/reference/session-read),
[`store-sqlite`](/reference/store-sqlite),
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

Verified against 0.13.2.

```ts
import os from "node:os";
import path from "node:path";
import { discoverTranscripts } from "@titan-design/session-read";
import { openSessionGraph, refreshCorpus } from "@titan-design/session-graph";

const graph = openSessionGraph(path.join(os.homedir(), ".local/state/miner/index.sqlite3"));
const summary = await refreshCorpus(graph, await discoverTranscripts());

// {
//   transcripts: 8, indexed: 8, unchanged: 0, rewound: 0, missing: 0, quarantined: 0,
//   facts: 1899, turnsRolledUp: 10,
//   reconciled: { prCreates: 0, prMerges: 0, subagents: 0 },
//   tasks: { requested: 0, applied: 0, failed: false },
//   origins: { requested: 0, applied: 0, events: 0, failed: false },
//   prs: { requested: 0, applied: 0, failed: false },
//   reviews: { resolved: 0, unresolved: 0, invalidTimes: 0 },
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
7. **`projectReviewRounds`** resolves chat verdicts and writes review rounds (below).
8. **`enrichTasks`** runs if you passed a `resolveTasks` resolver (below).
9. Rows whose source file has vanished are marked `missing`. **Their facts stay** — surviving
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

**Kit tables:** `transcript` (watermark), `edge` (bi-temporal, `session:… touched file:…`),
`search_span` + `search_fts` (contentless full-text over prompts, responses, tool inputs and
results, keyed by the session ref).

**Domain tables:** `fact`, `session`, `session_model_usage`, `turn`, `permission_phase`,
`human_edit`, `file_checkpoint`, `pr`, `branch`, `file`, `task`, `subagent`, `artifact`, the
two PR observation tables, and `pr_review`.

`pr_review` holds one row per review verdict. A chat row comes from a `chat_send` tool use
that session-read parsed a verdict from, keyed `chat:<tool_use_id>:<n>` where `n` is the
verdict's `ordinal` in that message. An event from a session-read that predates `ordinal`
takes the next index its tool use has not used in that `applyDelta` call; that session-read
emits all of one tool use's verdicts from one line, so the keys cannot collide across calls. It keeps only the parsed fields (verdict, repo, repo hint,
PR number, and the repo of the sender's working directory), never message text, and is purged
with its transcript. `pr_ref` stays null until a later pass resolves it.

`resetIndex` drops `pr` rows and forge review rows with everything else, so `commit_times`,
`review_rounds_gh` and the forge reviews return only when a resolver answers again.

Not everything can be rebuilt from transcripts. Original sources can be pruned, so schema
migrations must preserve `fact` and `session` rows rather than assuming a replay is possible.
`resetIndex` clears the tables in `DERIVED_TABLES`, including `fact` and `session`. That is a
deliberate reset, not a migration step. It keeps the `transcript` watermark table (rewound, not
deleted), `price` and `session_state`, which nothing derives from transcripts, and `conversation`
and `conversation_alias`, which are derived from `session` rows or sources but are not in
`DERIVED_TABLES`. `session_origin` and `session_external_event` are not derived from transcripts
either: `resetIndex` clears them and the next pass refills them from their own sources.

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
- **Headless prompts.** A line whose `promptSource` is `sdk` indexes no prompt. The host
  writes `sdk` for every headless turn, which is how an agent-chat spawn brief with no
  framing is told apart from a typed prompt. The cost: a person running `claude -p` also
  writes `sdk` turns, and those are excluded too. Pass `indexSdkPrompts: true` to
  `refreshCorpus`, `indexTranscript` or `applyDelta` to keep them. `isUntypedPrompt` exposes
  the rule.
- **Blocks cut on their own lines.** session-read's closed `INJECTED_MARKERS`
  (`<system-reminder>`, `<channel source="...">`, `<task-notification>`), plus
  `<user-prompt-submit-hook>`, `<command-name>`, `<command-message>`,
  `<local-command-caveat>`, `<local-command-stdout>`, `<local-command-stderr>`,
  `<bash-stdout>` and `<bash-stderr>`. A block is cut only when its opening tag starts a
  line and its closing tag ends one (another cut block may follow on the same line). Nested
  tags of the same name are balanced. A tag quoted inside a sentence stays.
  `[Request interrupted by user…]` notes are cut wherever they sit.
- **Kept words.** `<command-args>` and `<bash-input>` lose their tags and keep their
  contents, because the human typed them.
- **Whole turn by text.** session-read's unclosed markers heading the text (local-command
  output, compaction summary, image note, loop wakeup, the agent-chat orientation header).
  agent-chat puts no tag around a spawn brief, so a brief typed into a live session is known
  by the framing agent-chat writes itself: a `# Predecessor:` handover, or the isolated or
  shared worktree note that ends the brief.
- **Tool-result echoes.** `tool_result` blocks never enter prompt text; a user line's prompt
  span holds its text blocks only. Background results arrive as `<task-notification>`.

## Gotchas

**One session can live in several transcripts.** A mirror from another host and a resume
that copied its history both hold lines of a session under the same session id. The `session`
row is keyed by that id, and each file is a child transcript, so the copies never make a
second session. Whenever a session has facts in more than one transcript, the rollup
recounts `turn_count`, `commit_count` and `push_count`. A line found verbatim in several files
counts once, and so does a commit or push signal. Read `session_signal` through
`SIGNAL_COPY_RANK` (`copy_rank = 1`) to count signals the same way. `purgeTranscript` on one
copy hands the session row to another copy rather than deleting it, and recounts it from the
facts left. A turn, phase, edit, checkpoint, subagent or edge that pointed at the copy's line
moves to the other copy's verbatim line, or goes if no copy holds one. Only that copy's search
spans are dropped.

**`refreshCorpus` takes `DiscoveredTranscript` objects**, not paths. Use
`discoverTranscripts()` rather than assembling them yourself; the `displayPath` field is the
watermark key.

**Same-length rewrites need `verifyHash`.** Without it, a rewritten file of identical length
looks `unchanged`.

**No transcript text is stored.** The FTS index is contentless: hits carry a locator and you
read the text back with `readIndexedText(graph, span)`, which resolves Codex sources and
strips injected text from prompt spans. Reading raw bytes by [`locator`](/reference/locator)
returns the injected text too.

**`schemaVersion` is the caller's version, not this package's.** `openSessionGraph` accepts
one and refuses a database stamped past it, before any migration runs. Pass the top of the
schema *you* own: this package's `MIGRATIONS` are one band of a shared database, and a
product layering its own tables sits above them. `products/session-miner` numbers its own
from 2000 and passes 2002, clear of active-work's band at 1001.

**`readonly: true` reads a graph someone else owns.** No migrations run and nothing is
written. The open throws `SessionGraphNotMigratedError` when the graph lacks any migration
this package declares.

**`normalized: true` opts in to the `normalized_*` tables.** A graph holds none unless it was
opened with it (ignored with `readonly`). See migration 9.

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

`hasNormalizedTables` is the one presence rule every normalized reader uses: both
`normalized_event` and `normalized_source` must exist. A read-only graph that migration 9
left without them reads as empty, never as an error. `countNormalizedSessions` and
`countNormalizedEvents` give totals, `normalizedSourcePath` maps a transcript to its
rollout file, `normalizedConversationDetail` returns turns in start order with each turn's
distinct tool calls (one grouped query) plus lineage edges both ways, and
`normalizedErrorFacts` lists error tool results of readable transcripts, oldest first.

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
  A price row matches only when the model id equals its prefix or continues with `[..]` or
  `-YYYYMMDD` (optionally followed by `[..]`), so `claude-opus-5` never prices `claude-opus-5-9`.
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

Migration 8, `review verdicts`, adds the `pr_review` table, one row per review verdict from
either surface (`chat` or `gh`). Only parsed fields are kept, never message text.
`source_key` is the primary key, `chat:<tool_use_id>:<n>` or `gh:<pr_ref>:<submitted_at>`,
and `pr_ref` is filled in later. It also adds `review_rounds_gh`, `review_rounds_chat` and
`commit_times` columns to `pr`, copies each PR's existing `review_rounds` into
`review_rounds_gh`, and clears `outcome_checked_at` so the next pass re-queues every PR for
its outcome. `resetIndex` and `purgeTranscript` clear `pr_review` too.

Migration 9, `stop storing bulk classes`, runs DDL only and deletes no row it keeps. It drops
the `artifact` table. It drops `normalized_span`, `normalized_event` and `normalized_source`
only when every one that exists is empty, so a graph that holds Codex evidence keeps all
three. It then creates `session_state` (`session_id`, `key`, `value`, primary key
`(session_id, key)`) if missing.

Migration 10, `request_cost model-id boundary`, runs DDL only and rewrites no row: it drops
and recreates the `request_cost` view with the same columns. Only the price join changes. A
`price` row now matches a request only at a model-id boundary: the model equals the prefix, or
the prefix is followed by `[..]`, or by `-YYYYMMDD` with an optional `[..]`. Longest prefix,
then latest `effective_from`, still wins. A model the prices do not list, such as an
`claude-opus-5-9` against a `claude-opus-5` row, no longer takes the shorter prefix's rate; it
reads `priced = 0` and shows under the cost report's `unpricedModels`.

The normalized tables are now opt-in. `openSessionGraph(path, { normalized: true })` creates
them when absent; without it a graph holds none unless migration 3 left rows in them.
`normalized` is ignored with `readonly: true`. Open with it before calling `indexCodexSource`.
