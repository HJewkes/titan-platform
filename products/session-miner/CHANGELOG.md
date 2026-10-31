# @titan-design/session-miner

## 0.11.0

### Minor Changes

- 25fcc67: Move the return-contract report parser into session-analytics. `parseReport` now lives there, reads the `Head:` sha and the `CI:` paste (worst state first) as well as the status, PR, plan, PARKED line and proposed tasks, and accepts a sentence after the status word (`Status: DONE. Plan: ...`). session-analytics also exports `extractFriction`, `extractConcerns`, `lineCluster` and `clusterOf`. factory keeps only the `burndown-slices` reader. session-miner gains `titan-miner report intake --shadow [--since 24h] [--eval]`, which writes one row per worker report (status, PR, head, CI, concern classes, suggested actions), acts on nothing, and with `--eval` scores the suggested closeouts against what happened next in the event log.
- 3bc655b: Add the `route-outcomes` insight (Q15). It reports, per workflow-table version, prior, estimate band and tier, the routed spawns, clean first pass, review rounds and cost per merged PR, reading from `--since` onward; `--shepherd-runs` joins Shepherd's per-run stats.
- 207a81b: Add the daily friction audit. session-analytics gains `readWorkerReports`, which reads agent-chat's `Status:` report messages with each worker's last spawn, and `frictionDailyReport`, which takes each report's `Friction:` line (falling back to labelled `Concerns:` and blocked lines), buckets the lines by keyword and ranks the clusters by reports and agent-hours, plus `renderFrictionTop`, `renderFrictionMarkdown` and `frictionDeposit` for the day's owner inbox know-item. session-miner gains `titan-miner friction-daily [--since 24h] [--dry-run] [--archive-dir <dir>]`, which archives the raw rows, withdraws the earlier days' items and files today's through `titan-console`, and a daily 14:05 UTC systemd timer in `ops/systemd`.
- 207a81b: Lead the daily friction audit with friction measured from worker transcripts. session-analytics gains `transcriptSignals` (denials and tool errors through insights Q5's classifier, in-turn waits over five minutes, and repeated commands and test re-runs with no edit between), `followUpSignals` (insights Q6's brief-fix and correction classes), `readWorkerSessions` and `readSpawnerMessages`, and a per-agent agreement between log and self-report. Q5's `classifyError` and Q6's `classifyFollowUp` move into session-analytics, and the miner's insights now import them. `frictionDailyReport` now takes `{ reports, logs, window }` and returns `logs`, `reports` and `agreement`. Report lines that are scope notes, or `Concerns:` lines that name no friction cause, are set aside as non-friction, and `ci-wait` needs a wait word. The renderers move to `renderLogTop` and `renderReportTop`. `titan-miner friction-daily` gains `--profiles <dir>`.
- 5ae38eb: Add `titan-miner self-improve-daily`: the self-improve chunk classification stage as one resumable workflow run, with `mapItems` over the chunk files, one `claude-print` call per chunk on its family's model and output schema, memoization per chunk hash, and a run budget that reserves the next call's ceiling.

### Patch Changes

- d4ad311: Use the shared narrowing helpers from `@titan-design/rpc-protocol/narrow` in place of local copies. Behaviour is unchanged.
- 90f36b4: Add `parseClustererSnapshot`, which narrows a stored snapshot from `unknown`, refuses a wrong shape or version and keeps unknown keys. `zod` is now a peer dependency of cluster. session-miner's `drain.ingest` reads its stored snapshot through it, so a malformed row stops the run with a clear error.
- a770805: Row reads, JSON envelopes and the lock file in session-miner are now narrowed with zod schemas instead of type assertions; three assertions with no runtime schema stay baselined. No change to command output.
- 78ae7d9: Stop writing tool spans, context blocks and unchanged state echoes by default (TP-880).

  session-read: `ReadOptions` gains `toolSpans` and `contextBlocks` (default true), passed to `LineReader` as an optional `EmitPolicy`. A fact from an echo line (`ai-title`, `custom-title`, `agent-name`, `mode`, `permission-mode`, `cost-state`) carries `state: { key, value }`; `atis-latch`, `bridge-session` and `last-prompt` emit no fact. `EXTRACT_VERSION` is 9.

  session-graph: `IndexOptions` gains `indexToolSpans` and `contextBlocks` (default false); `refreshCorpus` forwards `contextBlocks` to `backfillFacets`. Migration 14 replaces `session_state` with `echo_state`, keyed per transcript, and an echo fact is stored only when its value changed. `turn.thinking_ms` now counts the gap from a tool result past a skipped echo.

  session-miner and active-work keep storing tool spans and context blocks; active-work does so on both its full and delta passes.

