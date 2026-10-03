---
"@titan-design/factory": patch
---

Shepherd's wake, fixer, cleanup and reviewer ports now read the agent-chat roster through one shared reader in the serve process. Concurrent callers share one in-flight `agent-chat agent ls --json`, and a known roster is reused for 12 s. A spawn, resume, message or retire invalidates the reader. A failed read is reported as unknown and is never cached, so the next caller reads again.
