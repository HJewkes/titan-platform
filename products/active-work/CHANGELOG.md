# @titan-design/active-work

## 0.25.0

### Minor Changes

- c6a1275: `task add` now refuses an agent caller (the MCP surface, or a CLI run with `AGENT_CHAT_NAME` or `CLAUDECODE` set) whose `done_when` is missing, blank, equal to the title, or under 40 characters. The refusal is a one-line `ValidationError` (exit 65) naming the minimum, raised before the lock so no id is burned. Human CLI callers and `/rpc` are unchanged.
- 3c60c36: `task add --draft` files a task without a `done_when`, skipping the agent-caller gate. A draft is an open task tagged `draft`, not a new status, so readers that parse status as `open|done` (the standalone 0.22 CLI, the console) keep working. The bootstrap leaves drafts out of its open list; `task edit --remove-tag draft` promotes one; an agent caller is refused unless the task then has a usable `done_when`. The gate's refusal names `--draft`.
- a158182: Add the platform open-loops ledger verbs (TP-4316 A1). `loop board [--json]` (rpc `loop.board`) returns
  the ledger rows, the open session loops no ledger row claims, and the tech tree. `loop import` upserts a
  sweep snapshot and keeps any tier already set; `--tiers` seeds the untiered loops as a proposal.
  `loop tier <id> <tier> [--before <id>]` re-tiers one loop and leaves every other row byte-identical.
  `loops <slug>` rows now carry `source` and include the ledger's open rows for that initiative. The
  ledger location is the `loops.ledger` key in config.json, defaulting to
  `titan-platform/sources/open-loops.yml` and `sources/tech-tree.yml`.
- b70d46a: Let handoffs and teleports carry loops (TP-4316 A2). `loop open --origin handoff|teleport|wrap --seat <name>`
  records where a loop was filed and which seat owns it. `loop board` and `loops <slug>` list such a loop with
  `source: handoff` or `teleport` and its owning seat. A seat's newest handoff or teleport in the session index,
  when newer than a loop's last motion, advances that loop's `lastMotion` and `daysSinceMotion`.
- 616d3c9: Add `active-work spawn <name> <profile>`, a CLI-only command that spawns an agent through `agent-chat agent spawn` as the caller (via `spawnAsCaller` from `@titan-design/agent-dispatch`). It takes `--host`, `--account <name|least-used>` (default `least-used`), `--brief-file` or `--brief-stdin`, `--cwd`, `--briefing`, `--surface` and `--remote-control`, prints agent-chat's account readings and spawn line verbatim, and exits 1 with the readings on a refusal. It is not registered as an MCP tool, because the MCP daemon would reach the broker as the human.
- 42551ba: Cut workspace search over to `workspace_span`. The workspace pass writes the new table, backfills a graph that still holds workspace spans in `search_span` (resuming after an interrupted pass), and flips readers once a pass finishes by deleting the legacy rows in one transaction. `miner refresh --reset-workspace-spans` rebuilds the table from the files, `miner status` reports `workspaceBackfill`, and term frequency counts both tables.
- dbb5afc: Add graph migration 1003, which creates empty `workspace_span` and `workspace_fts` tables (contentless-delete), a `workspaceSpans` handle on the opened graph, and a span-table selector for workspace-class readers. Nothing writes or reads the new tables by default yet; the selector picks them only when told to cut over.
- ab997d9: `task add` lists up to three related open tasks from the same initiative in `warnings` for agent callers. The list is advisory and fails open: a missing or degraded index, a thrown read or a 1 s deadline prints nothing and leaves the task filed. Humans and `/rpc` callers skip the read, which costs about 0.7 s per add (TP-2544).
- 86fa087: `task add` tags an agent-filed task `possible-dup:<id>` when its title scores at least 0.9 title jaccard against the closest related open task. A refused tag write warns and leaves the task filed; the older task is never edited (TP-2544).
- 09b7346: active-work indexes transcripts with the session-graph defaults, so no pass writes `tool_input` or `tool_result` spans or `context_block` rows, and transcript search scopes to `prompt` and `assistant_response` only (TP-881). A graph indexed earlier keeps its tool spans until a full rebuild, but search no longer reads them.

  `RefreshSummary` and the daemon's `session index pass` log line carry `rowsWritten` (the pass's `total_changes()` delta) and `dbBytes` (`page_count * page_size` when the pass ends).

