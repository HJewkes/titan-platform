# @titan-design/session-analytics

## 0.18.0

### Minor Changes

- 25fcc67: Move the return-contract report parser into session-analytics. `parseReport` now lives there, reads the `Head:` sha and the `CI:` paste (worst state first) as well as the status, PR, plan, PARKED line and proposed tasks, and accepts a sentence after the status word (`Status: DONE. Plan: ...`). session-analytics also exports `extractFriction`, `extractConcerns`, `lineCluster` and `clusterOf`. factory keeps only the `burndown-slices` reader. session-miner gains `titan-miner report intake --shadow [--since 24h] [--eval]`, which writes one row per worker report (status, PR, head, CI, concern classes, suggested actions), acts on nothing, and with `--eval` scores the suggested closeouts against what happened next in the event log.
- 974b429: `routeOutcomes` joins routed spawns (the `session_origin.route_*` columns) to their PRs and Shepherd runs. It groups them by table, mode, prior, estimate band, profile, source and agreement, never pooled, and reports spawns, merged PRs, first-pass clean %, review rounds and fix-round spawns per PR, and implementer and all-in $ per merged PR. A run joins on its PR and the spawn's task, so two slices of one task never share a PR.
- f896485: `prefixReuse(rows, { windowMin })` reports first-call cache-read share, input spend at list price, a simulated system-prompt hit rate within the window, and the pairwise first divergence of requests by block; `firstDivergence` compares two requests. `scripts/prefix-report.mjs` prints it over recent transcripts.
- 207a81b: Add the daily friction audit. session-analytics gains `readWorkerReports`, which reads agent-chat's `Status:` report messages with each worker's last spawn, and `frictionDailyReport`, which takes each report's `Friction:` line (falling back to labelled `Concerns:` and blocked lines), buckets the lines by keyword and ranks the clusters by reports and agent-hours, plus `renderFrictionTop`, `renderFrictionMarkdown` and `frictionDeposit` for the day's owner inbox know-item. session-miner gains `titan-miner friction-daily [--since 24h] [--dry-run] [--archive-dir <dir>]`, which archives the raw rows, withdraws the earlier days' items and files today's through `titan-console`, and a daily 14:05 UTC systemd timer in `ops/systemd`.
- 207a81b: Lead the daily friction audit with friction measured from worker transcripts. session-analytics gains `transcriptSignals` (denials and tool errors through insights Q5's classifier, in-turn waits over five minutes, and repeated commands and test re-runs with no edit between), `followUpSignals` (insights Q6's brief-fix and correction classes), `readWorkerSessions` and `readSpawnerMessages`, and a per-agent agreement between log and self-report. Q5's `classifyError` and Q6's `classifyFollowUp` move into session-analytics, and the miner's insights now import them. `frictionDailyReport` now takes `{ reports, logs, window }` and returns `logs`, `reports` and `agreement`. Report lines that are scope notes, or `Concerns:` lines that name no friction cause, are set aside as non-friction, and `ci-wait` needs a wait word. The renderers move to `renderLogTop` and `renderReportTop`. `titan-miner friction-daily` gains `--profiles <dir>`.
- 49fa132: Full and `--full` index passes no longer hold the event loop for seconds (TP-4175). `refreshCorpus` and `indexTranscript` take a `yieldPoint`. With one, each transcript's delta is applied by the new `applyDeltaYielding` in bounded steps inside one transaction held open across the yields, so it still commits or rolls back whole. The rollup runs one session per transaction with a yield after each. Without a `yieldPoint`, nothing changes. session-analytics adds `staleEpisodeSessionsYielding`, which pages the backlog sweep by session and returns the same list as `staleEpisodeSessions`. active-work's full pass passes its `yieldPoint` to both. On a fixture of 500 transcripts, the longest synchronous chunk of a `--full` rebuild drops from 2380 ms to 141 ms.

### Patch Changes

