# @titan-design/active-work

## 0.27.0

### Minor Changes

- e2a51ca: `task add` and `task edit` take the task provenance fields: `--class`, `--serves` (checked against the plan's outcomes), `--source` with `--source-ref` or `--from-pr` and `--from-task`, and `--blocked-on`; each value given is marked `filed` in `field_origin`. `task add` records `filed_by` from `AGENT_CHAT_NAME` (or `owner` from a plain terminal), never from an argument, and refuses a task that leaves out a field the brief's `task_require` lists. Once a task has started or a spawn names it, `task edit` refuses changes to class, source and serves. `task done --reason` records `done_reason`. New read verb `task rank show <slug>` lists ranked tasks; no verb sets a rank (TP-5446 S8).
- 5346139: Add the owner's planning ops (TP-5453 P3b): `plan-bet-select`, `plan-outcome-edit` and `plan-freeze-set` join the owner-queue op schema. The console offers each as an owner-op tap. Its read-back comes from the factory's `owner-op.preview`: each bet's outcome, prediction and tasks, an outcome's before and after, and what a freeze stops and when it ends. The factory gates the ops to owner-remote under HV-OR and applies them through pm's plan store under the initiative's plan lock. pm's `FreezeSchema` gains an optional `ended_on`. active-work's `plan freeze add` now records `set_by: decider` and refuses `--set-by owner`. No CLI, RPC or MCP verb selects a bet, edits an outcome or ends a freeze.

### Patch Changes

- 4caefe3: A task filed over the daemon's /rpc or MCP surface records `filed_by: unknown`. Before this, it took the daemon's own `AGENT_CHAT_NAME`, or `owner` when the daemon had none (TP-5446 S8 follow-up).
- Updated dependencies [5346139]
  - @titan-design/pm@0.9.0

## 0.26.0

### Minor Changes

- 5bb6512: Add `active-work plan` verbs over one validated file per record under `<initiative>/plan/`: `outcome`, `bet`, `freeze` and `out-of-scope`, each with `add`, `show` and `list`, also served over RPC and MCP. `plan bet add` writes a proposed bet; `plan outcome add` writes a draft once and refuses an existing outcome. No verb selects a bet or edits an outcome: those are owner actions. Lists across initiatives skip owner-only ones. `task add` and `task edit` take `--bet`, `--fold` and `--owner-step`, and a task's bet is now checked against the plan store (TP-5453 P3a).

### Patch Changes

- fc303a7: Add the optional task fields `bet`, `fold` and `owner_steps` to `TaskSchema`, with `BetLookup` and `betProblem` for the write-time check that a task's bet exists. active-work's `task add` and `task edit` refuse a task naming a bet the lookup does not know (TP-5453 P2).
- d497596: Add a `./node` subpath to pm holding the planning-record file store (read, validated atomic write, the `<initiative>/plan/.lock`), so every plan writer shares one layout and one lock; the root entry stays pure. active-work's plan store is now a thin adapter over it, with no change in behaviour.
- Updated dependencies [fc303a7]
- Updated dependencies [d497596]
  - @titan-design/pm@0.8.0

## 0.25.2

### Patch Changes

- 46ae5e5: Add the task provenance fields `class`, `serves`, `source`, `source_ref`, `filed_by`, `rank`, `done_reason`, `blocked_on` and `field_origin` to `TaskSchema`, all optional on read, and `TaskRequireSchema` for a brief's `task_require` list, which active-work's brief schema now reads (TP-5446 S7).
- Updated dependencies [46ae5e5]
  - @titan-design/pm@0.7.0

## 0.25.1

### Patch Changes

- Updated dependencies [feec10d]
  - @titan-design/pm@0.6.0

## 0.25.0

### Minor Changes

- 71f1af2: Every array flag takes `@<file>`: the file's non-blank lines, trimmed, each counted as one more use of the flag (TP-5228). An empty or unreadable file is a usage error that names it, and a comma in a line is refused as it is on the command line. The expansion moved from `miner cost --session-ids` into the CLI layer, so `miner.cost` called over RPC now takes `@...` values literally.
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
- 445bc8f: The active-work CLI builder now projects each command's zod schema through `@titan-design/registry`'s commander helpers instead of its own copies.

  Breaking: comma-splitting of array flags is gone. Pass an array flag once per value: `--tags a --tags b`. A value that contains a comma is now refused with exit 64 and an error that shows the repeated form, for example `--tags a,b: pass --tags a --tags b`, so an old-style `--tags a,b,c` fails before anything is written instead of storing one wrong tag. This applies to every array flag: `task add` `--tags`/`--dep`/`--deliverable`, `task edit` `--dep`/`--remove-dep`/`--deliverable`, `note add --tags`, `deliverable add --tags`, `deliverable list --tag`, `facet add --tags`, `context related` `--classes`/`--exclude` and `discover` `--github-repos`/`--local-repos`. Their help text now says "Repeat the flag for each value", and the README and skill examples use the repeated form. Scripts that pass comma lists to these flags must switch to repeated flags.

  `facet add --tags`, the one required array flag, now keeps every occurrence instead of only the last.

  A `.default()` positional is shown as optional, so `edit <slug> [target]` no longer demands a target it already defaults.

  session-miner's weekly tool-gap run now passes each tag as its own `--tags` flag when it files an active-work task, which works on both the old and the new active-work.

- cafdc0c: `context.related` gains `mode: "context"` (TP-528, TP-109 S3): a token-budgeted block planned by `@titan-design/retrieval`'s `planContext`, with class shares as token quotas and three workspace tiers (see-line, excerpt, span text capped at 2,000 characters). List mode, the default, is unchanged.
- 616d3c9: Add `active-work spawn <name> <profile>`, a CLI-only command that spawns an agent through `agent-chat agent spawn` as the caller (via `spawnAsCaller` from `@titan-design/agent-dispatch`). It takes `--host`, `--account <name|least-used>` (default `least-used`), `--brief-file` or `--brief-stdin`, `--cwd`, `--briefing`, `--surface` and `--remote-control`, prints agent-chat's account readings and spawn line verbatim, and exits 1 with the readings on a refusal. It is not registered as an MCP tool, because the MCP daemon would reach the broker as the human.
- 42551ba: Cut workspace search over to `workspace_span`. The workspace pass writes the new table, backfills a graph that still holds workspace spans in `search_span` (resuming after an interrupted pass), and flips readers once a pass finishes by deleting the legacy rows in one transaction. `miner refresh --reset-workspace-spans` rebuilds the table from the files, `miner status` reports `workspaceBackfill`, and term frequency counts both tables.
- dbb5afc: Add graph migration 1003, which creates empty `workspace_span` and `workspace_fts` tables (contentless-delete), a `workspaceSpans` handle on the opened graph, and a span-table selector for workspace-class readers. Nothing writes or reads the new tables by default yet; the selector picks them only when told to cut over.
- ab997d9: `task add` lists up to three related open tasks from the same initiative in `warnings` for agent callers. The list is advisory and fails open: a missing or degraded index, a thrown read or a 1 s deadline prints nothing and leaves the task filed. Humans and `/rpc` callers skip the read, which costs about 0.7 s per add (TP-2544).
- 86fa087: `task add` tags an agent-filed task `possible-dup:<id>` when its title scores at least 0.9 title jaccard against the closest related open task. A refused tag write warns and leaves the task filed; the older task is never edited (TP-2544).
- ad90aec: Add an initiative-level `visibility` (`owner-only` | `agent-visible`) to the brief and one predicate, `isAgentVisible`, in `@titan-design/pm` (TP-5453 P6). A brief with no `visibility`, or one that will not parse, is owner-only; a dated transitional list keeps the named code initiatives visible until their briefs declare it.

  active-work: the workspace indexer stores only the initiative row of an owner-only initiative; `search`, the MCP search tool, `context.related`, the cross-initiative `context.graph` scan, `precedent search` and the bootstrap's foreign notes serve no owner-only initiative. `context.related` no longer reads the charter's `human_only_initiatives` and no longer reports a `charter` degradation. `set <slug> visibility <value>` is how the owner marks a brief, and it refuses an agent caller.

  evals: the task-initiative allow-list and private markers come from `isAgentVisible` instead of a hard-coded list.

- 09b7346: active-work indexes transcripts with the session-graph defaults, so no pass writes `tool_input` or `tool_result` spans or `context_block` rows, and transcript search scopes to `prompt` and `assistant_response` only (TP-881). A graph indexed earlier keeps its tool spans until a full rebuild, but search no longer reads them.

  `RefreshSummary` and the daemon's `session index pass` log line carry `rowsWritten` (the pass's `total_changes()` delta) and `dbBytes` (`page_count * page_size` when the pass ends).

