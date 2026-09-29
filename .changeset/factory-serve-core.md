---
"@titan-design/factory": minor
---

Add a long-lived serve mode. `FactoryHost.adopt()` claims unfinished runs and keeps driving them. `startFactoryServer` and `serveFactoryUntilSignal` host the factory database under `@titan-design/daemon` on port 7410 with an empty tool prefix. The server adopts runs at start and sweeps every `leaseMs` for runs whose owner exited without releasing, and `/health` reports run counts by status and pending gates.