- 5ba850e: `parseDenials` reads classifier refusals from session-read's `decodeClaudeToolLines` observations, joined to the refused call by call id, instead of its own transcript decoder. A refusal whose result carries no call id is no longer counted.
- 9b42150: Use the shared `isRecord`, `isObjectLike` and `errorCode` from `@titan-design/rpc-protocol/narrow` in place of local copies. Behaviour is unchanged.
- 37d60d1: Typed-lint burn-down: the SQL readers type their rows through `prepare<Params, Row>` and the JSON key and record reads narrow instead of asserting. A tool-result array with a null element no longer throws in the denial classifier. No other behaviour change.
- Updated dependencies [7492819]
- Updated dependencies [211db45]
- Updated dependencies [f896485]
- Updated dependencies [e8fbf15]
- Updated dependencies [c15f0dc]
- Updated dependencies [7a34209]
- Updated dependencies [f15a84e]
- Updated dependencies [c18be57]
- Updated dependencies [ed2be7e]
- Updated dependencies [5a67a0b]
- Updated dependencies [cfdfb64]
- Updated dependencies [ff6fb95]
- Updated dependencies [c58d555]
- Updated dependencies [6525ba7]
- Updated dependencies [44038c9]
- Updated dependencies [7d3b5fb]
- Updated dependencies [481f3e4]
- Updated dependencies [801f9c4]
- Updated dependencies [377cca9]
- Updated dependencies [f77d79d]
- Updated dependencies [5edd38d]
- Updated dependencies [9b42150]
- Updated dependencies [b672645]
- Updated dependencies [cd8a1ce]
- Updated dependencies [c1f9297]
- Updated dependencies [646f4d7]
- Updated dependencies [5f2b39f]
- Updated dependencies [52dc7f3]
- Updated dependencies [12afa80]
- Updated dependencies [32637bd]
- Updated dependencies [49fa132]
- Updated dependencies [852d2a9]
- Updated dependencies [d2cce6c]
- Updated dependencies [59b27e3]
- Updated dependencies [6bc98f3]
- Updated dependencies [d46cbce]
- Updated dependencies [ae64085]
- Updated dependencies [1bc6431]
- Updated dependencies [342c6ba]
- Updated dependencies [342c6ba]
- Updated dependencies [0100482]
- Updated dependencies [78ae7d9]
- Updated dependencies [7012bf0]
  - @titan-design/review-panel@0.9.0
  - @titan-design/agent-protocol@0.10.0
  - @titan-design/session-read@0.17.0
  - @titan-design/session-graph@0.19.0
  - @titan-design/store-sqlite@0.5.0
  - @titan-design/rpc-protocol@0.4.0

## 0.17.4

### Patch Changes

- 9914239: Expose the existing dated catalog and pricing arithmetic through the pure agent-protocol/pricing subpath and replace higher-tier implementations with compatibility exports, preserving model matching, TTL and inclusive token accounting.
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

## 0.17.3

### Patch Changes

- Updated dependencies [e7601ef]
  - @titan-design/review-panel@0.8.0

## 0.17.2

### Patch Changes

- Updated dependencies [27f8d12]
  - @titan-design/review-panel@0.7.0

## 0.17.1

### Patch Changes

- Updated dependencies [41fce70]
  - @titan-design/session-read@0.16.0
  - @titan-design/review-panel@0.6.2
  - @titan-design/session-graph@0.17.1

## 0.17.0

### Minor Changes