- Updated dependencies [581c26f]
- Updated dependencies [25fcc67]
- Updated dependencies [b458a20]
- Updated dependencies [83a5759]
- Updated dependencies [d666020]
- Updated dependencies [1ac0fa2]
- Updated dependencies [24f1577]
- Updated dependencies [5ba850e]
- Updated dependencies [2256a3b]
- Updated dependencies [f896485]
- Updated dependencies [e8fbf15]
- Updated dependencies [974b429]
- Updated dependencies [5f2d9ed]
- Updated dependencies [d3d9a04]
- Updated dependencies [123f2d0]
- Updated dependencies [7b53127]
- Updated dependencies [dcaebb9]
- Updated dependencies [24f1577]
- Updated dependencies [b3209e3]
- Updated dependencies [b3f677b]
- Updated dependencies [84d962e]
- Updated dependencies [6c2df6a]
- Updated dependencies [a5f2f40]
- Updated dependencies [2c20516]
- Updated dependencies [5993fba]
- Updated dependencies [5cd2a5a]
- Updated dependencies [cda1b03]
- Updated dependencies [7835f1b]
- Updated dependencies [f896485]
- Updated dependencies [b6ce883]
- Updated dependencies [b6ce883]
- Updated dependencies [820d4d2]
- Updated dependencies [42551ba]
- Updated dependencies [42b6a21]
- Updated dependencies [6554538]
- Updated dependencies [5a67a0b]
- Updated dependencies [cfdfb64]
- Updated dependencies [ff6fb95]
- Updated dependencies [423c9ce]
- Updated dependencies [c58d555]
- Updated dependencies [d279098]
- Updated dependencies [7813c1f]
- Updated dependencies [02ed42b]
- Updated dependencies [f996bb9]
- Updated dependencies [a2df0c0]
- Updated dependencies [a2da8ac]
- Updated dependencies [0b09ff1]
- Updated dependencies [6525ba7]
- Updated dependencies [9dd8d1c]
- Updated dependencies [207a81b]
- Updated dependencies [207a81b]
- Updated dependencies [f77d79d]
- Updated dependencies [5edd38d]
- Updated dependencies [9b42150]
- Updated dependencies [90f36b4]
- Updated dependencies [b672645]
- Updated dependencies [37d60d1]
- Updated dependencies [63ccb71]
- Updated dependencies [cd8a1ce]
- Updated dependencies [00fb3ee]
- Updated dependencies [c1f9297]
- Updated dependencies [5f2b39f]
- Updated dependencies [52dc7f3]
- Updated dependencies [869014a]
- Updated dependencies [d130bd8]
- Updated dependencies [2f306ce]
- Updated dependencies [181c229]
- Updated dependencies [49fa132]
- Updated dependencies [6d79a8b]
- Updated dependencies [59b27e3]
- Updated dependencies [db14121]
- Updated dependencies [5833044]
- Updated dependencies [36e0a48]
- Updated dependencies [147ff5d]
- Updated dependencies [1b0c46a]
- Updated dependencies [1bc6431]
- Updated dependencies [3157198]
- Updated dependencies [449504e]
- Updated dependencies [84114b3]
- Updated dependencies [78ae7d9]
- Updated dependencies [20c93ed]
- Updated dependencies [4a2495f]
- Updated dependencies [0229ba6]
- Updated dependencies [ee64f09]
- Updated dependencies [2165cec]
- Updated dependencies [50fd2a5]
  - @titan-design/github@0.12.0
  - @titan-design/session-analytics@0.18.0
  - @titan-design/owner-queue@0.6.0
  - @titan-design/daemon@0.9.0
  - @titan-design/workflow@0.14.0
  - @titan-design/session-read@0.17.0
  - @titan-design/session-graph@0.19.0
  - @titan-design/hitl@0.10.0
  - @titan-design/registry@0.6.0
  - @titan-design/retrieval@0.4.0
  - @titan-design/store-sqlite@0.5.0
  - @titan-design/embed@0.2.1
  - @titan-design/locator@0.2.2
  - @titan-design/memory@0.3.1
  - @titan-design/rpc-protocol@0.4.0
  - @titan-design/cluster@0.3.0
  - @titan-design/throughput@0.3.2

## 0.10.4

### Patch Changes

- Updated dependencies [9914239]
- Updated dependencies [9914239]
- Updated dependencies [9914239]
  - @titan-design/session-graph@0.18.0
  - @titan-design/session-read@0.16.1
  - @titan-design/session-analytics@0.17.4

## 0.10.3

### Patch Changes

- Updated dependencies [41fce70]
  - @titan-design/session-read@0.16.0
  - @titan-design/throughput@0.3.1
  - @titan-design/session-analytics@0.17.1
  - @titan-design/session-graph@0.17.1

## 0.10.2

### Patch Changes

- Updated dependencies [a67d654]
  - @titan-design/pm@0.4.0

## 0.10.1

### Patch Changes

- Updated dependencies [9b5d49f]
  - @titan-design/daemon@0.8.0

## 0.10.0

### Minor Changes

