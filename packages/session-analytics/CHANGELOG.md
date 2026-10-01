# @titan-design/session-analytics

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
