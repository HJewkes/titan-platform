---
"@titan-design/factory": patch
---

Shepherd's three npm readers share one `registryGet` helper that applies the registry timeout and the 404/non-ok rule. `npmVersionRegistry` no longer hangs on a stalled registry (TP-5944).