- fbbdb87: Add `titan-miner tool-gap-weekly`: run Q9 tool-gaps and Q10 tool-adoption over the last 7 days, file or note one active-work task per pattern id, pipe one digest notice to `--notify-command`, then keep the week's snapshot. Ships `ops/systemd/session-miner-tool-gaps.{service,timer}` for a weekly run.
- 2cf9598: Add `titan-miner throughput table` and `throughput backtest` over done task YAML from an initiative allowlist (TP-2155 a).
- 5c44e3d: Add Q0 `titan-miner insights prices`: the price table as data, the window's unpriced models, and with `--published <file>` (CLI only) every published model the table prices differently (`differs`, naming each field) or not at all (`missing`), resolved through `findPrice`. Without a published file `mismatches` is null, so an unchecked table never reads as clean.
- 1c956dd: Add Q12 `insights data-quality`: one row per fault to clear before any analysis, each with a severity, its evidence and a suggested task title. It flags a graph whose newest request trails `--until` (or now) by more than `--max-lag` minutes (default 60), transcripts discovered but not indexed, an audit facet backlog, and unpriced models with requests. With `--assignments <file>` (CLI only) it also flags lines that fail `assignmentSchema`, outcomes outside `merged`, `done` and any `--known-outcome`, and agents with no session in the graph. session-analytics exports `DEFAULT_MERGED_OUTCOMES` and `DEFAULT_DONE_OUTCOMES`, the outcome words `costPerOutcome` counts by default.
- 835bbb8: Add Q14 `titan-miner insights seat-generations --seat <name>`: each agent that held the seat's name in the window, in start order, with how it ended and its graph sessions, over session-analytics' `seatGenerations`. `sessionArgs` is a ready `--session` string of only the sessions the graph knows. It reads the broker log (`--broker-log`, CLI only) and the events table, and refuses the session filters.
- 41669c1: Add the citation contract for insight findings: `findingSchema` (a claim, at least one citation and a non-empty falsifier) and `verifyCitations`, plus `titan-miner insights verify-citations --findings <file>`. The command re-runs each cited question once per distinct question and args, checks each cited JSON pointer (numbers within a relative tolerance, 1 percent by default; anything else exactly), reports `ok`, `mismatch`, `missing-field`, `unknown-question` or `error` per citation, and exits non-zero on any that is not ok.
- ed21449: Ship the session-insights skill in `skills/session-insights/`: `SKILL.md` runs data quality and prices before any question, hands the JSON answers to a read-only analyst, and keeps only findings that pass `verify-citations`; `analyst-brief.md` states the citation contract with a synthetic example that parses as `findingSchema`.
- 7c821fb: Add Q13 `insights quality-guardrails`: review fill and successor rework for a window, and with `--before-since`/`--before-until` each one's before/after comparison (TP-508 e).
- 9183618: The session-insights skill checks file inputs for staleness against `--until`, denies the analyst Bash, network and agent-chat with a $2 and 150k-token cap, and scores each proposed lever on verdict-to-merge, open MERGE PRs and `requestsPerFinished`.
- e584a4f: The session-insights skill runs Q13 `quality-guardrails` in its question list and names it, with a before window, as every proposed lever's guardrail.

### Patch Changes

- d95eb32: `insights blocked-flow` logs each GitHub PR read as a gh-calls v1 line (`caller: "session-miner"`) in `~/.local/state/gh-calls/<day>.jsonl`, keeping 7 days, so a day's GitHub API use can be read per caller (TP-1172).
- d2dc37c: Add the throughput set selector that picks open tasks by id, parent or milestone for the coming `throughput forecast` command (TP-2157 a).
- dd57ba1: `titan-miner throughput pr-backfill` caches each merged PR's head sha and changed files (paths and line counts, no diff text) in `<state>/pr-diffs.json`, mode 0600, through `@titan-design/github`: cached refs cost no calls, a 404 is cached as missing, a capped file list is marked truncated, and the run stops at the rate floor with progress saved. `readPrDiffCache` returns the map `taskActuals` takes as `prDiffs` (TP-2162 c).
- 8054ee7: Add `titan-miner throughput review`, which loads the PR diff cache, and optionally Shepherd's per-run stats via `--shepherd-runs`, into `taskActuals`. It prints the review table keyed on review class x lead touch and the per-target ablation of the diff arm against the kind x size-band arm, with the model hash and cache coverage, in text and `--json` (TP-2162 d).
- Updated dependencies [0dd6186]
- Updated dependencies [6a0952d]
- Updated dependencies [448bcea]
- Updated dependencies [8c89092]
- Updated dependencies [6281b49]
- Updated dependencies [d357882]
- Updated dependencies [54b6d69]
- Updated dependencies [65287ec]
- Updated dependencies [3fafd2e]
- Updated dependencies [b6a1d02]
- Updated dependencies [491685f]
- Updated dependencies [79754af]
- Updated dependencies [228fd31]
- Updated dependencies [1476172]
- Updated dependencies [6881274]
- Updated dependencies [102a9df]
- Updated dependencies [be96d75]
- Updated dependencies [8f37474]
- Updated dependencies [82d8c0a]
- Updated dependencies [b0fb3e6]
- Updated dependencies [fe65aaa]
- Updated dependencies [28df3a2]
- Updated dependencies [91ea294]
- Updated dependencies [adfec4b]
- Updated dependencies [c2d805b]
- Updated dependencies [c278211]
- Updated dependencies [4ffd52a]
- Updated dependencies [ba8f25e]
- Updated dependencies [69f323c]
- Updated dependencies [027f0f2]
- Updated dependencies [4ec603a]
- Updated dependencies [608b103]
- Updated dependencies [8438a4e]
- Updated dependencies [216db04]
- Updated dependencies [8c25894]
- Updated dependencies [e6dafd1]
- Updated dependencies [77e2c4d]
- Updated dependencies [6eab4e8]
- Updated dependencies [1c956dd]
- Updated dependencies [f03dea7]
- Updated dependencies [811e8ac]
- Updated dependencies [55cdd43]
- Updated dependencies [2467880]
  - @titan-design/github@0.11.0
  - @titan-design/daemon@0.7.0
  - @titan-design/pm@0.3.0
  - @titan-design/registry@0.5.0
  - @titan-design/throughput@0.3.0
  - @titan-design/session-analytics@0.17.0
  - @titan-design/memory@0.3.0
  - @titan-design/session-graph@0.17.0
  - @titan-design/session-read@0.15.0