- 86ba043: Add `active-work miner rebuild` (TP-882). It indexes the corpus into a fresh `graph.sqlite3.next` without the refresh lock, carrying over the `transcript` rows with their ids (rewound, so every file is re-read), `preserved_row`, the `pr` rows with their forge columns and the GitHub review verdicts. Then, under the lock, it catches both files up and compares their totals: row counts of every table a preserved session replays into, plus turn and token sums. If they match, it keeps the old file as a hard-linked `graph.sqlite3.bak-pre-rebuild-<time>` and renames the new file over the path, so the path never goes missing. A `graph.sqlite3.swapped` marker records the new inode. A totals mismatch leaves `.next` in place; `--force` swaps anyway and `--resume` continues an existing `.next`. `miner refresh --full` is unchanged.

  The daemon now compares the inode at the graph path with its open handle inside the lock before each pass, and reopens the graph and its checkpoint worker when they differ.

### Patch Changes

- ee25079: Name a spawned server's startup death in the daemon and MCP integration tests: the failure now carries the child's exit status and stderr instead of "never became healthy" after 15 s or a bare "Connection closed".
- e8e0261: Class-scoped span search no longer ORs common words into its query. FTS5 ranks every match before the class filter applies, so words like `agent` or `now` made each bootstrap and `context related` query rank most of the corpus. `deriveQuery` and the bootstrap note ranking now drop terms that match more than 1% of spans (never below 2,000), keeping the three rarest when fewer clear the cap. Document frequency is read from the FTS5 vocabulary for common terms and counted exactly for rare ones.
- bc9e89a: Bootstrap loop retrieval now has a 1,500 ms wall-clock budget. Once it is spent, `relatedForLoops` stops querying the remaining loops and records a `loop-retriever: budget` entry in `retrieval_degraded`, so a slow index delays launch by a bounded amount.
- 01f155f: Index the precedent test fixture once and keep it off the host agent-chat log. Test-only; no runtime change.
- 16731da: Run most CLI integration cases in process through commander's `parseAsync`, and start the daemon and stdio MCP tests from the built `dist/cli.js` instead of a `tsx -e` transpile, with session indexing off where a test does not need it. Test-only; no runtime change.
- c00a913: Point the subagent-tree test at an empty agent-chat home so each refresh no longer reads the host's real event log (50.7 s to 0.5 s CPU).
- ff961c6: Make `task.list` faster on large active roots. It now keeps each parsed task file in memory and re-parses a file only when its mtime, size or inode changes, so a warm `--all-initiatives` list stats files instead of parsing them. It reads with bounded concurrency and applies the status, tag, severity, id and search filters as each task loads. Files stay authoritative, and a direct edit shows on the next call.
- 118ba3b: Type the own-schema SQLite row reads with `prepare<Params, Row>` instead of `as` casts; no behavior change.
- c1069fc: Narrow `gh` wire JSON and stored JSON columns with zod instead of `as` casts. A malformed element in a `gh pr list` answer or a malformed preserved row is now skipped and reported rather than thrown or passed through, and a note whose stored tags do not parse is indexed as untagged.
- b55abc2: Workspace-class queries keep their common terms once a graph has cut over to the workspace span table. They rank only that small table, so the document-frequency cap no longer pays for itself there. Queries that include `transcripts`, and any query on a graph still holding legacy workspace spans, stay capped.
- 01bd8f8: session recover: identify live claude processes on Linux from `/proc/<pid>/cmdline`, since `ps` reports the thread name `MainThread` there.
- 5449af7: Refuse a repeated `--add-tag` or `--remove-tag` on `task edit` with a usage error instead of silently keeping only the last tag.
- ea437a6: The agent-chat origin resolver maps a spawn's `route_*` meta onto the session-graph route origin columns; absent or non-string values stay null.
- 9dd8d1c: `context.related` asks the daemon only for workspace freshness. It no longer starts or waits on a transcript delta pass; a changed workspace file waits on a workspace-only refresh within the 800 ms budget.

  The workspace watcher ignores the miner root, so the daemon's own index and lock writes no longer mark the workspace dirty.