- 86ba043: Add `active-work miner rebuild` (TP-882). It indexes the corpus into a fresh `graph.sqlite3.next` without the refresh lock, carrying over the `transcript` rows with their ids (rewound, so every file is re-read), `preserved_row`, the `pr` rows with their forge columns and the GitHub review verdicts. Then, under the lock, it catches both files up and compares their totals: row counts of every table a preserved session replays into, plus turn and token sums. If they match, it keeps the old file as a hard-linked `graph.sqlite3.bak-pre-rebuild-<time>` and renames the new file over the path, so the path never goes missing. A `graph.sqlite3.swapped` marker records the new inode. A totals mismatch leaves `.next` in place; `--force` swaps anyway and `--resume` continues an existing `.next`. `miner refresh --full` is unchanged.

  The daemon now compares the inode at the graph path with its open handle inside the lock before each pass, and reopens the graph and its checkpoint worker when they differ.

### Patch Changes

- ee25079: Name a spawned server's startup death in the daemon and MCP integration tests: the failure now carries the child's exit status and stderr instead of "never became healthy" after 15 s or a bare "Connection closed".
- babe043: Fix type errors in 14 `src/commands` tests ahead of re-enabling their typecheck. Test only; no production code changes.
- 6897686: Log one warning when a failing delta pass starts its backoff, and one info line when a pass next succeeds, instead of a warning per reader.
- fbaeccc: A failing session-index delta pass now backs off, doubling per failure up to the maximum, instead of retrying on every reader call. Until the deadline readers get `stale` without a pass starting; a successful pass clears the backoff. Lock-contention deltas and the full-pass backoff are unchanged.
- e8e0261: Class-scoped span search no longer ORs common words into its query. FTS5 ranks every match before the class filter applies, so words like `agent` or `now` made each bootstrap and `context related` query rank most of the corpus. `deriveQuery` and the bootstrap note ranking now drop terms that match more than 1% of spans (never below 2,000), keeping the three rarest when fewer clear the cap. Document frequency is read from the FTS5 vocabulary for common terms and counted exactly for rare ones.
- 4784f80: `/health` `index` now reports `held`, `holdReason` and `heldSince`, and `miner status` shows them when the session index is held.
- a6182c2: The session-index scheduler now caps how long its memory-pressure gate may hold. After `maxHoldMs` (default 30 minutes) of continuous hold it lets one pass through, restarts the hold clock, and reports the release as `hold cap <n> ms reached`.
- bc9e89a: Bootstrap loop retrieval now has a 1,500 ms wall-clock budget. Once it is spent, `relatedForLoops` stops querying the remaining loops and records a `loop-retriever: budget` entry in `retrieval_degraded`, so a slow index delays launch by a bounded amount.
- c41f726: PR outcome polling now orders its batch in three bands, matching session-graph: never-checked PRs, then due open or closed PRs, then merged PRs that only lack commit times. Within a band the least recently checked go first, then by PR ref. A backlog over the cap no longer lets commit-times backfill crowd out due open PRs.
- 01f155f: Index the precedent test fixture once and keep it off the host agent-chat log. Test-only; no runtime change.
- a8a9ecf: Pass the scripted pressure probe in the delta-backoff scheduler test and anchor the restart-successor wait test to a moment the predecessor is known to be running. Test only; no production code changes.
- 16731da: Run most CLI integration cases in process through commander's `parseAsync`, and start the daemon and stdio MCP tests from the built `dist/cli.js` instead of a `tsx -e` transpile, with session indexing off where a test does not need it. Test-only; no runtime change.
- dc8c26f: `mcp restart` now reports the serving daemon's pid from `/health`, the one `mcp status` and the pid file show, instead of the successor wrapper's pid.
- f640120: Share one `asTask` test helper from `src/test-support` instead of seven copies. Test only; no production code changes.
- c00a913: Point the subagent-tree test at an empty agent-chat home so each refresh no longer reads the host's real event log (50.7 s to 0.5 s CPU).
- ff961c6: Make `task.list` faster on large active roots. It now keeps each parsed task file in memory and re-parses a file only when its mtime, size or inode changes, so a warm `--all-initiatives` list stats files instead of parsing them. It reads with bounded concurrency and applies the status, tag, severity, id and search filters as each task loads. Files stay authoritative, and a direct edit shows on the next call.
- b70c736: Tighten the setup and spawn test fakes, read the task id through the parsed helper in the task-add gate tests, and make the ghost-profile resume test assert the real spawn is never called. Test only; no production code changes.
- 118ba3b: Type the own-schema SQLite row reads with `prepare<Params, Row>` instead of `as` casts; no behavior change.
- 8b0da70: Split the repeated confirm, run, or skip blocks of `runUninstall` into one shared helper. Prompts, their order, and the reported steps are unchanged, and a new test file pins each confirm yes, no, and cancel path.
- c1069fc: Narrow `gh` wire JSON and stored JSON columns with zod instead of `as` casts. A malformed element in a `gh pr list` answer or a malformed preserved row is now skipped and reported rather than thrown or passed through, and a note whose stored tags do not parse is indexed as untagged.
- b55abc2: Workspace-class queries keep their common terms once a graph has cut over to the workspace span table. They rank only that small table, so the document-frequency cap no longer pays for itself there. Queries that include `transcripts`, and any query on a graph still holding legacy workspace spans, stay capped.
- 01bd8f8: session recover: identify live claude processes on Linux from `/proc/<pid>/cmdline`, since `ps` reports the thread name `MainThread` there.
- 5449af7: Refuse a repeated `--add-tag` or `--remove-tag` on `task edit` with a usage error instead of silently keeping only the last tag.
- ea437a6: The agent-chat origin resolver maps a spawn's `route_*` meta onto the session-graph route origin columns; absent or non-string values stay null.
- 5a2cc37: `active inventory` now reports an `other` class per initiative and in totals, so the total equals every visible file under the initiative. Previously handoff, snapshots, artifacts and non-markdown sources were left out of the count.
- cd92162: `task list --status` now accepts any status in the initiative's category registry, such as `wont-do` or `icebox`, plus `closed` for every closed status. A root with no registry still accepts `open`, `done` and `all`; an unknown status is a usage error naming the allowed values.
- cb51fcb: The systemd unit's ExecStart now escapes each argument with the daemon `./service` escaper, so a node or CLI path containing a `%` or `$` no longer expands as a unit specifier or variable.
- 9b20b96: The gh-backed PR outcome poll no longer asks about a PR again before its recheck interval has passed: 10 minutes for an open PR (`AW_PR_OPEN_RECHECK_MS`) and 24 hours for a closed one (`AW_PR_CLOSED_RECHECK_MS`). A closed PR is now re-checked after that interval, so a reopen on GitHub is seen. The last-checked time is the `pr.outcome_checked_at` column, so the throttle holds across daemon passes.
- 9551975: Drop export keywords from symbols used only in their own file, and delete nine exports nothing reads. No behavior change.
- 34f609d: Arrange the source in four import layers (base, store, services, surfaces). Helpers that lower layers imported from higher ones moved down; behaviour is unchanged.
- bb95d6c: Split the bootstrap prompt's loaders, renderers and live-status fetchers out of `bootstrap/prompt.ts` into their own modules. Behaviour is unchanged.
- d0b0a1d: Split `assembleBootstrap` into a defaults step, an I/O gather phase and an ordered list of section builders, so no bootstrap function exceeds cyclomatic 15. The prompt and metadata are byte-identical; a golden test now pins both.
- 8f857cd: Split `setup/steps.ts` into step-family modules (`steps-deps`, `steps-local`, `steps-install`, `steps-register`, `steps-daemon`) and `setup/uninstall.ts`. No behaviour change.
- 17dfb36: Split `commands/wrap.ts` and `commands/task-edit.ts` into `_wrap-args`, `_wrap-write` and `_task-edit-parse` helpers. No behaviour change.
- 19f16b8: Split the `aw` launcher into `launcher-open` and `launcher-resume` modules; no behaviour change.
- f9cba94: Split the v2 to v3 open-loops migration: the plan types and plan/build functions move to `v2-to-v3-plan.ts`. No behaviour change.
- 3794ea1: Split sessions/open-loops.ts into load-sessions, loop-resolution and open-loops (TP-3563). No behaviour change.
- 6e62c92: Drop the last active-work exemption comment and the adopted-path allowance (TP-3541 closure).
- 2817ddc: active-work resolves its data, state, config and cache roots through `@titan-design/app-paths` instead of its own `env-paths` call. A parity test pins the five `ACTIVE_ROOT` cases and the XDG overrides; behaviour is unchanged.
- 9dd8d1c: `context.related` asks the daemon only for workspace freshness. It no longer starts or waits on a transcript delta pass; a changed workspace file waits on a workspace-only refresh within the 800 ms budget.

  The workspace watcher ignores the miner root, so the daemon's own index and lock writes no longer mark the workspace dirty.

