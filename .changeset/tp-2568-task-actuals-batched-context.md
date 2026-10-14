---
"@titan-design/session-analytics": patch
---

`taskActuals` reads peak context and context at first deliverable for every implementer session in one batched pass over `request` (first copies only) and `session_signal`, instead of two `request_cost` view reads per task.
