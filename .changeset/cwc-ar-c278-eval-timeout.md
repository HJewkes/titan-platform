---
"@titan-design/factory": patch
---

An autoresearch rung that times out or is aborted now kills its whole process group (SIGTERM, then SIGKILL after a grace period), so a runner forked by the eval script cannot outlive it and start billed sessions. Time before the runner prints `ar-work-started` on stderr (its load-gate wait) no longer counts against `timeoutMin`, up to a three-hour allowance.
