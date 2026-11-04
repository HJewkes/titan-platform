---
"@titan-design/factory": minor
---

Add the `deploy-pause-clear` owner op (TP-3939 S6). Under the deploy lock, the console tap removes the failure pause a rolled-back deploy left, and only while the pause file still names the record's `pausedAt` and `target`. A newer pause answers `moved` (with `currentPause`) and stays. A running deployer is refused `deploying` (409). The manual hold is never cleared; when one stands, the answer's `stillHeld` names it. No pause plus the ledger's `done` answers `already`; no pause and no `done` answers `gone`. The route gains the `pause-cleared` outcome (200, with `clearedPause` and `stillHeld`). `owner-op.preview` returns the pause as `/health` reads it, whether a deployer is running, and the manual hold. The authority table still denies the op to owner-remote until the `deploy-resume` row (TP-3939 S0) lands.
