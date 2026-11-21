# @titan-design/active-work

## 0.32.0

### Minor Changes

- ae3119b: Record an `aw.launch` line in `usage.jsonl` with the time from process start to just before `claude` is spawned.
- 2f1adff: Record every `aw` open's wall time and phase timings as an `aw.open` line in `usage.jsonl`.
- 48bea05: The bootstrap prompt renders absolute ISO dates and timestamps instead of relative ages (TP-6322). The Last session heading, the Context line, the paused-since line, sibling session lines and open-loop lines no longer say "2 days ago", "12m ago" or "[1d]", so the prompt stays byte-identical as the clock moves. `time_since_last_session_human` stays in the metadata.
- 8a69e02: `precedent extract` indexes the titan console's `answers.jsonl` owner answers as a fifth ledger source, read incrementally behind an offset and prefix-hash watermark.
- 9ae5bb0: Add `active-work digest --personal`: overdue tasks, tasks due in the next 14 days, trigger-met loops and the five stalest open tasks across owner-only initiatives, in that order and capped at 30 lines. A caller that may not read owner-only initiatives gets every section empty.
- c360423: Accept relative due dates (`+3d`, `+2w`) on `task add` and `task edit --due`; they resolve to an absolute YYYY-MM-DD against today.
- 8fb9ab8: Add `--lane <slug>` to `plan intent add` and `plan intent digest`. A lane's lines are numbered `<lane>/I<n>` and filed under the initiative, and its digest renders `slug: <lane>` with `initiative: <initiative>`. Without the flag the lane is the initiative and nothing changes.
- 5be3a06: Lint reports dep and parent cycles and unknown parent or dep ids across initiatives; an id archived in any initiative counts as known.
- 332c9ac: Let `loops --all-initiatives` list open loops across every initiative visible to the caller, each entry tagged with its slug. `--due` still keeps only trigger-met loops, and an agent caller gets nothing from an owner-only initiative.
- cd969dc: Add a repeatable `--tag` filter to `note list`; several tags must all be present.
- c85443c: Add a `plan.seed` command that reads an owner-intent digest and returns its live lines, the initiative's success statements and a domain's ready tasks, as JSON and markdown.
- d2eecdf: `preflight --since <iso>` lists sources files written since that time which no task, note or session names, and the checklist asks for each to be answered with a task id, a seat name or none.
- 8b0ff20: Return owner decisions from the precedent ledger as a `decisions` class in `context.related`, on by default, ranked under the caller's visibility and capped at its share of a page.
- ba4e052: Add `renderResumeBlock`, a pure builder for the markdown block re-injected after a compaction.
- 99ab9a6: Add `ingestSource`, which content-addresses a `.md` or `.txt` source's bytes into a new `cache_blob` table (graph migration 1005) and extracts its text to `sources/extracted/<stem>.md`. A second ingest of unchanged bytes is a no-op.
- 7f69571: `task apply` accepts `set_bet`, `set_estimate`, `set_fold`, `set_kind`, `set_cos`, `set_area` and `set_due`. Values are checked against the task schema, the category registry (read once per run) and the plan store (each bet id looked up once); a bad value fails only its own line. An unknown op now lists the valid ones.
- ee035bb: `task done` now names the open tasks it unblocks, in any initiative, as a `completing X unblocks A-1, B-2` warning and a ` (unblocks A-1, B-2)` suffix on the `--quiet` line. An agent caller gets a count for dependents in initiatives it may not see. The JSON task result is unchanged.
- af1e527: Add `task list --unblocked`, which keeps only tasks whose every dep is closed, archived or done. A dep resolves by file name across all initiatives, and an unknown id counts as open.
- 4eff469: Log each daemon workspace refresh's duration, file counts and outcome (ok, failed, lock-held), and a line when a reader's freshness budget expires, so the related-read budget can be re-measured from `daemon.log`.
- c1196a1: `wrap` now requires exactly one of `--reports` (a JSON array of `{ref, answer}`) or `--no-reports`, and records `reports` or `no_reports: true` in the session frontmatter. The agent-chat completion hook passes `--no-reports`.
- 1baef3a: Show the initiative's recent owner answers in the bootstrap prompt: up to three
  answered ledger rows inside the recently-done window, newest first. An unreadable
  ledger leaves the section out and adds a `retrieval_degraded` line.