- f9d0337: Session-index passes roll up one session per transaction and yield after each, so a delta pass's rollup and a full pass's resume of unfinished turns no longer hold the daemon's event loop for seconds.
- 25ef1b2: A full pass gathers the sessions with unfinished turns a page at a time and yields between pages, so a pass resuming many unfinished turns no longer holds the daemon's event loop for one long query.
- 61005b1: The session-index daemon runs its SQLite WAL checkpoints in a worker thread and no longer syncs each commit, so a slow disk's fsyncs no longer stall the daemon's event loop during a pass.
- a275fa2: `miner rebuild` now holds a lock on `graph.sqlite3.next` for the whole rebuild, so two rebuilds (two `--resume` runs included) can no longer build into the same file; the second is refused.
- ee694a0: A sealed transcript of a retired agent whose audit facet is behind the current extraction version now stays in the session-index walk until the facet backfill upgrades it, so it also counts in `facetBacklog`.
- e2cc9eb: The workspace index writes its derived edges by diff: a pass inserts only new edges and deletes only vanished ones, so a refresh over an unchanged workspace writes no edge rows and no longer grows `edge_id`.
- 3cd97bc: The session-index pass summary and the daemon's pass log line carry `prsPolled`, the number of PRs the pass asked `gh` about.
- 436f1b1: Add `scripts/task-add-replay.mjs`, a read-only replay of recent task creation against the done_when gate and title similarity bands, and depend on `@titan-design/memory` for its `jaccard` (TP-2544).
- 4ea1e82: `context.related` with a `trigger` no longer serves hits from the charter's `human_only_initiatives` (TP-4140). When the charter is unreadable, a triggered call serves only hits from its own `initiative` and reports a `charter` degradation. Calls without a trigger are unchanged.
- 49fa132: Full and `--full` index passes no longer hold the event loop for seconds (TP-4175). `refreshCorpus` and `indexTranscript` take a `yieldPoint`. With one, each transcript's delta is applied by the new `applyDeltaYielding` in bounded steps inside one transaction held open across the yields, so it still commits or rolls back whole. The rollup runs one session per transaction with a yield after each. Without a `yieldPoint`, nothing changes. session-analytics adds `staleEpisodeSessionsYielding`, which pages the backlog sweep by session and returns the same list as `staleEpisodeSessions`. active-work's full pass passes its `yieldPoint` to both. On a fixture of 500 transcripts, the longest synchronous chunk of a `--full` rebuild drops from 2380 ms to 141 ms.
- 59b27e3: session-graph exports `rollupYielding`, the session-by-session rollup with a yield after each that `refreshCorpus` runs when given a `yieldPoint` (TP-4261). active-work's delta pass and unfinished-turn sweep use it in place of their own copy.
- 4f12cf6: The CLI reference generator spawns each command's `--help` once instead of twice, halving the time `prepack` and the cli-reference test spend. The generated reference is unchanged.
- 096f1d9: The CLI reference generator renders every command's help in process from the built program instead of spawning the CLI once per command, so `prepack` and the cli-reference test take well under a second. The generated reference is unchanged.
- c8c30ac: Open agent-chat's events.db with a 100 ms busy timeout when resolving session origins, so a session-index refresh no longer blocks up to 5 s while agent-chat holds the database.
- b535e66: Cache each initiative's `inventory` scan in the daemon, keyed by its record directories' mtimes with a 30 s TTL, so repeat calls skip the per-file stat walk (TP-4508).
- 8dd74d3: Read caught errors in the setup steps through the rpc-protocol narrowing helpers instead of `err as` casts. A thrown non-Error now prints as `String(err)`.
- 643cb76: Narrow JSON and YAML files read from disk instead of casting them. A malformed refresh-lock holder or launch plan now reads as absent, the artifact hash manifest drops entries that are not strings, and `setup` no longer rewrites an agent-chat `hooks.json` whose hook list is not a list.
- a522ed1: Rank an agent's task add related list in memory from the initiative's open tasks instead of the SQLite index, so the read costs milliseconds, never blocks the daemon on FTS, and its deadline is hard.
- 45c7503: The v3-to-v4 migration now leaves an `artifacts.yml` it cannot parse untouched, keeps that initiative's brief as it was, and records the skip in `.migrations.log`. The v1-to-v2 migration skips null list elements instead of throwing.
- 63c63b1: The v3-to-v4 migration now also leaves an `artifacts.yml` that parses to a scalar or a list untouched, keeps that initiative's brief as it was, and records the skip in `.migrations.log`.
- 1adec62: Port three standalone fixes: `aw --profile <name>` picks the Claude account, `task add` skips a task file that does not validate and keeps its id, and reopening a task clears `done_at`.
- 0ee1558: `active-work open` starts the live branch status fetch before note ranking and loop retrieval and awaits it only when the artifacts section renders, so the two overlap instead of adding up. The prompt is unchanged.
- bd70f2c: `active-work open` parses each task file once: `archiveStaleTasks` returns the tasks it loaded (minus the archived ones) and the bootstrap reuses them instead of reading the task directory again.
- 21d40e0: `active-work open` now reports per-phase timings (`load`, `archive`, `live_status`, `rank_notes`, `loop_retrieval` with its query count, and `total`) in `metadata.timings_ms`, never in the prompt. `AW_TIMING=1` prints them as one stderr line from `aw` and `active-work open`.
- 78ae7d9: Stop writing tool spans, context blocks and unchanged state echoes by default (TP-880).

  session-read: `ReadOptions` gains `toolSpans` and `contextBlocks` (default true), passed to `LineReader` as an optional `EmitPolicy`. A fact from an echo line (`ai-title`, `custom-title`, `agent-name`, `mode`, `permission-mode`, `cost-state`) carries `state: { key, value }`; `atis-latch`, `bridge-session` and `last-prompt` emit no fact. `EXTRACT_VERSION` is 9.

  session-graph: `IndexOptions` gains `indexToolSpans` and `contextBlocks` (default false); `refreshCorpus` forwards `contextBlocks` to `backfillFacets`. Migration 14 replaces `session_state` with `echo_state`, keyed per transcript, and an echo fact is stored only when its value changed. `turn.thinking_ms` now counts the gap from a tool result past a skipped echo.

  session-miner and active-work keep storing tool spans and context blocks; active-work does so on both its full and delta passes.