- daf7321: Split `discoverClaudeSessions` into a per-project-directory scan and a hit builder to lower its cognitive complexity. No behaviour change; characterization tests added.
- f9d0337: Session-index passes roll up one session per transaction and yield after each, so a delta pass's rollup and a full pass's resume of unfinished turns no longer hold the daemon's event loop for seconds.
- dbbb4d3: A later session file may now resolve open loops opened by an earlier file that shares its session_id (reused ids, checkpoint wraps). The same file resolving itself and the ended-time ordering are still enforced.
- 25ef1b2: A full pass gathers the sessions with unfinished turns a page at a time and yields between pages, so a pass resuming many unfinished turns no longer holds the daemon's event loop for one long query.
- 61005b1: The session-index daemon runs its SQLite WAL checkpoints in a worker thread and no longer syncs each commit, so a slow disk's fsyncs no longer stall the daemon's event loop during a pass.
- a275fa2: `miner rebuild` now holds a lock on `graph.sqlite3.next` for the whole rebuild, so two rebuilds (two `--resume` runs included) can no longer build into the same file; the second is refused.
- 07659eb: Document the `autonomy:` brief frontmatter block in the README, architecture doc and skill.
- 31f7173: Typecheck the active-work tests under `src/aw`, `bootstrap`, `lint`, `server`, `session-index`, `utils` and the launcher profile test, by fixing their fixtures to match the types they call. Test only; no production code changes.
- 10940a8: Clear the active-work lint baseline entries that TP-3538 recorded for the autofix, unused-variable, unnecessary-condition, function-length, test-clock-budget and type-import rules. Tests and test-support only; no production code changes.
- faf76b8: The session-index scheduler now passes the failed pass kind and its chosen backoff to `onError`, so the delta backoff log no longer keeps a second failure counter (TP-5175).
- ccac1a1: Move `env-paths` to devDependencies (only tests import it) and point the session-lease comment at `src/sessions/initiatives.ts`. No behaviour change.
- 86f01fe: The rendered systemd unit now doubles `%` in the `StandardOutput=` and `StandardError=` `append:` log paths, as it already does for `ExecStart` and `Environment`, so a home directory containing `%` is no longer read as a unit specifier.
- 3498c8a: The session-index scheduler asks the gate again when a hold-cap pass ends, so readers get fresh reads as soon as the gate has opened instead of waiting for the next poll (TP-5186).
- 448f305: Clear the last TP-3538 type-assertion lint entries for the active-work command and integration tests. Tests only; no production code changes.
- 4f88411: Clear the remaining-slice test type-assertion lint entries (TP-5217, slice rest); tests narrow with schema parses, type guards and a shared spawn fake instead of casts.
- 9035d5f: Clear the TP-3538 type-assertion lint entries for the active-work server tests. Tests only; no production code changes.
- cb10e56: Clear the session-index and lease test type-assertion lint entries (TP-5217, slice sessions); tests read rows through typed query helpers and schema parses.
- 10246fc: Drive the mirror-root and bootstrap read-count tests through `CLAUDE_TRANSCRIPT_MIRRORS` and an `fs.promises.readFile` spy instead of internal module mocks.
- 50daf84: Inject the lock and write steps of `task apply` so tests observe them without module mocks (TP-5218).
- 6d5f30c: Inject exit, open and launch into the aw launcher so tests no longer mock internal modules (TP-5218 slice S3).
- ecc23d4: Let tests swap refresh-pass phases through `RefreshOptions.steps` instead of mocking modules (TP-5218 slice S4).
- ecc23d4: Give the session index watcher injectable deps (refresh pass, machine-pressure probe, reader gate) so its tests stop mocking internal modules. Production wiring is unchanged.
- 2f404a7: The test-support `runCli` helper returns empty strings, not null, for stdout and stderr when the child fails to spawn (TP-5220). Test support only; no production code changes.
- 8436f35: Link scorecard dispatches through the session origin when a spawn recorded no task (TP-5446 slice S12). session-read's `assignedTaskIds` takes an optional `spawnTask`, the spawn's recorded `meta.task`; a known id there wins over the name and brief rules and reports source `spawn-meta`. active-work's agent-chat origin resolver passes it. session-analytics' `ScorecardSpawn` gains an optional `link` provenance; a first dispatch linked by inference records it under `provenance.firstDispatchTs`, so the row counts toward the week's inferred share. session-miner's `ticket-scorecard run` falls back, for a spawn with no `meta.task`, to the session graph's resolved `session_origin` link when it names exactly one task, marked `inferred:<task_source>`; a link naming several tasks or none is left unlinked and counted. `run` prints those counts, and `reproduce` adds a per-week table of the population and the share of its rows whose dispatch link is inferred. The console's task drill-down shows the inferred badge on the first dispatch.
- 83e7822: `active-work mcp restart` now spawns its detached successor before it stops the old daemon, so a restart issued through MCP, which runs inside the daemon it stops, still leaves a daemon listening. The successor waits for the old process to exit. A restart whose successor never listens fails with a message to start the daemon manually.
- ee694a0: A sealed transcript of a retired agent whose audit facet is behind the current extraction version now stays in the session-index walk until the facet backfill upgrades it, so it also counts in `facetBacklog`.
- e2cc9eb: The workspace index writes its derived edges by diff: a pass inserts only new edges and deletes only vanished ones, so a refresh over an unchanged workspace writes no edge rows and no longer grows `edge_id`.
- 3cd97bc: The session-index pass summary and the daemon's pass log line carry `prsPolled`, the number of PRs the pass asked `gh` about.
- 1d2925e: `scanInventorySlug` now returns every visible file the indexed classes and nested sources do not claim as class `other`, with `indexed: false`. The inventory summary skips `other` until the wire schema adds it.
- 937806f: `active-work miner cost` takes `--session-ids <id>` to limit the report to some sessions. Repeat the flag for each id, or pass `@<file>` with one id per line. Without the flag the report is unchanged.
- 436f1b1: Add `scripts/task-add-replay.mjs`, a read-only replay of recent task creation against the done_when gate and title similarity bands, and depend on `@titan-design/memory` for its `jaccard` (TP-2544).
- b26c597: Split `doctor.ts` into a `doctor/` directory (index, probes, host checks, data checks). No behaviour change.
- 16a562e: Split session-index/origin-agent-chat.ts (events.db readers move to origin-agent-chat-read.ts) and refresh.ts (the cross-process lock moves to refresh-lock.ts). No behaviour change.
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
- 5ec3fe4: The checkpoint worker reports each checkpoint's start and end through an optional `onCheckpoint` callback, so the "off the event loop" test counts loop turns during a slow checkpoint instead of timing the pass against a wall-clock bound. Test seam only; daemon behavior is unchanged.
- 579674a: Typecheck active-work test files with tsconfig.json and drop the exclusion file (TP-5100).
- 6578897: Let `createScheduler` take an injected clock so the delta backoff test needs no real wait.
- 52673e6: The gh PR resolver no longer re-derives which PRs are due: it takes session-graph's `prsNeedingOutcome`
  order and band as given and only applies the failure backoff, the recheck intervals and the per-pass cap.
  `ghPrResolver` drops its graph argument.
