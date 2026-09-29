---
"@titan-design/factory": minor
---

Add the factory registry (`factory.land`, idempotent on repo#pr; `factory.status`; `factory.gates`, with no resolve command) served as `factory__land`, `factory__status` and `factory__gates`. Add `titan-factory serve [--port]`, and `titan-factory land <owner/repo#N> [--task slug/id]`, which hands the PR to a running server over loopback and otherwise drives it in-process to completion or a gate.