## 0.9.1

### Patch Changes

- Updated dependencies [61511e7]
  - @titan-design/github@0.10.0

## 0.9.0

### Minor Changes

- d58ce99: Add insights question Q5, `tool-errors`: error tool results and classifier denials per local day, by the self-improve extractor's error classes and by tool, with sessions and agents. Add Q6, `round-trips`: parent-to-child follow-ups by class and per-PR verdict rounds per local day from agent-chat's events. Add Q11, `probes`: each probe in a `--probes` JSON file, a named Q5 or Q6 measure, against its target per local day as HOLDING, REGRESSED or NO-DATA.

### Patch Changes

- Updated dependencies [cd830c1]
  - @titan-design/github@0.9.0

## 0.8.2

### Patch Changes

- Updated dependencies [de21f12]
- Updated dependencies [cd01cfa]
  - @titan-design/session-analytics@0.16.0

## 0.8.1

### Patch Changes

- Updated dependencies [7b9335c]
  - @titan-design/session-read@0.14.0
  - @titan-design/session-graph@0.16.2
  - @titan-design/session-analytics@0.15.1

## 0.8.0

### Minor Changes

- a1a3638: Add `titan-miner memory scan` and `titan-miner memory report`. They read every Claude Code auto-memory directory, then dedupe, group and propose a destination per group. The report is written as `report.md` and `decisions.yml`, mode 0600, and the envelope carries counts and paths only.

### Patch Changes

- a260d28: Add the pure core of the weekly tool-gap workflow: `diffWeeks` compares two weeks of Q9 `tool-gaps` and Q10 `tool-adoption`, `planTaskActions` plans at most one task add or note per pattern id (deduped by the `tool-gap:<patternId>` tag) for patterns above a calls and sessions threshold that the adoption registry does not already track, and `renderDigest` writes one owner notice listing new gaps, task actions, adoption results and removal candidates.

## 0.7.3

### Patch Changes

- ad09028: Name the build tasks TP-2315..2320 on their adoption-registry baselines, add `--task` to the shepherd status filters, and count `titan-gh` as one of Q9's CLIs.

## 0.7.2

### Patch Changes

- Updated dependencies [f640f72]
- Updated dependencies [3ecb1c7]
  - @titan-design/session-analytics@0.15.0
  - @titan-design/session-graph@0.16.1
  - @titan-design/session-read@0.13.2

## 0.7.1

### Patch Changes

- Updated dependencies [11df74d]
- Updated dependencies [662f42b]
- Updated dependencies [b924847]
  - @titan-design/session-analytics@0.14.0
  - @titan-design/session-read@0.13.1

## 0.7.0

### Minor Changes

- 89a7e88: The adoption registry holds unshipped `baseline` entries beside shipped ones and is seeded with the 15 ranked rows of the 2026-10-08 bash-to-tool mining. Q10 `tool-adoption` counts a baseline's old pipelines from the window start, never flags it, and marks it `baseline` in the text table. Rows gain `row`, `status` and `note`; `task`, `pr`, `shipped` and `daysSinceShip` are null for a baseline. With nothing shipped and no `--since`, the window starts four weeks back. A new form on the old head with no flags is no longer counted.

## 0.6.2

### Patch Changes

- Updated dependencies [aeedb5d]
  - @titan-design/session-graph@0.16.0
  - @titan-design/session-analytics@0.13.3

## 0.6.1

### Patch Changes

- Updated dependencies [7c73654]
  - @titan-design/session-read@0.13.0
  - @titan-design/session-analytics@0.13.2
  - @titan-design/session-graph@0.15.1

## 0.6.0

### Minor Changes