- f1174d9: The daemon log now says "session index released: hold cap ... reached" when the hold cap lets a pass through, instead of "session index resumed". A scheduler test now covers held, holdReason and heldSince.
- 2776c92: The gh PR resolver now asks once about a checked merged PR whose commit times are missing, instead of skipping every checked merged PR. An empty answer stores an empty list, so the PR is not offered again.
- e5ac26d: Use the shared `listInitiativeSlugs` in `artifact list` and the v2-to-v3 migration plan instead of private copies.
- 828f55a: Clear the TP-3538 type-assertion lint entries for the first eleven command tests (TP-5217, slice commands); tests narrow results through schema parses and typed helpers. Tests only; no production code changes.
- a8e9edd: Clear the type-assertion lint entries in the CLI runner and daemon test helpers.
- f789f24: Test-only: the cli, daemon, document-frequency and setup-steps tests parse JSON through zod and build fakes through type guards instead of type assertions, and their TP-3538 suppression entries are cleared. No production code changes.
- e14df0f: Inject the logger, daemon start and watcher options into `runDaemon` so its tests no longer mock internal modules (TP-5218 slice S6).
- 68540a3: `miner cost --session-ids @file` now exits with a usage error when the file holds no ids, instead of returning a silently empty report.
- 19309cf: Use the shared listInitiativeSlugs from sessions/initiatives and make the PR outcome tie-break test discriminate the pr_ref comparator.
- b8a7d74: Treat a throwing session-index gate as open at the post-cap recheck too, and report the resume when that recheck clears the hold.
- 78ae7d9: Stop writing tool spans, context blocks and unchanged state echoes by default (TP-880).

  session-read: `ReadOptions` gains `toolSpans` and `contextBlocks` (default true), passed to `LineReader` as an optional `EmitPolicy`. A fact from an echo line (`ai-title`, `custom-title`, `agent-name`, `mode`, `permission-mode`, `cost-state`) carries `state: { key, value }`; `atis-latch`, `bridge-session` and `last-prompt` emit no fact. `EXTRACT_VERSION` is 9.

  session-graph: `IndexOptions` gains `indexToolSpans` and `contextBlocks` (default false); `refreshCorpus` forwards `contextBlocks` to `backfillFacets`. Migration 14 replaces `session_state` with `echo_state`, keyed per transcript, and an echo fact is stored only when its value changed. `turn.thinking_ms` now counts the gap from a tool result past a skipped echo.

  session-miner and active-work keep storing tool spans and context blocks; active-work does so on both its full and delta passes.

