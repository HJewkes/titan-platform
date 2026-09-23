# @titan-design/session-analytics

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