- 587f2de: Add `seatContext`: per-seat context p50, p90 and max per call over a window, with auto and manual compactions counted from the seat's own sessions. The miner exposes it as `seat-context`, with optional `--p90-max` and `--auto-max` limits that fail the run.

### Patch Changes

- Updated dependencies [579886b]
- Updated dependencies [587f2de]
- Updated dependencies [3d3cc58]
  - @titan-design/github@0.8.0
  - @titan-design/session-analytics@0.13.0
  - @titan-design/session-read@0.12.2

## 0.5.4

### Patch Changes

- Updated dependencies [be6e34c]
  - @titan-design/session-analytics@0.12.0

## 0.5.3

### Patch Changes

- Updated dependencies [df3e9c3]
  - @titan-design/memory@0.2.0

## 0.5.2

### Patch Changes

- Updated dependencies [3bf2ac3]
- Updated dependencies [c0701a9]
- Updated dependencies [91eea82]
- Updated dependencies [e4dd79b]
- Updated dependencies [845a0cf]
- Updated dependencies [5c659a3]
- Updated dependencies [dcf8e04]
  - @titan-design/session-read@0.12.0
  - @titan-design/session-graph@0.15.0
  - @titan-design/session-analytics@0.11.0
  - @titan-design/github@0.7.0

## 0.5.1

### Patch Changes

- Updated dependencies [948d6de]
- Updated dependencies [875eee0]
- Updated dependencies [1893149]
- Updated dependencies [718eda8]
- Updated dependencies [84bd62f]
  - @titan-design/daemon@0.6.0
  - @titan-design/registry@0.4.0
  - @titan-design/session-read@0.11.1

## 0.5.0

### Minor Changes

- 93a341b: Add `titan-miner graph-refresh`, a scheduled refresh of a graph another owner writes: it takes a non-blocking lock (exit 75 when held), runs the owner's incremental refresh, then runs a read-only `quick_check` and logs the newest session. Ship hourly systemd user units for it under `ops/systemd`.
- 87126ff: Add insights question Q10, `tool-adoption`: for each flag or verb in the new adoption registry, weekly uses of the new form against the Q9 patterns it replaces since ship, flagged `unadopted` or `unused` two weeks after ship. Export `ourPipelines`, which keeps unpiped pipelines too.
- deb35d0: Add insights question Q9, `tool-gaps`: Bash pipelines headed by our CLIs, grouped by normalised post-filter with a stable `patternId`, counts, distinct sessions and agents and output size, each marked NEW or EXISTS-UNUSED against the CLI's `--help`. Export `postFilters` and `patternId` for later questions.

### Patch Changes

- eeae364: Blocked-flow now reads PR states through the github package's port (`getPr`) instead of a raw `gh api` call; a PR GitHub cannot find is still reported as unknown.
- bf95d64: Read agent-chat's events.db through session-analytics' `readVerdicts`, `readSpawns` and `readLastPrompts` and delete the miner's copies of those queries. The miner still checks the file exists, naming `TITAN_MINER_EVENTS_DB` with a data error, and opens it read-only; liveness now opens it once for both reads. Test fixtures create the events table from `EVENTS_TABLE_DDL` instead of a copy of agent-chat's schema.
- a5cfd4c: Read the normalized tables through session-graph's readers instead of inline SQL. `session show` now counts a Codex conversation's tool calls in one query rather than one per turn; command output is unchanged.
- 2c08723: Read `MINER_VERSION` from package.json, so `--version`, the daemon's `/health` and the MCP server report the package version instead of a stale `0.1.0`.
- Updated dependencies [c10cfe0]
- Updated dependencies [20b2ae2]
- Updated dependencies [fa2fb83]
- Updated dependencies [f88ac00]
- Updated dependencies [f320219]
- Updated dependencies [490489b]
- Updated dependencies [944ef91]
- Updated dependencies [5facf32]
- Updated dependencies [7f4e467]
- Updated dependencies [501b7c2]
- Updated dependencies [b97a26d]
- Updated dependencies [116dd59]
- Updated dependencies [484fadc]
- Updated dependencies [45f05b1]
- Updated dependencies [5fe09ab]
- Updated dependencies [ae161ab]
- Updated dependencies [ce6cfdc]
- Updated dependencies [a8f0d75]
- Updated dependencies [00c9a6f]
- Updated dependencies [bf95d64]
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
- Updated dependencies [d4db9bc]
- Updated dependencies [ff6ff86]
- Updated dependencies [ff6ff86]
- Updated dependencies [f8b7be1]
- Updated dependencies [bf5cd2a]
- Updated dependencies [37c2689]
- Updated dependencies [3c5b114]
- Updated dependencies [c466784]
- Updated dependencies [d4ef157]
- Updated dependencies [d186dfb]
  - @titan-design/session-analytics@0.10.0
  - @titan-design/cluster@0.2.0
  - @titan-design/daemon@0.5.0
  - @titan-design/github@0.6.0
  - @titan-design/registry@0.3.3
  - @titan-design/retrieval@0.3.1
  - @titan-design/session-graph@0.14.0
  - @titan-design/session-read@0.11.0
  - @titan-design/store-sqlite@0.4.0
  - @titan-design/memory@0.1.4

