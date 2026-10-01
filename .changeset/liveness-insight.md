---
"@titan-design/session-analytics": minor
"@titan-design/session-miner": minor
---

`livenessReport` reads agent-chat's broker log and events rows and reports seats dark over 5 minutes, with and without a teleport, each with the routes that missed it. It also reports routes that missed a recipient: dropped (`delivered:false`), partial, or held and queued for later delivery, with broadcasts and tag sends skipped, unreported exits grouped by spawn profile, and agents whose last event is a permission prompt over 10 minutes old. Both read agent lifecycle: a gap where the agent exited cleanly (code 0, not inferred) without a teleport is a resume, not a dark seat, and a prompt from an agent that has since exited, retired or missed re-registering after a broker restart is not stale. Every finding cites its `broker.log` line or `events` row. New exports: `parseBrokerLog`, `routeMisses`, `routeFailureRows`, `countMisses`, `darkGaps`, `unreportedExitRows`, `stalePromptRows`, `livenessSchema`, `renderLivenessText`, `LIVENESS_SOURCES`, `dedupeDenials`.

`blockedFlowReport` now counts a classifier denial once per `tool_use_id`, so a forked or resumed transcript in a `--transcript` directory no longer double-counts it.

`titan-miner insights liveness` (Q8) runs it over `TITAN_MINER_BROKER_LOG` (default `~/.agent-chat/broker.log`) or `--broker-log`, and over the events table opened read-only.
