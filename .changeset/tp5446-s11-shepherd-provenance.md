---
"@titan-design/factory": patch
---

Shepherd records provenance where it files and registers (TP-5446 S11). Each reviewer follow-up it files passes `source: follow-up`, `from_pr` and `from_task`, plus the parent task's `class` when the parent has one. `shepherd register` adds the `revert` kind, which never carries a reviewed MERGE and must name the merged PR it reverts with `--reverts owner/repo#N`, stored in `shepherd_registration.reverts`. A registration from a terminal with no agent-chat name now records `owner` as its registrant, and an agent's later registration still replaces it. Shepherd now takes its carrying kinds from `@titan-design/authority` instead of its own copy.
