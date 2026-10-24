---
"@titan-design/factory": minor
---

Add the `close-pr` owner op (TP-3939 S4). The console tap closes the PR only while GitHub shows it open at the head the owner confirmed, keeps its branch, then ends the PR's live Shepherd run. A PR open at another head answers `moved` and is not closed; a PR closed with no ledger row for the record answers `gone`; a replay after the ledger's `done` answers `already`; an earlier call that logged `started` and no `done` re-reads GitHub and finishes. The console-action route gains the `pr-closed` outcome (200, with `closedHead`), and the owner-ops ledger gains `read(actionId)`. The authority table still denies `close-pr` to owner-remote until the `pr-close` row (TP-3939 S0) lands.
