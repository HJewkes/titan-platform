---
"@titan-design/factory": patch
---

A seat-driven fix no longer needs an owner gate answer to get going again. `shepherd register` on a pull request whose run ended stopped `not-mergeable` or on a `conflict`, with the pull request still open, starts a new run at the current head and reports `previousRunId` and `previousStop`. A live run, a merged run, and a run stopped for any other reason come back unchanged. A pending `ci-failed` gate is superseded once the pull request moves past the red head it asks about, by the serve sweep or `shepherd resync`, and the run lands the new head; the supersede is recorded once and replays identically.
