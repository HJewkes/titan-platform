---
"@titan-design/session-analytics": minor
---

Add worker roles and provisional episode segmentation, heuristic version 1. `workerRole` maps a spawn profile to implementer, reviewer, researcher, planner or standing peer, and reclassifies a worker living 12 hours or more with 2 or more assignments as a standing peer. `buildEpisodes` is pure and carries two heuristics: `worker-v1` opens at the brief, at a channel message after a status report (clustered within 10 minutes) and after a 30 minute idle gap, recording first deliverable and first status report separately; `coordinator-v1` opens on idle gap, PR merge (one per 15 requests), spawn wave complete, wrap and context reset, with an 8-request minimum. `writeEpisodes(graph, sessionIds)` writes through session-graph's `replaceEpisodes`. The cost report gains `byEpisodeCount`, and `byRole` now reports `worker:<role>` instead of `worker:<profile>`.