- 5432239: The workspace edge pass now writes `mentions` edges from source markdown bodies and from each task's title, done_when and notes, not only from notes. A source body over 256 KB is skipped and counted as `oversizedSources` in the refresh summary.
- 8286432: Add `IntentLineSchema` to pm: one dated, quoted owner-intent line, refused without a quote or a date. `parseIntentDigest` now validates each bullet with it, and its lines carry `superseded_by` instead of `supersededBy`. pm's plan store gains an `intent` kind under `plan/intent/`. active-work adds `plan intent add|show|list|digest|import-messages`: `add --message <id>` takes the date and `msg:<id>` reference from the owner-message extract, which now lives at `<aw>/factory/plan/owner-messages.jsonl` (the old sources copy is read while it is absent), `digest` renders the lines as a `titan-intent-digest/v1` file, and `active-work lint` refuses a malformed intent line.
- 0353800: Run precedent extract on the daemon: one pass shortly after start, then every `AW_PRECEDENT_EXTRACT_MS` (default 30 minutes, 0 turns it off), so served decisions stay current (TP-6218).
- 81f1370: Add `precedent.show` (`active-work precedent show <key>`), which opens one ledger precedent by its exact key. An unknown key, an owner-only initiative's row and an unclaimed row asked for by a non-owner all return the same not-found error.
- ff39530: `taskLedger(db, taskId)` lists every session linked to a task, newest first, with agent, profile, span, priced cost with an unpriced flag, linked PRs and their review verdicts; `readTaskInitiative` names the task's initiative. `active-work miner ledger <task>` renders them, and refuses an agent caller for a task in an initiative that is not agent-visible.
- c54003a: `active-work source list --limit N` returns the N newest sources by mtime (nulls last), capped after the `--type` filter, with `total` and `truncated` in the result. Without it the listing is unchanged.
- 155e29c: `active-work task list` prints one line per task and a count without `--json`; `--json`, MCP and HTTP output are unchanged. The explainer daily preset reads the `--json` envelope or a bare object.
- 6a7cb21: Index planning records as a `plans` workspace class (TP-5453 P10). Outcomes, bets and intent digests under an initiative's `plan/` folder get spans in the workspace index, so `context related` returns a bet's outcome and intent lines. Owner-only initiatives index none of them. Adds migration 1004 (`plan_record`).
- 55ff5ba: Add `context.brief` (TP-5453 P11a-1). It renders the related-context section of a spawn brief as finished
  text within a UTF-8 byte budget (default 2600, max 4000): at most three workspace ids, ranked with the agent's
  view whoever calls, over every registered workspace class except transcripts and initiative briefs. A missing
  index gives empty text and a `degraded` entry. With `trigger` set, the rendered refs are logged as served in
  the same call.
- 209305e: Add `sessionsTouchingFiles` to session-graph (TP-5453 P11b-1). It lists the sessions with a live `touched`
  edge to any of the given repo-relative files since a time, newest first and capped. Each row has the
  session's cwd, title, the matching file refs and the initiatives its task edges name. `context.brief` in
  active-work uses it to add a recent-sessions section for the files an assignment names. The section covers
  the last 14 days, holds at most 4 lines and stays within 500 bytes. It lists a session only when the agent
  view shows its initiative, so sessions in owner-only initiatives, or in no initiative, never appear.