## 0.4.3

### Patch Changes

- Updated dependencies [179706a]
- Updated dependencies [9891e0d]
- Updated dependencies [6a2c0f8]
- Updated dependencies [b8da03a]
  - @titan-design/daemon@0.4.1
  - @titan-design/github@0.5.1
  - @titan-design/session-read@0.10.0
  - @titan-design/session-analytics@0.9.0
  - @titan-design/session-graph@0.13.2

## 0.4.2

### Patch Changes

- 6479be9: Guard the miner's own tables on a read-only foreign `--graph`. `status` reports `templates: 0` there, and `drain ingest`, `drain templates` and every `playbook` command exit 65 with a message naming the foreign graph instead of failing on "no such table".
- Updated dependencies [18e081a]
- Updated dependencies [1b83b86]
- Updated dependencies [a20a6e3]
- Updated dependencies [c8ab11b]
- Updated dependencies [92e76c5]
- Updated dependencies [ea96b66]
- Updated dependencies [218cbac]
- Updated dependencies [218cbac]
- Updated dependencies [113cac1]
- Updated dependencies [f886302]
- Updated dependencies [fe76ae0]
- Updated dependencies [790f304]
- Updated dependencies [87e5857]
- Updated dependencies [0e67551]
- Updated dependencies [041125d]
- Updated dependencies [6385c70]
- Updated dependencies [f0db7a9]
- Updated dependencies [170ed76]
- Updated dependencies [13e505a]
- Updated dependencies [6b19eac]
- Updated dependencies [10a66c3]
- Updated dependencies [4ed86e8]
- Updated dependencies [d10a591]
  - @titan-design/session-read@0.9.0
  - @titan-design/cluster@0.1.3
  - @titan-design/daemon@0.4.0
  - @titan-design/github@0.5.0
  - @titan-design/store-sqlite@0.3.3
  - @titan-design/session-analytics@0.8.0
  - @titan-design/session-graph@0.13.1
  - @titan-design/memory@0.1.3

## 0.4.1

### Patch Changes

- c67ee7a: Open the session graph with `normalized: true`, so search and the Codex path keep their `normalized_*` tables after session-graph migration 9.
- Updated dependencies [b62813c]
- Updated dependencies [212d8d1]
- Updated dependencies [ed058da]
- Updated dependencies [c67ee7a]
- Updated dependencies [b7a44ca]
- Updated dependencies [144755d]
- Updated dependencies [3a4d4ed]
- Updated dependencies [620a34f]
- Updated dependencies [f390fc0]
- Updated dependencies [30e1fdf]
  - @titan-design/daemon@0.3.3
  - @titan-design/session-analytics@0.7.0
  - @titan-design/session-graph@0.13.0
  - @titan-design/store-sqlite@0.3.2
  - @titan-design/github@0.4.0

## 0.4.0

### Minor Changes

- 73b8b32: `livenessReport` reads agent-chat's broker log and events rows and reports seats dark over 5 minutes, with and without a teleport, each with the routes that missed it. It also reports routes that missed a recipient: dropped (`delivered:false`), partial, or held and queued for later delivery, with broadcasts and tag sends skipped, unreported exits grouped by spawn profile, and agents whose last event is a permission prompt over 10 minutes old. Both read agent lifecycle: a gap where the agent exited cleanly (code 0, not inferred) without a teleport is a resume, not a dark seat, and a prompt from an agent that has since exited, retired or missed re-registering after a broker restart is not stale. Every finding cites its `broker.log` line or `events` row. New exports: `parseBrokerLog`, `routeMisses`, `routeFailureRows`, `countMisses`, `darkGaps`, `unreportedExitRows`, `stalePromptRows`, `livenessSchema`, `renderLivenessText`, `LIVENESS_SOURCES`, `dedupeDenials`.

  `blockedFlowReport` now counts a classifier denial once per `tool_use_id`, so a forked or resumed transcript in a `--transcript` directory no longer double-counts it.

  `titan-miner insights liveness` (Q8) runs it over `TITAN_MINER_BROKER_LOG` (default `~/.agent-chat/broker.log`) or `--broker-log`, and over the events table opened read-only.

### Patch Changes

- e96997d: Nit batch: Shepherd hold and verdict regression tests; session-analytics maps the `decider` profile to planner, orders wake pairs tied on cost by sender kind, picks the newest reviewer cohort by instant and reports its size as `requestsFromSessions`; session-miner insights read a zoneless timestamp as UTC.
- Updated dependencies [73b8b32]
- Updated dependencies [e96997d]
- Updated dependencies [1873696]
  - @titan-design/session-analytics@0.6.0
  - @titan-design/github@0.3.0
  - @titan-design/session-graph@0.12.1
  - @titan-design/session-read@0.8.1

## 0.3.0