- 79754af: `taskActuals` takes a `prDiffs` cache keyed by PR ref and adds `prClass`, `touches` and `changedLines` from review-panel's `classifyPr` and `changedLineCount` over all of a task's merged PR files; a merged PR missing from the cache gives nulls and the `pr-diff-missing` flag. New exports `prFeaturesFor`, `listMergedPrRefs`, `parsePrRef` and the `PrDiff`/`PrFeatures` types (TP-2162 a).
- 91ea294: Price Haiku 5.5's long-prompt tier. `PriceRow` gains an optional `longPrompt`, `priceRequest` bills every component at the long rates once the prompt (input + cache read + cache write) is strictly above `abovePromptTokens`, and the `claude-haiku-5-5` row carries its 5x tier above 100K prompt tokens. `PRICE_TABLE_VERSION` is 4.
- 1c956dd: Add Q12 `insights data-quality`: one row per fault to clear before any analysis, each with a severity, its evidence and a suggested task title. It flags a graph whose newest request trails `--until` (or now) by more than `--max-lag` minutes (default 60), transcripts discovered but not indexed, an audit facet backlog, and unpriced models with requests. With `--assignments <file>` (CLI only) it also flags lines that fail `assignmentSchema`, outcomes outside `merged`, `done` and any `--known-outcome`, and agents with no session in the graph. session-analytics exports `DEFAULT_MERGED_OUTCOMES` and `DEFAULT_DONE_OUTCOMES`, the outcome words `costPerOutcome` counts by default.
- f03dea7: Add `seatGenerations`, which lists a seat's generations from handoff rows, completed teleports, spawns and exits, and `readHandoffs` for agent-chat's `agent_handoff` rows. Export `readAgentSessions`.
- 811e8ac: `costPerOutcome` buckets carry `requests` (window requests split over each agent's assignments like `costUsd`) and `requestsPerFinished` (requests over merged plus done, null at zero). The text renderer adds a `req/finished` column.
- 55cdd43: Add `compareWindows` with `REVIEW_FILL_COMPARISON` and `SUCCESSOR_REWORK_COMPARISON`: one guardrail report over a before and an after window, with null-safe after-minus-before deltas per row.
- 2467880: Add `renderReviewFillText`, `renderSuccessorReworkText` and `renderWindowComparisonText`: the review-fill and successor-rework guardrails and their before/after comparisons as plain-text tables, with nulls as `-` and the list-price caveat only where dollars appear.

### Patch Changes

- fe65aaa: Price `claude-haiku-5-5` at its list base rates (0.1 input, 0.01 cache read, 0.125 and 0.2 cache writes, 0.5 output per Mtok), from the Claude Code 2.1.296 bundled model catalog. Haiku 5.5 requests were reported as unpriced. Prompts over 100K tokens are still priced at base rates until the long-prompt tier lands. `PRICE_TABLE_VERSION` is now 3.
- 4ec603a: `taskActuals` reads peak context and context at first deliverable for every implementer session in one batched pass over `request` (first copies only) and `session_signal`, instead of two `request_cost` view reads per task.
- Updated dependencies [cd013d1]
- Updated dependencies [089ac2c]
- Updated dependencies [7b9baf5]
- Updated dependencies [f171698]
- Updated dependencies [30c7ab5]
- Updated dependencies [9abae48]
- Updated dependencies [cf7c870]
- Updated dependencies [b0a3f7b]
- Updated dependencies [ed7042a]
- Updated dependencies [a79cffd]
- Updated dependencies [eae2dc4]
- Updated dependencies [2503c0c]
- Updated dependencies [28df3a2]
- Updated dependencies [ca49f58]
- Updated dependencies [2ea3f8a]
- Updated dependencies [adfec4b]
- Updated dependencies [adfec4b]
- Updated dependencies [c2d805b]
- Updated dependencies [4ba57bf]
- Updated dependencies [7dbe2bb]
- Updated dependencies [ba8f25e]
- Updated dependencies [ba8f25e]
- Updated dependencies [29e51f1]
- Updated dependencies [4dc300d]
- Updated dependencies [ac8bf42]
- Updated dependencies [5f5dce9]
- Updated dependencies [7a47bb3]
- Updated dependencies [6b222d0]
  - @titan-design/review-panel@0.6.0
  - @titan-design/agent-protocol@0.8.0
  - @titan-design/session-graph@0.17.0
  - @titan-design/session-read@0.15.0

## 0.16.0

### Minor Changes

- cd01cfa: Add `scorecardJournalRows` and `readDispatchJournal`: the W41 scorecard rows read from events.db verdicts and seat `dispatch.jsonl` journals (first-pass FIX_FIRST share, mechanical first-blocker share, coordinator spawns for milestone tasks, cost per merged PR with a 0.8 `usd_est` coverage floor), each `not measured` when its source is absent or empty. Ported from agent-chat's `scripts/seat/scorecard`.

### Patch Changes

- de21f12: Regenerate the committed API surface snapshots so they match the current exports; no source change.

## 0.15.1

### Patch Changes

- 7b9335c: session-read keeps an agent-chat channel tag's `broadcast="true"` attribute as `Inbound.broadcast` (false for a direct message, null without a channel tag) and bumps `EXTRACT_VERSION` to 8, so `backfillFacets` re-extracts stored inbound rows. session-graph adds `inbound.broadcast` in migration 12 and writes it. session-analytics wake episodes read the flag for the `broadcast` sender kind, so a direct message a forked session copied is no longer a broadcast; msg_id fan-out remains the fallback for rows extracted before version 8.
- Updated dependencies [7b9335c]
  - @titan-design/session-read@0.14.0
  - @titan-design/session-graph@0.16.2

## 0.15.0

### Minor Changes

- f640f72: `taskActuals` rows carry `peakContext`, the largest main-thread context over the task's implementer sessions, and `contextAtFirstDeliverable`, the context of the first implementer request at or after the earliest `status_report` or `pr_create` signal (null when there is none).
- 3ecb1c7: Add `costPerOutcome`, `assignmentSchema`, `costPerOutcomeSchema` and `renderCostPerOutcomeText`: cost generic seat/agent assignment records against `request_cost` over a window and report what each merged and done outcome cost per seat, kind, initiative and value tag. An agent in several assignments is costed once, an agent with no name match joins by `session_origin.task_ids`, unmatched agents are listed rather than dropped, and seat sessions are reported apart in `seatCostUsd`.

### Patch Changes

- Updated dependencies [ea3d34c]
  - @titan-design/agent-protocol@0.7.0
  - @titan-design/session-graph@0.16.1
  - @titan-design/session-read@0.13.2

## 0.14.0

### Minor Changes

- 11df74d: `taskActuals` accepts optional `shepherdRuns` (the records `titan-factory shepherd stats --per-run --json` prints) and `shepherdSince`. When passed, each row gains `reviewRounds`, `stageMinutes`, `serviceWallHours` (first implementer request to the earliest merge) and `mergePath` (`shepherd`, `outside` when a merged PR has no run, else null), joined by task id and then by `repo#pr`. A row merged before `shepherdSince` gets null Shepherd facts.
- b924847: Add `successorReworkReport` and `successorReworkSchema`: per role, how many files a successor session re-reads in its first boot requests (default 30) that its same-named predecessor already read, from `file_read` signals only, with the cost of those boot requests counted once each. Overlapping same-name sessions are never paired, and `fileReadData` is false when the graph holds no `file_read` signal.

### Patch Changes

- Updated dependencies [662f42b]
  - @titan-design/session-read@0.13.1

## 0.13.3

### Patch Changes

- Updated dependencies [aeedb5d]
  - @titan-design/session-graph@0.16.0

## 0.13.2

### Patch Changes

- Updated dependencies [7c73654]
  - @titan-design/session-read@0.13.0
  - @titan-design/session-graph@0.15.1

## 0.13.1

### Patch Changes

- 3873ce6: Count each inbound once when a session is held in two transcripts: `humanTurnCount`, `inboundKinds` and episode inbounds now keep only the first copy (`INBOUND_COPY_RANK`, the inbound twin of `SIGNAL_COPY_RANK`).

## 0.13.0

### Minor Changes

- 587f2de: Add `seatContext`: per-seat context p50, p90 and max per call over a window, with auto and manual compactions counted from the seat's own sessions. The miner exposes it as `seat-context`, with optional `--p90-max` and `--auto-max` limits that fail the run.

### Patch Changes

- Updated dependencies [3d3cc58]
  - @titan-design/session-read@0.12.2

## 0.12.0

### Minor Changes

- be6e34c: Add the coordinator duty meter core. `mergeCopies` meters seat transcript lines into duty-classified, priced calls and turns, with copy dedupe, per-pool window starts, rebuilt triggers and outcomes, and the `TP1550_RULES` and `V3_RULES` rule sets. `dutyTable` totals them into the `titan.coord-duty/v1` duty table, and `seatOf` names a transcript's seat.

## 0.11.0

### Minor Changes

- 5c659a3: Add `taskActuals(minerDb, tasks, options)`: one row per done task with implementer and reviewer agent-hours (request gaps capped at 15 minutes, with the 5 and 60 minute values alongside), list-price cost, implementer session count and first and last request, linked PRs with merge time, and the flags `no-impl-session`, `weak-link`, `multi-task`, `reopened` and `unpriced`. Initiatives come from an allowlist option. A session's role comes from its spawn profile (`fable-implementer` and `fable-reviewer` included); a linked session that counts toward neither total is reported in `unmappedSessions` and raises `unmapped-role`.

### Patch Changes

- 3bf2ac3: Index transcripts mirrored from another host as children of the same session. session-read's `claudeTranscriptRoots` adds a root for each `<dir>/<account>/projects` named by `CLAUDE_TRANSCRIPT_MIRRORS` (`<host>=<dir>` entries), and `TranscriptRoot` and `DiscoveredTranscript` gain an optional `host`. When a session has facts in more than one transcript, session-graph's rollup recounts `turn_count`, `commit_count` and `push_count` without counting any copy twice. `purgeTranscript` on one copy keeps the shared session row, moves rows the other copy also holds to its lines, recounts the session and returns the ids it handed off, and the new `SIGNAL_COPY_RANK` export ranks the copies of a `session_signal` row. session-analytics episodes read each signal once.
- dcf8e04: Read task-actuals query rows through type guards instead of type assertions.
- Updated dependencies [3bf2ac3]
  - @titan-design/session-read@0.12.0
  - @titan-design/session-graph@0.15.0

## 0.10.0

### Minor Changes

- c10cfe0: `parseVerdict` now reads verdicts with session-read's `parseVerdictBlock` and matches heads exactly, so a short or prefix head no longer counts. `blockedFlowReport` gains `refusedVerdicts` (and an optional `unparsedVerdicts` input) for verdicts the merge gate would refuse; they stay out of `verdictToMerge` and `openHoldingMerge`.
- ae161ab: A scoped `staleEpisodeSessions` call and `readSessionContexts` no longer read `request_dedup`. They keep each request's earliest `(ts, transcript_id)` copy with a `NOT EXISTS` check over `idx_request_id`, so a call for a few sessions stops ranking every request in the graph. Results are unchanged. `staleEpisodeSessions` with no ids still reads the view.
- bf95d64: Add the agent-chat events.db readers `readVerdicts(db, window, seats)`, `readSpawns(db)` and `readLastPrompts(db, asOf)`, which take a connection the caller opened read-only. Each runs an exported SQL constant (`VERDICTS_SQL`, `SPAWNS_SQL`, `LAST_PROMPTS_SQL`), and the `verdicts`, `spawns` and `prompts` commands in `BLOCKED_FLOW_SOURCES` and `LIVENESS_SOURCES` are now `eventsDbCommand(sql)` over that same constant, so a printed re-read runs the reader's own query, with `.parameter set` lines for its epoch-millisecond parameters. The verdicts command now selects the reviewer (`actor`) and the window bounds, and the spawns command the `msg_id IS NOT NULL` filter and JSON guard it lacked. The prompts source no longer claims a `broker_started` skip that events.db cannot show: that skip comes from broker.log, so the `registrations` grep now includes `broker_started` and `stalePrompts` cites `registrations`. `EVENTS_TABLE_DDL` exports agent-chat's events table for test fixtures.

### Patch Changes

- ce6cfdc: Add a parity test that runs every context and gap band boundary and a split-less cache write through the `request_cost` view and through `contextBand`, `gapBand` and `priceRequest`, so the TypeScript and SQL copies cannot drift apart unnoticed. `bands.ts` and `price-request.ts` now name their SQL twin.
- a8f0d75: Correct the docs: the default rules classify `gh api PUT pulls/merge` as `merge`, and the cost report field is `unpricedModels`.
- 00c9a6f: Order coordinator episode signal ownership by timestamp, transcript id, then byte offset, so a merge or wrap signal on an exact-millisecond tie across resumed transcripts lands on the right turn. Bumps the coordinator-v1 heuristic version so stored episodes are recomputed.
- Updated dependencies [7345a13]
- Updated dependencies [f4b073d]
- Updated dependencies [d31b4fe]
- Updated dependencies [e4700f5]
- Updated dependencies [5b59475]
- Updated dependencies [a5cfd4c]
- Updated dependencies [f34ae27]
- Updated dependencies [f34ae27]
- Updated dependencies [495e6f8]
- Updated dependencies [74f9f51]
- Updated dependencies [a8faac4]
- Updated dependencies [1aed39d]
- Updated dependencies [1fd9652]
- Updated dependencies [deb35d0]
- Updated dependencies [295acf8]
- Updated dependencies [1f7de27]
- Updated dependencies [388d791]
- Updated dependencies [59ba612]
- Updated dependencies [ff6ff86]
- Updated dependencies [ff6ff86]
- Updated dependencies [c466784]
  - @titan-design/agent-protocol@0.6.0
  - @titan-design/session-graph@0.14.0
  - @titan-design/session-read@0.11.0
  - @titan-design/store-sqlite@0.4.0

## 0.9.0

### Minor Changes

- b8da03a: Export `staleEpisodeSessions(db, ids?)`: the sessions `writeEpisodes` would change, newest last request first. It chooses each session's heuristic through the same `readSessionContexts` and `classifySession` step as `writeEpisodes`, so a consumer no longer keeps its own copy of the session-fact query. The README and reference page now document `blockedFlowReport`, `livenessReport` and `reviewFillReport` and the parsers they rest on.

### Patch Changes

- Updated dependencies [6a2c0f8]
  - @titan-design/session-read@0.10.0
  - @titan-design/session-graph@0.13.2

## 0.8.0

### Minor Changes

- 218cbac: The session timeline prices 1h cache writes at the 1h rate. `TimelineTokens` gains `cacheWrite5m` and `cacheWrite1h` beside the `cacheWrite` total, filled from session-read's `cacheWriteSplit`, and each request is priced from the split. Before, every cache write was charged at the 5m rate, so a session with 1h writes read lower on the timeline than in `costReport`. A usage row with only the flat total counts as 5m and prices exactly as before, which is the rule `costReport` already uses.

### Patch Changes

- Updated dependencies [18e081a]
- Updated dependencies [ea96b66]
- Updated dependencies [218cbac]
- Updated dependencies [f886302]
- Updated dependencies [790f304]
- Updated dependencies [411b4f0]
- Updated dependencies [d10a591]
  - @titan-design/session-read@0.9.0
  - @titan-design/store-sqlite@0.3.3
  - @titan-design/session-graph@0.13.1
  - @titan-design/agent-protocol@0.5.0

## 0.7.0

### Minor Changes

- 212d8d1: Add `reviewFillReport` and `reviewFillSchema`: review verdicts per context band and reviewer model, with the changes-requested rate and the share of approvals a later changes-requested review contradicted.
- 144755d: Add the session timeline read model. `buildSessionTimeline(observations)` and `SessionTimelineAccumulator` fold session-read's normalized observations into turns, minute buckets with gaps of 10 minutes or more marked, a token and cost series with compaction marks, and tool, file, error and subagent breakdowns. `countAtOrBefore` answers how much had happened by a scrubbed time. `ToolFamily` is re-exported from session-read. The package now depends on `@titan-design/session-read` and `@titan-design/agent-protocol`.

### Patch Changes

- Updated dependencies [ed058da]
- Updated dependencies [c67ee7a]
- Updated dependencies [b7a44ca]
- Updated dependencies [3a4d4ed]
- Updated dependencies [30e1fdf]
  - @titan-design/session-graph@0.13.0
  - @titan-design/store-sqlite@0.3.2

## 0.6.0

### Minor Changes

- 73b8b32: `livenessReport` reads agent-chat's broker log and events rows and reports seats dark over 5 minutes, with and without a teleport, each with the routes that missed it. It also reports routes that missed a recipient: dropped (`delivered:false`), partial, or held and queued for later delivery, with broadcasts and tag sends skipped, unreported exits grouped by spawn profile, and agents whose last event is a permission prompt over 10 minutes old. Both read agent lifecycle: a gap where the agent exited cleanly (code 0, not inferred) without a teleport is a resume, not a dark seat, and a prompt from an agent that has since exited, retired or missed re-registering after a broker restart is not stale. Every finding cites its `broker.log` line or `events` row. New exports: `parseBrokerLog`, `routeMisses`, `routeFailureRows`, `countMisses`, `darkGaps`, `unreportedExitRows`, `stalePromptRows`, `livenessSchema`, `renderLivenessText`, `LIVENESS_SOURCES`, `dedupeDenials`.

  `blockedFlowReport` now counts a classifier denial once per `tool_use_id`, so a forked or resumed transcript in a `--transcript` directory no longer double-counts it.

  `titan-miner insights liveness` (Q8) runs it over `TITAN_MINER_BROKER_LOG` (default `~/.agent-chat/broker.log`) or `--broker-log`, and over the events table opened read-only.

### Patch Changes

- e96997d: Nit batch: Shepherd hold and verdict regression tests; session-analytics maps the `decider` profile to planner, orders wake pairs tied on cost by sender kind, picks the newest reviewer cohort by instant and reports its size as `requestsFromSessions`; session-miner insights read a zoneless timestamp as UTC.
  - @titan-design/session-graph@0.12.1

## 0.5.0

### Minor Changes

- c7fcdeb: `blockedFlowReport` reports, per repo, the minutes from a reviewer's first `Verdict: MERGE` at a PR's final head to its merge, with still-open PRs as censored ages and an optional split at a moment such as a merge-authority grant. It also lists open PRs holding MERGE at their current head, counts classifier denials by reason and by the action refused, and counts idle implementer slot-minutes by the seat journal's stated reason. New exports: `parseVerdict`, `mergeOutcomes`, `latencyStats`, `parseDenials`, `classifyDeniedAction`, `parseSeatJournal`, `idleSlotMinutes`, `blockedFlowSchema`, `renderBlockedFlowText`, `BLOCKED_FLOW_SOURCES`.

  `titan-miner insights blocked-flow` (Q7) runs it over agent-chat's events table (`TITAN_MINER_EVENTS_DB`), GitHub REST and the seat transcripts and journals given with `--transcript` and `--journal`. An insight's `answer` may now be async and receives the miner config.

- 59b6491: The cost report gains `handoffThreshold`: per role and model, the boot cost and fill (up to the first dispatch, send or file write), the mean fill growth per request and the cache-read price, all fitted from the requests and priced from `PRICE_TABLE`. It sweeps the handoff threshold K for the cheapest cost per request (boot / n + read price x mean fill), reports the extra cost at each configured K and a half-boot sensitivity row, gives each teleport's exit fill from broker log lines the caller passes as `brokerLogLines`, and compares fresh per-PR reviewers against one standing reviewer. The text renderer prints three new sections. New exports: `handoffThreshold`, `sweepK`, `costPerRequest`, `isBootAction`, `parseTeleportEvents`, `handoffThresholdSchema` and their types and defaults.
- a594543: `costReport` and `cacheTtlReport` take an optional `scope` (`sessionIds`, `agentPrefix`, `roles`) that narrows every request-keyed field; with no scope the reports are unchanged. `renderCostReportSections` renders chosen sections of the cost report (`COST_REPORT_SECTIONS`) under its header, with `LIST_PRICE_CAVEAT` and the footer last. New exports: `ReportScope`, `scopeFilter`, `COST_REPORT_SECTIONS`, `CostReportSection`, `renderCostReportSections`.

  `titan-miner insights <question>` runs the session-insights questions Q1 to Q4 (`spend-by-action`, `handoff-threshold`, `cache-ttl`, `wake-economics`) on the CLI, over MCP as `miner__insights__<question>`, and at `/rpc/insights.<question>`, each from one definition. Every question takes `--session`, `--agent-prefix`, `--role`, `--since` and `--until`, returns `{ question, caveat, filters, answer }` under `--json`, and prints its text renderer with the list-price caveat otherwise.

- c9f7712: `costReport` gains `byAction` (each role's cost by action class) and `mechanicalShare` (the cost of the mechanical classes over the window total, and per role), with `actionRules` and `mechanicalClasses` options. `readRequestToolCalls` maps each request to the tool calls it issued with their extracted heads and paths. The renderer prints both tables. The turn-action classifier is now exported, and its default rules match journal files on the basename and merge, retire, agent list and scorer commands only in the program position.
- 9821aa7: Add `cacheTtlReport` and its pure core `cacheTtlWhatIf`: what a 5-minute prompt-cache TTL would
  save against the 1h TTL. Each 1h cache write is repriced at the 5m rate, and every request gap of
  5 minutes or more (`REBUILD_GAP_BANDS`, from `gapBand`) is charged a rebuild of the cache it read
  at the 5m write rate. The result gives the net saving per role and per spawn profile, and
  `lossRoles` flags the roles whose rebuilds make 5m a loss. `renderCacheTtlText` prints it. When
  the graph has no `gap_ms`, the gap is derived from the session's previous request.
- 61c29c4: The cost report gains `wakeEpisodes`: the coordinator roles' wakes cut into episodes, each an
  arrival and the requests up to the next one, mid-loop `queued_command` deliveries included. Per
  wake cause it reports episodes, requests and cost per episode, and how many episodes took no
  action by the TP-501 action facet (`noActionClasses`, default read-investigate, text-only and
  other). The agent lifecycle notice is its own cause, `agent_lifecycle`. Each episode carries a
  sender kind (seat, agent, broadcast, broker, none), and `pairs` is the sender-by-receiver
  matrix. The text renderer lists the costliest causes per episode first. The `opus-coordinator`
  spawn profile now maps to the coordinator role, so those seats report as `worker:coordinator`
  instead of `worker:unknown`.
- f41ea9d: Add a pure turn-action classifier (`classifyRequest`, generic `DEFAULT_ACTION_RULES`, `DEFAULT_MECHANICAL_CLASSES`) in `turn-action.ts`.

### Patch Changes

- 4662a91: The default turn-action rules now read the `gh api` heads session-read emits: `gh api PUT pulls/merge` is `merge`, and `gh api GET commits/check-runs` and `gh api GET commits/status` are `pr-ci-check`. The old merge pattern expected a pull number in the head, which session-read no longer keeps. Any other `gh api` head stays `other`.
- 45c7ad5: A standing reviewer row with no same-model reviewers now takes requests per PR from the newest reviewer cohort (latest session ts) instead of the session-weighted pool, and `requestsFrom` names that model. Sessions with no request after boot no longer dilute a cohort's growth. `HandoffSession` gains `lastTs`.
- f3f843d: `commandHeads` keeps the signal a path operand carried. `gh api` gives the method and resource shape (`gh api PUT pulls/merge`), an interpreter gives its script's basename (`python3 score.py`), and a redirect or `tee` target keeps its last parent directory (`>a/2026-01-01.md`). `timeout N`, `nice`, `nohup` and `env` are looked through like `builtin` and `command`.

  `EXTRACT_VERSION` is now 5, so stored `command_heads` re-extract on the next backfill.

  The session-analytics journal-write rule now matches a redirect head with a parent directory, such as `>state/events.jsonl`.

- 9ce7e65: TP-629: map the bd-implementer, bd-implementer-lite, bd-reviewer and bd-planner spawn profiles to their roles, so their sessions no longer report as worker:unknown.
- e9cac19: Classify agent-chat and git coordination calls in the default turn-action rules: `agent ls|budget|worktrees`, `git worktree list`, and the `agent_list`, `chat_list` and `ListAgents` tools are budget-status; `git merge-tree` is pr-ci-check; `chat_ask`, `chat_inbox`, `chat_claim` and `chat_release` are message. A bare `gh api` stays other.
- Updated dependencies [394bfae]
- Updated dependencies [0a9d26c]
  - @titan-design/session-graph@0.12.0

## 0.4.1

### Patch Changes

- e91b20f: Price `claude-opus-5-5` and `claude-sonnet-5-5` from their own rows, and match a model prefix only at a model-id boundary so `claude-opus-5` no longer prices `claude-opus-5-5` and an unlisted `claude-opus-5-9` is unpriced. `PRICE_TABLE_VERSION` is 2.
- Updated dependencies [661244b]
  - @titan-design/session-graph@0.11.0

## 0.4.0

### Minor Changes

- 90128ff: Map the `planner` and `fable-coordinator` spawn profiles to roles: `planner` was already a
  `WorkerRole` value with no profile mapped to it, and `fable-coordinator` needed a new
  `coordinator` `WorkerRole` value. Both profiles previously fell through to `worker:unknown`.

### Patch Changes

- Updated dependencies [5c53f2e]
- Updated dependencies [c7d5b1a]
- Updated dependencies [26f97c0]
  - @titan-design/session-graph@0.10.0

## 0.3.1

### Patch Changes

- c3100bf: `readEpisodeInput` ranks request copies only for the request ids its session holds, instead of reading `request_dedup`, which ranks every request in the graph. The rows are the same; one session's input on a 120k-request graph drops from about 240 ms to under 10 ms.

## 0.3.0

### Minor Changes

- 5b4f9de: Add `start_transcript_id`/`end_transcript_id` to the `episode` table (migration 6, "episode transcript ids") and thread `transcript_id` through `session-analytics`'s episode input so a session resumed across two transcripts still segments in time order instead of falling back to byte offsets that reset with the new file.

### Patch Changes

- Updated dependencies [5b4f9de]
  - @titan-design/session-graph@0.9.0

## 0.2.0

### Minor Changes

- f1e7ff4: Add `costReport(db, { since, until, days, top })`, the standing cost report over a session graph, and `renderCostReportText`, which prints it as plain-text tables. The report reads the `request_cost` view on a read-only connection and never writes. It groups cost by token class, account, model, session class, role, initiative, context band and wake cause, crosses wake cause with gap band, and breaks out cold rebuilds, compactions, top sessions, unpriced models and coverage. AskUserQuestion answers count under `human`, with typed text and answers one level down, and mid-loop deliveries are split out of every wake cause. `costReportSchema` is the zod schema of the JSON shape, so zod is now a peer dependency. The package now depends on `@titan-design/session-graph` and `@titan-design/store-sqlite`.
- 11341e8: Add worker roles and provisional episode segmentation, heuristic version 1. `workerRole` maps a spawn profile to implementer, reviewer, researcher, planner or standing peer, and reclassifies a worker living 12 hours or more with 2 or more assignments as a standing peer. `buildEpisodes` is pure and carries two heuristics: `worker-v1` opens at the brief, at a channel message after a status report (clustered within 10 minutes) and after a 30 minute idle gap, recording first deliverable and first status report separately; `coordinator-v1` opens on idle gap, PR merge (one per 15 requests), spawn wave complete, wrap and context reset, with an 8-request minimum. `writeEpisodes(graph, sessionIds)` writes through session-graph's `replaceEpisodes`. The cost report gains `byEpisodeCount`, and `byRole` now reports `worker:<role>` instead of `worker:<profile>`.

### Patch Changes

- Updated dependencies [527b81e]
- Updated dependencies [da2f8d9]
  - @titan-design/session-graph@0.8.0

## 0.1.0

### Minor Changes

- fa81bfb: Create `@titan-design/session-analytics` (tier 2): the audit price table, per-request
  pricing, session classification and context/gap bands, as pure functions.

  `priceRequest` returns the five cost components, `costUsd` and `priced`, matching the model
  by longest prefix and then by the latest price row effective at the request timestamp. An
  unknown model returns `priced: false` and zero cost rather than a default rate.
  `classifySession` resolves a session's class from its origin row before its entrypoint, and
  splits human sessions into coordinator and adhoc.
