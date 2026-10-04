# @titan-design/session-miner

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