- Updated dependencies [59db533]
- Updated dependencies [7d3a100]
- Updated dependencies [c1af4ba]
- Updated dependencies [73c018b]
- Updated dependencies [0523e9d]
- Updated dependencies [74ad076]
- Updated dependencies [81395d7]
- Updated dependencies [9411e94]
- Updated dependencies [dcbf00e]
- Updated dependencies [e391005]
- Updated dependencies [d0d51f1]
- Updated dependencies [f85e2ba]
- Updated dependencies [b7c8320]
- Updated dependencies [225f3fb]
- Updated dependencies [49f5aef]
- Updated dependencies [09c91f4]
- Updated dependencies [25fcc67]
- Updated dependencies [1ac0fa2]
- Updated dependencies [c8c02da]
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
- Updated dependencies [75aad5d]
- Updated dependencies [580333c]
- Updated dependencies [2380fd4]
- Updated dependencies [76028d9]
- Updated dependencies [98f29bd]
- Updated dependencies [6a76161]
- Updated dependencies [f896485]
- Updated dependencies [a20c348]
- Updated dependencies [aa5085c]
- Updated dependencies [b6ce883]
- Updated dependencies [b6ce883]
- Updated dependencies [d184763]
- Updated dependencies [4515002]
- Updated dependencies [820d4d2]
- Updated dependencies [42551ba]
- Updated dependencies [42b6a21]
- Updated dependencies [6554538]
- Updated dependencies [fb60007]
- Updated dependencies [12e2109]
- Updated dependencies [0145f82]
- Updated dependencies [067c518]
- Updated dependencies [8c67d72]
- Updated dependencies [ed29ec2]
- Updated dependencies [1ac2768]
- Updated dependencies [5a67a0b]
- Updated dependencies [cfdfb64]
- Updated dependencies [ff6fb95]
- Updated dependencies [c58d555]
- Updated dependencies [6c3c967]
- Updated dependencies [7813c1f]
- Updated dependencies [02ed42b]
- Updated dependencies [f996bb9]
- Updated dependencies [e52ea15]
- Updated dependencies [6525ba7]
- Updated dependencies [e595887]
- Updated dependencies [eaa7649]
- Updated dependencies [9dd8d1c]
- Updated dependencies [207a81b]
- Updated dependencies [207a81b]
- Updated dependencies [f77d79d]
- Updated dependencies [5edd38d]
- Updated dependencies [9b42150]
- Updated dependencies [90f36b4]
- Updated dependencies [a97c166]
- Updated dependencies [d3bf3fb]
- Updated dependencies [c2bfa21]
- Updated dependencies [a8bdbd2]
- Updated dependencies [90c93cf]
- Updated dependencies [98a2861]
- Updated dependencies [c465bf0]
- Updated dependencies [6413084]
- Updated dependencies [a6b29cd]
- Updated dependencies [8436f35]
- Updated dependencies [8ede337]
- Updated dependencies [047aa4c]
- Updated dependencies [8e09d50]
- Updated dependencies [aef50d8]
- Updated dependencies [709ab1e]
- Updated dependencies [9614680]
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
- Updated dependencies [7e667af]
- Updated dependencies [b705e6c]
- Updated dependencies [52673e6]
- Updated dependencies [7fad537]
- Updated dependencies [ad90aec]
- Updated dependencies [342c6ba]
- Updated dependencies [342c6ba]
- Updated dependencies [0100482]
- Updated dependencies [9028bd0]
- Updated dependencies [9396ce4]
- Updated dependencies [29062e0]
- Updated dependencies [9d74995]
- Updated dependencies [78ae7d9]
- Updated dependencies [72f1e2d]
  - @titan-design/agent-dispatch@0.10.0
  - @titan-design/session-analytics@0.18.0
  - @titan-design/daemon@0.9.0
  - @titan-design/decider@0.7.0
  - @titan-design/agent-protocol@0.10.0
  - @titan-design/session-read@0.17.0
  - @titan-design/session-graph@0.19.0
  - @titan-design/memory@0.3.1
  - @titan-design/registry@0.6.0
  - @titan-design/retrieval@0.4.0
  - @titan-design/store-sqlite@0.5.0
  - @titan-design/locator@0.2.2
  - @titan-design/rpc-protocol@0.4.0
  - @titan-design/cluster@0.3.0
  - @titan-design/pm@0.5.0

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