- 8afd8b3: `context.brief` adds a code section (TP-5453 P11b-2): one hop of imports around the files the assignment
  names, plus the done_when and owns paths of each task key it names in an agent-visible initiative, at most six
  lines in an 800-byte share. Neighbours come from codewatch's `node.neighbors` over loopback; when codewatch is
  not answering, the named files' relative imports are read from the new optional `repoRoot` checkout and the
  result carries `degraded: code/no-snapshot`. The section stops at 800 ms. The workspace, code and session
  sources now run concurrently under one 2,000 ms deadline, and a source that misses it is listed as a timeout.
- d25e61e: Stop emitting `agent_visible` from `inventory` and `task.keys` (TP-5830). Every reader now takes the `withheld_from_agents` verdict, and `task.keys` rows carry it; the shepherd's task-ref reads a missing verdict as withheld.
- 30d7d33: `note add` now stamps every new note with `created_at` (a full ISO timestamp; `created` stays a date), takes an optional `--session`, and records `agent` from `AGENT_CHAT_NAME` when run from the CLI. Notes filed before this change still load.
- bafe586: `task list` takes `--due-before <YYYY-MM-DD>` to keep tasks due on or before a date (undated tasks drop out, a malformed date is a usage error) and `--sort due` to order by due date, earliest first, undated last, with priority breaking ties.
- d6e90e0: `note list` takes `--limit` and `--cursor` to page the newest-first list. The result now reports `total`, `truncated` and `next_cursor` (null on the last page); a malformed or out-of-range cursor is a usage error. Without `--limit` the full list is returned.
- 58aa3dc: `spawn` takes `--task <initiative>/<ID>`: it appends that task's `context.brief` block to the brief and logs each served ref to `retrieval-hits.jsonl` with trigger `spawn`, the task key and its section. Hit-log entries gain optional `task` and `section` fields. When the block is empty or degraded, the brief goes out unchanged and one stderr line names the reason; without `--task` nothing changes.
- 50b9788: Add the weekly sheet (TP-5453 P16). `active-work plan sheet generate` writes `<initiative>/plan/sheets/<week>.md` from the initiative's outcomes, bets, scorecard week rows and stored prediction checks, in five sections: statement, moved, not moved, proposed bets and proposed stops. Every bet line names its intent line and metric, and any bet line that cites no intent line is flagged and defaults to hold. A bet with no prediction check reads `unread`. `plan sheet show` reads a sheet back. `plan sheet apply-defaults` records the sheet's defaults as its decisions, and only once the deadline has passed with no answer recorded. Reading a sheet never records anything. The console initiative page shows the newest sheet.
- 7acf411: `why <path>:<line>[-<end>]` runs `git blame -L` at HEAD and maps each commit to its PR (the squash subject's `(#n)`), the tasks behind it and the sessions that did the work, printing the rung that found each: `trailer`, `pr-subject`, `pr-task`, `refs`, `session-ran`. An `Agent-Session:` trailer is read first. Sessions and tasks in an initiative the caller may not see are counted in `hidden`, never named. session-graph exports the walk as `commitLineage` (TP-2771).
- fa7f84e: `wrap` now returns `promotion_candidates` and warns about notes the search hit log shows surfacing in 3 or more renders across 2 or more initiatives.

### Patch Changes

- 91859ff: Parse task files concurrently, up to 32 reads at a time, in the archive pass `active-work open` runs first. On a large initiative the pass no longer waits on one file read at a time.
- 5140284: Reuse parsed tasks for unchanged files in the archive pass `active-work open` runs first. A sidecar under the state directory keeps each task's parsed form, stamped with the file's inode, size, mtime and ctime; a file whose stamp differs, or any problem reading the sidecar, falls back to a full parse.
- d8bdea2: Count `tasks/archive` when allocating a task id, so archiving the highest id no longer lets the next `task add` reissue it.
- bc03117: Show each task's due date in the bootstrap task list and list overdue and due-within-7-days tasks first, earliest due first.
- 3c19c03: Open the graph and compute agent visibility once per bootstrap and share both with note ranking and every loop query, instead of reopening the graph and rescanning every brief per query.
- 438efc0: Keep the spawn brief's code neighbours to the spawn's own checkout, and refuse named files that resolve outside it, by `..`, absolute path or symlink.
- bf0a81c: Accept a `--dep` or `--parent` that names an archived task. The edge check now reads the ids under every initiative's `tasks/archive/` by file name, and an id found in no live or archived file is refused with "no live or archived task file in any initiative".
- d558d66: Read indexed values in the commands, bootstrap, migrations, lint, decider, sources, workspace-index and top-level modules through forms that type `undefined`, so they pass `noUncheckedIndexedAccess`. Behaviour is unchanged.
- cf65b27: Mark records written by `loop open` and `loop resolve` with `ledger: true`, and skip them when bootstrap picks the narrative session and the parallel sessions, and in `session list`, so a loop filed after the last wrap no longer reads as the last session.
- 146efb1: `open` starts live branch status as soon as `artifacts.yml` is read, so the gh and git lookups overlap the task archive pass instead of waiting behind it.
- c8efd53: Fall back to static branches when bootstrap live status misses a 2.5 s deadline, and cap static branch and stash lists at 10 lines.
- e5d2595: Read session files concurrently (16 at a time) in `loadSessionsFromDir`, keeping filename-ascending order.
- efc38f9: `active-work setup` and `active-work doctor` now require Node 24, the engines minimum, through one shared constant and version parser. They no longer pass Node 22 and 23.
- a2f2848: `note add` now warns, and returns `possible_dup` with the older note's filename, when an existing note in the initiative has a near-identical title. The note is still written.
- 4718e69: Workspace refresh now caches note bodies by path, mtime and size, so it re-reads only notes that changed or are new instead of every note on each pass (TP-6339).
- 58b89d1: Persist loop retrieval's document-frequency counts in a sidecar beside the session graph, so a warm `open` skips the FTS5 vocabulary lookups an earlier process already paid for. A pass that indexes spans deletes the sidecar, the counts are stamped with the graph's inode and highest span ids, and a missing or unreadable sidecar falls back to live counts.
- 892a301: `task.reorder` now bumps only the open tasks that collide with the new priority, walking upward until a free slot. Done tasks and tasks past the first gap keep their priority and updated date, and `shifted` lists only the rewritten tasks.
- 9db5f5b: Share the branch probes and check summary between live-status and artifact-status.
- b42f84e: Read and write `drain-trees.json` through the cluster package's own snapshot parser, so partition keys this product does not know survive a restart.
- c819ad4: An unknown bet id on task add or edit now lists the initiative's bets, or says it has none, and names the `plan bet add` command.
- f2a655f: `aw --version` now prints the running build's version instead of a hardcoded `0.1.0`.
- d302288: `context.brief`'s recent-sessions section lists a session only when every initiative its task edges name is shown to agents, so a session that also worked in an owner-only initiative, or in one whose visibility is unknown, is withheld (TP-5986). A session with no task edges maps to an initiative by its cwd's folder under the configured active root, whatever that root is named, instead of an `active-work/` path match (TP-5987). `why` applies the same every-edge rule and cwd mapping to the sessions it serves.
- 977026b: Context mode reads a span's tier-2 text through `readLocatorText`, so a span running past the end of a shrunk file drops the tier instead of showing partial text.
- 2687f5c: Carry a note's `read_if` condition into every tier of `context.related`'s context mode, so the entry text keeps the "read if" hint that list mode already returns.
- dc89efd: Log each served hit's class and, in context mode, its tier in the retrieval hit log, and cap the logged query at 500 characters with a `queryHash` of the full text.
- 027ca26: `loops` resolves task triggers against `tasks/archive/` as well as `tasks/`, so a loop waiting on a task keeps its task-done trigger once that task is archived (TP-1015).
- dc4eb2c: `@titan-design/pm` exports `isoDate`, the calendar-checked `YYYY-MM-DD` validator. active-work's pause, brief and note schemas use it instead of their own copies.
- 758f60c: Search the owner's free-text note on precedents and return free_text and answered_at on precedent.search hits (TP-6162).
- 8b568bc: Suggest slugs containing the input and cap the Known list at 12 when an initiative slug matches nothing.
- 9fd56cf: `context related` no longer spends a slot on a task whose id the query text already names; the next-ranked hit takes its place.
- e93951d: `@titan-design/retrieval` exports the query-term helpers `meaningfulTerms`, `orExpression`, `deriveQuery`, `selectTerms`, `documentFrequencyCap` and `DF_CAP_FLOOR`, with the `DerivedQuery` and `DocumentFrequency` types. They turn prose into a rarity-ranked FTS5 OR expression. active-work now imports them instead of its own copies.
- dc753c2: A full session-index pass now hands every discovered transcript to the missing sweep as present, so a sealed transcript the pass skips is never marked `missing` and then restored. This removes the `unvisitedOk`/`restoreUnvisited` workaround (TP-1019).
- bdf12cb: Add `@titan-design/service-supervisor` with `renderSystemdUserService` and `renderLaunchAgentPlist`. active-work now renders its unit and plist through it; the unit's `NODE_ENV` line is now quoted like the other `Environment=` lines.
- c4bcfe4: Show priority, due, kind, cos, area, parent, dep, bet, done_at and done_reason in the compact `task show` output when present.
- ab65526: A lock that is lost while held (for example after a laptop sleeps past the stale window) no longer throws from proper-lockfile's timer and kills the daemon. `withFileLock` and `withRefreshLock` now fail the holder's operation with a `LockCompromisedError` (exit 75) instead (TP-1013).
- 7c47a3c: `miner outcomes` folds a seat or agent name that holds an owner-only initiative slug into the `owner-only` bucket for a non-owner caller (TP-5773). Only initiatives on disk now are matched.
- c74e78b: Doctor reports initiatives whose slug is a reserved miner key, with the rename remedy (TP-5782).
- bb466f1: Read initiative task files through `@titan-design/pm/node`'s `readInitiativeTasks`. The lint-only task loader is gone; lint, doctor, loops, wrap and the loop board share bootstrap's `loadTasks`. Tasks now come back sorted by file name, and an unreadable `tasks/` directory throws instead of reading as empty.
- 10204b9: The session index reads each initiative's task files through `@titan-design/pm/node` `readInitiativeTasks` instead of its own walker.
- 5c8299f: Export `profilesRoot(env, home)` from `@titan-design/anthropic-account/node` as the single resolver of the Claude profiles root, and use it in active-work, factory context-audit, session-miner friction transcripts and the titan config report. `CLAUDE_PROFILE_ROOT` now applies to all of them; a relative value is ignored.
- 3969bdb: Read `.schema-version` through one reader: `readSchemaVersion` now delegates to `readRawSchemaVersion` and applies the zero rule once (TP-5810).
- 83ed2aa: Export `transcriptFromPath` from session-read, beside `discoverTranscripts`; active-work's copy is removed.
- e5bc26e: Stop exporting file-local symbols in apps and products (TP-5821).
- 4819abe: The duplicate tagger scores titles with the same `jaccard` the 0.9 threshold was tuned with.
- 31c05b3: Restore a task undone from the dashboard Tasks view to its priority position instead of appending it.
- e446ba9: `aw open` with no slug returns an empty picker and one warning when the active root cannot be read (EACCES, ENOTDIR), instead of throwing. A missing root still returns an empty picker with no warning (TP-6222).
- bdf51d5: Add `task edit --clear <field>` to remove due, kind, cos, area, parent or bet from a task. Clearing an absent field is a notice, clearing due on a cos fixed task is refused, and `--clear` with a set flag for the same field is a usage error.
- af19e22: Cap the bootstrap's open loops (12), abandoned loops (8), archived task ids (10) and malformed task filenames (5), each with a "+N more" pointer; the totals and the closing instruction still state the true count.
- 8e56f8b: A bare `aw` run from an initiative's own directory (or any directory inside it) now opens that initiative instead of the picker. A registered worktree nested deeper still wins, and a brief is parsed only for an initiative that matched the directory (TP-6245).
- a1e7eca: Print task schema failures as one `field: message` per issue instead of the zod issues array as JSON.
- cc7f82e: `task show` now shows an archived task, marking compact text with `archived: yes`, and a missing id names the other initiatives that file it.
- 95dc38c: Log each search run's hit and degraded counts to `search-queries.jsonl` so zero-hit queries can be counted.
- 0003f78: Make the sessions, session-index, drain, discover, utils, setup and wrap modules and their tests compile under `noUncheckedIndexedAccess`. Behaviour is unchanged; an indexed read that cannot be satisfied now falls back to an empty value or skips the row instead of reading `undefined`.
- 1702c03: Split the over-long dashboard components and the artifacts schema refinement into named helpers, with no behavior change.
- Updated dependencies [d8294fb]
- Updated dependencies [81668be]
- Updated dependencies [8a69e02]
- Updated dependencies [0de5073]
- Updated dependencies [beff4cb]
- Updated dependencies [bd68bea]
- Updated dependencies [f012a1b]
- Updated dependencies [e114f17]
- Updated dependencies [1fc8813]
- Updated dependencies [5911f78]
- Updated dependencies [25f5d83]
- Updated dependencies [5911f78]
- Updated dependencies [84a7cc0]
- Updated dependencies [73cd2ea]
- Updated dependencies [eabd299]
- Updated dependencies [8286432]
- Updated dependencies [dc4eb2c]
- Updated dependencies [8fb9ab8]
- Updated dependencies [4ed6420]
- Updated dependencies [bbe129b]
- Updated dependencies [cffaab7]
- Updated dependencies [e93951d]
- Updated dependencies [b33b361]
- Updated dependencies [144f696]
- Updated dependencies [bdf12cb]
- Updated dependencies [13c9b1c]
- Updated dependencies [ff39530]
- Updated dependencies [4eb5c07]
- Updated dependencies [f5c87b7]
- Updated dependencies [a56d49d]
- Updated dependencies [67dd3fc]
- Updated dependencies [c55981b]
- Updated dependencies [a87852f]
- Updated dependencies [a411d70]
- Updated dependencies [209305e]
- Updated dependencies [b937077]
- Updated dependencies [17d1110]
- Updated dependencies [1029d2e]
- Updated dependencies [5c8299f]
- Updated dependencies [c759bad]
- Updated dependencies [d3d1d5b]
- Updated dependencies [e5d8d29]
- Updated dependencies [83ed2aa]
- Updated dependencies [3d19ff3]
- Updated dependencies [62d9877]
- Updated dependencies [0910060]
- Updated dependencies [3fec5b7]
- Updated dependencies [07330ed]
- Updated dependencies [7acf411]
  - @titan-design/agent-dispatch@0.11.0
  - @titan-design/agent-protocol@0.11.0
  - @titan-design/app-paths@0.2.0
  - @titan-design/session-read@0.18.0
  - @titan-design/store-sqlite@0.6.0
  - @titan-design/daemon@0.10.0
  - @titan-design/decider@0.7.1
  - @titan-design/pm@0.12.0
  - @titan-design/memory@0.4.0
  - @titan-design/session-graph@0.20.0
  - @titan-design/retrieval@0.5.0
  - @titan-design/service-supervisor@0.1.0
  - @titan-design/session-analytics@0.20.0
  - @titan-design/anthropic-account@0.5.0
  - @titan-design/code-read@0.3.6

## 0.31.1

### Patch Changes

- 58034f4: Remove two exports only their own tests used: the explainer beat worker registry and active-work's forgetPreserved (TP-5794).
- 1a76364: Delete the unused rewriteOccurrences and isActiveWorkError helpers.

## 0.31.0

### Minor Changes

- d025aac: Decide initiative visibility once (TP-5556). `sessions/visibility.ts` is the only loader: `visibilityFor` hands readers a branded `Shown` allow list, so the charter's human-only list now narrows agent reads too, and an unreadable charter or root shows agents nothing. `inventory` rows gain `withheld_from_agents`, `migrate` refuses every caller but the owner, and the owner is now served every initiative by context graph, plan lists and precedent search.

### Patch Changes

- 2226cfb: `miner cost` and `miner outcomes` fold every initiative withheld from agents into one `owner-only` bucket for a non-owner caller, with rates recomputed over the folded sums, and collapse an `other:<dir>` key to `other` unless the dir is a shown initiative. `active-work new` refuses the slugs `unknown`, `other` and `owner-only`, which the miner uses as report keys (TP-5556, TP-5748, TP-5749, TP-5750).
- 44c3988: `doctor`, `focus` and `unfocus` name no initiative withheld from an agent caller. Doctor's checks
  run over the caller's verdict, a lease sweep failure under a withheld initiative is reported as a
  count without its path, and renumbering moves are filtered through the same verdict (TP-5556 S2b).
- Updated dependencies [d025aac]
- Updated dependencies [ce68429]
  - @titan-design/pm@0.11.0

## 0.30.0

### Minor Changes

- ea59230: Withhold owner-only initiatives from every caller but the owner in the cross-initiative list verbs (TP-5453 P6b). The command context's `caller` is now `'owner' | 'agent'`, and only `'owner'` is served every initiative; a context no surface marked is restricted. The CLI names the owner when neither `AGENT_CHAT_NAME` nor `CLAUDECODE` is set, MCP names an agent, and the daemon's HTTP `/rpc` names the owner for the console and the factory. Commands enumerate initiatives only through `listSlugsForCaller`, which a structure test enforces: `task list`, `note list`, `source list` and `artifact list` with `--all-initiatives`, `inventory`, `list`, `audit`, `facet list`, `loop board`, the `open` picker and `open`/`prompt` slug-prefix errors drop every initiative `isAgentVisible` withholds and warn with a count only. `search` drops hits with no initiative and `precedent search` ignores `--include-unclaimed` for a non-owner. `inventory` rows gain `agent_visible`. `precedent extract` keeps an owner-only initiative's answers out of the decider ledger.

## 0.29.1

### Patch Changes

- Updated dependencies [a24b050]
  - @titan-design/session-analytics@0.19.0

## 0.29.0

### Minor Changes

- 62fd90f: Add `active-work task backfill-fields --from <labels.jsonl> (--dry-run | --apply)`, a one-off migration that fills empty class, serves, source, done_reason and blocked_on from an inferred-labels file, each marked `field_origin: inferred:<heuristic id>`. It never overwrites a recorded field and skips owner-only initiatives.

## 0.28.0

### Minor Changes

- 239d96b: One canonical task key, `<initiative>/<TASK-ID>` (TP-5453 P5). `pm` exports `resolveTaskKey`, which turns a bare id, a prefixed key or a repo-qualified key into the canonical key, or refuses it as malformed, not found, ambiguous or wrong-initiative; an id two initiatives hold goes to the one whose `task_prefix` issued it. active-work's new `task.keys` command lists each initiative's `task_prefix`, `agent_visible` and the ids of its task files, open and archived, read from file names (MCP tool `active__task__keys`). `titan-factory shepherd register` stores the canonical key and exits 65 on a key that resolves to no one task. On an active-work daemon older than `task.keys` it resolves through `task.list` plus the archive file names; when no complete index can be read it refuses only a malformed key, stores the rest as given with a warning, and marks the run `taskVerified=false` in its params; build-surface resolves its spec's tasks before any agent is spawned under them. `titan-factory shepherd task-key-report` lists the registrations whose key is not canonical, with a proposed mapping or no match, through a read-only store connection.

### Patch Changes

- Updated dependencies [239d96b]
  - @titan-design/pm@0.10.0

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
