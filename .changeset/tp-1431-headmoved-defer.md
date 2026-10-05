---
"@titan-design/factory": patch
---

Shepherd no longer reads an unreadable PR as "head not moved" when waking a live implementer: a failed PR read defers the wake one poll, and the next readable read decides whether to message the agent.
