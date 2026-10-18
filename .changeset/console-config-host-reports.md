---
"titan-console": patch
---

Add the `config.report` deposit and the `config.hosts` read. Another host's `titan config report` is taken only over a bearer from another machine, stored under the state dir and shown, never applied. The report schema is strict, so a report carrying a `revision` is refused. A report older than 25 hours shows as not reported.