- Updated dependencies [59db533]
- Updated dependencies [c1af4ba]
- Updated dependencies [73c018b]
- Updated dependencies [74ad076]
- Updated dependencies [81395d7]
- Updated dependencies [9411e94]
- Updated dependencies [dcbf00e]
- Updated dependencies [e391005]
- Updated dependencies [d0d51f1]
- Updated dependencies [f85e2ba]
- Updated dependencies [b7c8320]
- Updated dependencies [25fcc67]
- Updated dependencies [1ac0fa2]
- Updated dependencies [24f1577]
- Updated dependencies [7b901b2]
- Updated dependencies [2242334]
- Updated dependencies [9b03130]
- Updated dependencies [5ada6c1]
- Updated dependencies [211db45]
- Updated dependencies [5ba850e]
- Updated dependencies [f896485]
- Updated dependencies [292fbe9]
- Updated dependencies [ed8310b]
- Updated dependencies [fa9516b]
- Updated dependencies [26598f3]
- Updated dependencies [792265b]
- Updated dependencies [db5ea61]
- Updated dependencies [e8fbf15]
- Updated dependencies [974b429]
- Updated dependencies [2380fd4]
- Updated dependencies [f896485]
- Updated dependencies [a20c348]
- Updated dependencies [b6ce883]
- Updated dependencies [b6ce883]
- Updated dependencies [820d4d2]
- Updated dependencies [42551ba]
- Updated dependencies [42b6a21]
- Updated dependencies [6554538]
- Updated dependencies [5a67a0b]
- Updated dependencies [cfdfb64]
- Updated dependencies [ff6fb95]
- Updated dependencies [c58d555]
- Updated dependencies [7813c1f]
- Updated dependencies [02ed42b]
- Updated dependencies [f996bb9]
- Updated dependencies [6525ba7]
- Updated dependencies [9dd8d1c]
- Updated dependencies [207a81b]
- Updated dependencies [207a81b]
- Updated dependencies [f77d79d]
- Updated dependencies [5edd38d]
- Updated dependencies [9b42150]
- Updated dependencies [90f36b4]
- Updated dependencies [8e09d50]
- Updated dependencies [b672645]
- Updated dependencies [37d60d1]
- Updated dependencies [cd8a1ce]
- Updated dependencies [00fb3ee]
- Updated dependencies [c1f9297]
- Updated dependencies [646f4d7]
- Updated dependencies [b8e2df5]
- Updated dependencies [5f33d7a]
- Updated dependencies [5f2b39f]
- Updated dependencies [52dc7f3]
- Updated dependencies [cb470f4]
- Updated dependencies [49fa132]
- Updated dependencies [59b27e3]
- Updated dependencies [fcb7e85]
- Updated dependencies [d46cbce]
- Updated dependencies [3d709d8]
- Updated dependencies [ae64085]
- Updated dependencies [147ff5d]
- Updated dependencies [4eb9812]
- Updated dependencies [1bc6431]
- Updated dependencies [342c6ba]
- Updated dependencies [342c6ba]
- Updated dependencies [0100482]
- Updated dependencies [9028bd0]
- Updated dependencies [9396ce4]
- Updated dependencies [29062e0]
- Updated dependencies [9d74995]
- Updated dependencies [78ae7d9]
  - @titan-design/agent-dispatch@0.10.0
  - @titan-design/session-analytics@0.18.0
  - @titan-design/daemon@0.9.0
  - @titan-design/decider@0.7.0
  - @titan-design/agent-protocol@0.10.0
  - @titan-design/session-read@0.17.0
  - @titan-design/session-graph@0.19.0
  - @titan-design/registry@0.6.0
  - @titan-design/retrieval@0.4.0
  - @titan-design/store-sqlite@0.5.0
  - @titan-design/locator@0.2.2
  - @titan-design/memory@0.3.1
  - @titan-design/rpc-protocol@0.4.0
  - @titan-design/cluster@0.3.0

## 0.24.4

### Patch Changes

- Updated dependencies [9914239]
- Updated dependencies [9914239]
- Updated dependencies [9914239]
- Updated dependencies [9914239]
- Updated dependencies [9914239]
- Updated dependencies [9914239]
- Updated dependencies [9914239]
  - @titan-design/session-graph@0.18.0
  - @titan-design/agent-protocol@0.9.0
  - @titan-design/session-read@0.16.1
  - @titan-design/session-analytics@0.17.4

## 0.24.3

### Patch Changes

- Updated dependencies [41fce70]
  - @titan-design/session-read@0.16.0
  - @titan-design/decider@0.6.6
  - @titan-design/session-analytics@0.17.1
  - @titan-design/session-graph@0.17.1

## 0.24.2

### Patch Changes

- Updated dependencies [a67d654]
  - @titan-design/pm@0.4.0

## 0.24.1

### Patch Changes

- Updated dependencies [9b5d49f]
  - @titan-design/daemon@0.8.0

## 0.24.0

### Minor Changes

- 0e37074: active-work now publishes from titan-platform. The product lives at `products/active-work` and
  depends on the workspace `@titan-design/*` packages; the CLI, bins, skill install and packaged
  files are unchanged.
