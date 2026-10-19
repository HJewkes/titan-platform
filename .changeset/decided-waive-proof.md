---
"@titan-design/agent-dispatch": minor
"@titan-design/factory": patch
---

TP-3637: a decided answer never waives a fix-proof. `ServiceAnswer` now carries the broker's `provenance` marker when agent-chat sets one. gateNotify refuses a `decided` answer on every gate, because it would resolve as owner-remote and the decider is not the owner. It also refuses a `waive-proof` answer unless it is `human-endorsed`, so an unmarked relay fails closed. A refused answer leaves the gate pending, settles the ask as `refused`, and writes no waiver row. The owner's own terminal answer still waives.