### Minor Changes

- c7fcdeb: `blockedFlowReport` reports, per repo, the minutes from a reviewer's first `Verdict: MERGE` at a PR's final head to its merge, with still-open PRs as censored ages and an optional split at a moment such as a merge-authority grant. It also lists open PRs holding MERGE at their current head, counts classifier denials by reason and by the action refused, and counts idle implementer slot-minutes by the seat journal's stated reason. New exports: `parseVerdict`, `mergeOutcomes`, `latencyStats`, `parseDenials`, `classifyDeniedAction`, `parseSeatJournal`, `idleSlotMinutes`, `blockedFlowSchema`, `renderBlockedFlowText`, `BLOCKED_FLOW_SOURCES`.

  `titan-miner insights blocked-flow` (Q7) runs it over agent-chat's events table (`TITAN_MINER_EVENTS_DB`), GitHub REST and the seat transcripts and journals given with `--transcript` and `--journal`. An insight's `answer` may now be async and receives the miner config.

- a594543: `costReport` and `cacheTtlReport` take an optional `scope` (`sessionIds`, `agentPrefix`, `roles`) that narrows every request-keyed field; with no scope the reports are unchanged. `renderCostReportSections` renders chosen sections of the cost report (`COST_REPORT_SECTIONS`) under its header, with `LIST_PRICE_CAVEAT` and the footer last. New exports: `ReportScope`, `scopeFilter`, `COST_REPORT_SECTIONS`, `CostReportSection`, `renderCostReportSections`.

  `titan-miner insights <question>` runs the session-insights questions Q1 to Q4 (`spend-by-action`, `handoff-threshold`, `cache-ttl`, `wake-economics`) on the CLI, over MCP as `miner__insights__<question>`, and at `/rpc/insights.<question>`, each from one definition. Every question takes `--session`, `--agent-prefix`, `--role`, `--since` and `--until`, returns `{ question, caveat, filters, answer }` under `--json`, and prints its text renderer with the list-price caveat otherwise.

### Patch Changes

- 394bfae: `reconcilePrices` upserts a price table into a graph without deleting other rows: it adds missing models, updates changed rates and stamps the table version. `titan-miner` calls it with session-analytics' `PRICE_TABLE` whenever it opens the graph, so `titan-miner refresh` fixes a graph that still prices `claude-opus-5-5` at Opus 5 rates.
- 0a9d26c: `openSessionGraph(path, { readonly: true })` opens a graph another process owns without migrating it, and throws `SessionGraphNotMigratedError` when it lacks a session-graph migration. The session miner reads such a graph with `--graph <file>` (`TITAN_MINER_GRAPH`), and its own migrations move from 1000-1002 to 2000-2002 so they no longer collide with active-work's band at 1001. A miner database migrated at the old numbers re-applies the new ones idempotently.
- Updated dependencies [c7fcdeb]
- Updated dependencies [679866f]
- Updated dependencies [4662a91]
- Updated dependencies [83e6c69]
- Updated dependencies [ccbdde0]
- Updated dependencies [394bfae]
- Updated dependencies [59b6491]
- Updated dependencies [a594543]
- Updated dependencies [0a9d26c]
- Updated dependencies [1712421]
- Updated dependencies [45c7ad5]
- Updated dependencies [c9f7712]
- Updated dependencies [9821aa7]
- Updated dependencies [61c29c4]
- Updated dependencies [88bf9f7]
- Updated dependencies [c583709]
- Updated dependencies [f41ea9d]
- Updated dependencies [06ffd8c]
- Updated dependencies [f3f843d]
- Updated dependencies [9ce7e65]
- Updated dependencies [e9cac19]
  - @titan-design/session-analytics@0.5.0
  - @titan-design/github@0.2.0
  - @titan-design/session-graph@0.12.0
  - @titan-design/registry@0.3.2
  - @titan-design/session-read@0.8.0
  - @titan-design/daemon@0.3.2

## 0.2.13

### Patch Changes

- Updated dependencies [17b952e]
- Updated dependencies [661244b]
- Updated dependencies [661244b]
- Updated dependencies [0bf3f20]
  - @titan-design/daemon@0.3.1
  - @titan-design/session-graph@0.11.0
  - @titan-design/session-read@0.7.0

## 0.2.12

### Patch Changes

- Updated dependencies [5c53f2e]
- Updated dependencies [c7d5b1a]
- Updated dependencies [26f97c0]
- Updated dependencies [15eaffa]
- Updated dependencies [2983591]
- Updated dependencies [b1e1c70]
- Updated dependencies [d019c72]
- Updated dependencies [c7d5b1a]
- Updated dependencies [d0ce38a]
  - @titan-design/session-graph@0.10.0
  - @titan-design/session-read@0.6.0

## 0.2.11

### Patch Changes

- Updated dependencies [dede06c]
  - @titan-design/daemon@0.3.0
  - @titan-design/session-graph@0.9.1
  - @titan-design/session-read@0.5.1
  - @titan-design/registry@0.3.1

## 0.2.10

### Patch Changes

- Updated dependencies [5b4f9de]
  - @titan-design/session-graph@0.9.0

## 0.2.9

### Patch Changes

- Updated dependencies [527b81e]
- Updated dependencies [da2f8d9]
  - @titan-design/session-graph@0.8.0

## 0.2.8

### Patch Changes

- Updated dependencies [0877916]
  - @titan-design/session-graph@0.7.0

## 0.2.7

### Patch Changes

- Updated dependencies [825b8b2]
- Updated dependencies [1035eb1]
- Updated dependencies [1e41479]
- Updated dependencies [79a855d]
- Updated dependencies [1a47098]
- Updated dependencies [38903dd]
- Updated dependencies [283d7e1]
- Updated dependencies [1035eb1]
- Updated dependencies [cb3b7e2]
- Updated dependencies [e3128f0]
- Updated dependencies [f2c70e0]
- Updated dependencies [a49eb2d]
  - @titan-design/store-sqlite@0.3.1
  - @titan-design/session-graph@0.6.0
  - @titan-design/session-read@0.5.0
  - @titan-design/registry@0.3.0
  - @titan-design/daemon@0.2.0

## 0.2.6

### Patch Changes

- Updated dependencies [e204012]
- Updated dependencies [3fea2d3]
- Updated dependencies [3e6a4af]
- Updated dependencies [18e3cf0]
- Updated dependencies [3fea2d3]
- Updated dependencies [e204012]
  - @titan-design/store-sqlite@0.3.0
  - @titan-design/embed@0.2.0
  - @titan-design/retrieval@0.3.0
  - @titan-design/daemon@0.1.4
  - @titan-design/session-graph@0.5.0
  - @titan-design/memory@0.1.2

## 0.2.5

### Patch Changes

- Updated dependencies [4ce40d1]
- Updated dependencies [1334f34]
  - @titan-design/registry@0.2.0
  - @titan-design/session-read@0.4.0
  - @titan-design/daemon@0.1.3
  - @titan-design/session-graph@0.4.1

## 0.2.4

### Patch Changes

- Updated dependencies [11b94a2]
- Updated dependencies [81b60ee]
- Updated dependencies [3bde552]
  - @titan-design/session-read@0.3.0
  - @titan-design/session-graph@0.4.0
  - @titan-design/store-sqlite@0.2.1
  - @titan-design/cluster@0.1.2
  - @titan-design/locator@0.2.1

## 0.2.3

### Patch Changes

- Updated dependencies [8153dd8]
- Updated dependencies [49360c2]
- Updated dependencies [8153dd8]
- Updated dependencies [0bdae32]
  - @titan-design/retrieval@0.2.0
  - @titan-design/cluster@0.1.1
  - @titan-design/store-sqlite@0.2.0
  - @titan-design/locator@0.2.0
  - @titan-design/session-graph@0.3.2
  - @titan-design/memory@0.1.1
  - @titan-design/session-read@0.2.1

## 0.2.2

### Patch Changes

- Updated dependencies [aac3473]
- Updated dependencies [87ae1ee]
  - @titan-design/session-graph@0.3.0
  - @titan-design/daemon@0.1.1

## 0.2.1

### Patch Changes

- Updated dependencies [fc7b58e]
  - @titan-design/session-read@0.2.0
  - @titan-design/session-graph@0.2.0

## 0.2.0

### Minor Changes

- 354538a: Wire `@titan-design/memory` in as a `playbook` command family (add, recall, reflect,
  status) on the existing registry, so it lands on the CLI, MCP, and HTTP at once. Provenance
  comes from the miner's own session refs and byte offsets, and `playbook reflect` builds a
  session diary deterministically from the subgraph with outcome labels derived from merged
  pull requests, task status, and clustered error signatures. The playbook stays strictly
  downstream of the index.

## 0.1.0

### Minor Changes

- 0ba860b: First product: `titan-miner` CLI, daemon, and MCP server composing registry, daemon,
  store-sqlite, locator, cluster, session-read, session-graph, and retrieval. Commands:
  refresh, status, search (FTS + graph expansion with read-back excerpts), session list/show,
  drain ingest/templates, serve, mcp.

### Patch Changes

- Updated dependencies [744fb7c]
- Updated dependencies [c9a2dd2]
- Updated dependencies [fbf473b]
- Updated dependencies [48eace6]
- Updated dependencies [6cea9aa]
- Updated dependencies [fdb3339]
- Updated dependencies [d33d861]
- Updated dependencies [aa5f694]
  - @titan-design/daemon@0.1.0
  - @titan-design/embed@0.1.0
  - @titan-design/locator@0.1.0
  - @titan-design/cluster@0.1.0
  - @titan-design/registry@0.1.0
  - @titan-design/retrieval@0.1.0
  - @titan-design/session-graph@0.1.0
  - @titan-design/session-read@0.1.0
  - @titan-design/store-sqlite@0.1.0
